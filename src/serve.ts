import { type ChildProcess, execFile, execFileSync, spawn } from 'node:child_process'
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http'
import { delimiter, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { type LitestreamOptions, describeReplica, generateConfig, missingCredentials } from './config.js'
import { type ServicePaths, canonicalDbPath, databaseId, packageVersion, servicePaths } from './paths.js'
import { isServing } from './rpc.js'
import {
  type Keep,
  type RestoreCheck,
  type SnapshotConfig,
  type SnapshotStatus,
  checkRestore,
  listSnapshots,
  loadSnapshotConfig,
  snapshotDue,
  snapshotFolder,
  snapshotProblems,
  takeSnapshot,
} from './snapshot.js'

const execFileAsync = promisify(execFile)

export type DatabaseSpec = Omit<LitestreamOptions, 'name' | 'configDir' | 'envFile' | 'logFile'>

export interface Health {
  ok: boolean
  problems: string[]
  checkedAt: string
  localTxid?: number
  remoteTxid?: number
  newestChangeAt?: string
}

export interface DatabaseStatus {
  dbPath: string
  replica: string
  state: 'running' | 'backoff' | 'stopped'
  pid: number | null
  startedAt: string | null
  restarts: number
  lastError: { at: string; message: string } | null
  health: Health | null
  // For litestream commands run by hand, such as restore -config.
  configPath: string
  /** Null while snapshots are off for this machine. */
  snapshot: SnapshotStatus | null
}

export type SnapshotsSummary =
  | { state: 'off' }
  | { state: 'on'; destination: string; keep: Keep; restoreCheckDays: number }
  | { state: 'invalid'; error: string }

export interface ServiceStatus {
  version: string
  pid: number
  startedAt: string
  home: string
  ok: boolean
  snapshots: SnapshotsSummary
  dbs: DatabaseStatus[]
}

const HEALTH_INTERVAL_MS = Number(process.env.PURECONTEXT_LITESTREAM_HEALTH_MS ?? 5 * 60_000)
const STALE_MS = Number(process.env.PURECONTEXT_LITESTREAM_STALE_MS ?? 5 * 60_000)
const SETTLE_MS = Number(process.env.PURECONTEXT_LITESTREAM_SETTLE_MS ?? 60_000)
const IDLE_EXIT_MS = 30_000
const STABLE_RUN_MS = 5 * 60_000
const CRASH_WINDOW_MS = 15 * 60_000
const SOCKET_CHECK_MS = 5_000
const LOG_CAP_BYTES = 1_000_000
const MAX_BODY_BYTES = 64 * 1024
const SNAPSHOT_PASS_MS = Number(process.env.PURECONTEXT_BACKUP_SNAPSHOT_MS ?? 5 * 60_000)
// Startup resumes every replicator at once; the first pass waits for that.
const SNAPSHOT_FIRST_MS = Number(process.env.PURECONTEXT_BACKUP_SNAPSHOT_FIRST_MS ?? 2 * 60_000)
const DAY_MS = 24 * 60 * 60_000
const RESTORE_RETRY_MS = 60 * 60_000

const log = (msg: string) => console.error(`[${new Date().toISOString()}] ${msg}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const firstLine = (err: unknown) => String(err instanceof Error ? err.message : err).split('\n')[0]

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function terminate(pid: number, graceMs: number): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline) {
    if (!alive(pid)) return
    await sleep(100)
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {}
}

function resolveBinary(): string {
  if (process.env.LITESTREAM_BIN) return process.env.LITESTREAM_BIN
  // A client launched from a GUI app may carry a PATH without Homebrew.
  const dirs = [...(process.env.PATH ?? '').split(delimiter), '/opt/homebrew/bin', '/usr/local/bin']
  for (const dir of dirs) {
    if (dir && existsSync(join(dir, 'litestream'))) return join(dir, 'litestream')
  }
  return 'litestream'
}

// The config path in a ps line may contain spaces, so try each prefix of what
// follows -config until one names a readable file.
function configFromArgs(args: string): string | null {
  const at = args.indexOf(' -config ')
  if (at === -1) return null
  const words = args.slice(at + ' -config '.length).split(' ')
  for (let n = words.length; n > 0; n--) {
    try {
      return readFileSync(words.slice(0, n).join(' '), 'utf8')
    } catch {}
  }
  return null
}

// A replica keeps a year of change files; its listing passes the 1 MiB
// execFile default within weeks of steady writes.
const LISTING_BUFFER = 256 * 1024 * 1024

async function foreignReplicators(dbPath: string, own: Set<number>): Promise<number[]> {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,args='], { maxBuffer: LISTING_BUFFER })
  const found: number[] = []
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/)
    if (!m) continue
    const pid = Number(m[1])
    const args = m[2]
    if (own.has(pid) || !/litestream\S*\s+replicate\b/.test(args)) continue
    if (args.split(/\s+/).includes(dbPath)) {
      found.push(pid)
      continue
    }
    const config = configFromArgs(args)
    if (!config) continue
    const listed = [...config.matchAll(/^\s*- path:\s*["']?(\S.*?)["']?\s*$/gm)].map((x) => x[1])
    if (listed.some((p) => isAbsolute(p) && canonicalDbPath(p) === dbPath)) found.push(pid)
  }
  return found
}

class Replicator {
  child: ChildProcess | null = null
  state: DatabaseStatus['state'] = 'stopped'
  startedAt: string | null = null
  restarts = 0
  lastError: DatabaseStatus['lastError'] = null
  health: Health | null = null
  snapshotError: SnapshotStatus['lastError'] = null
  restoreCheck: RestoreCheck | null = null
  readonly configPath: string
  private readonly logPath: string
  private logBytes = 0
  private failures = 0
  private exits: number[] = []
  private stopping = false
  private retry: NodeJS.Timeout | null = null

  constructor(
    public spec: DatabaseSpec,
    paths: ServicePaths,
    private readonly bin: string,
    private readonly own: () => Set<number>,
  ) {
    const id = databaseId(spec.dbPath)
    this.configPath = join(paths.dbDir, `${id}.yml`)
    this.logPath = join(paths.dbDir, `${id}.log`)
    try {
      this.logBytes = statSync(this.logPath).size
    } catch {}
  }

  write(line: string): void {
    const entry = `[${new Date().toISOString()}] ${line}\n`
    if (this.logBytes > LOG_CAP_BYTES) {
      try {
        renameSync(this.logPath, `${this.logPath}.1`)
      } catch {}
      this.logBytes = 0
    }
    try {
      appendFileSync(this.logPath, entry, { mode: 0o600 })
      this.logBytes += Buffer.byteLength(entry)
    } catch {}
  }

  private noteError(message: string): void {
    this.lastError = { at: new Date().toISOString(), message }
  }

  // Never rejects: a start that fails goes to backoff and is retried, so no
  // caller (a registration, the resume, a retry) can leave it stuck.
  async start(): Promise<void> {
    this.stopping = false
    try {
      await this.launch()
    } catch (err) {
      this.noteError(firstLine(err))
      this.failures++
      this.backoff(`replicator did not start: ${firstLine(err)}`)
    }
  }

  private async launch(): Promise<void> {
    writeFileSync(this.configPath, generateConfig([this.spec]), { mode: 0o600 })

    // One owner per database: a second replicator on the same file corrupts
    // its local state, so any other one (an older in-process sidecar) yields.
    // When the scan fails, no replicator starts: two on one database is
    // worse than a delayed start.
    let foreign: number[]
    try {
      foreign = await foreignReplicators(this.spec.dbPath, this.own())
    } catch (err) {
      throw new Error(`cannot list processes to check for another replicator: ${firstLine(err)}`)
    }
    if (this.stopping) return
    for (const pid of foreign) {
      log(`stopping another replicator on ${this.spec.dbPath} (pid ${pid})`)
      this.write(`stopped another replicator on this database (pid ${pid})`)
      await terminate(pid, 3000)
    }
    if (this.stopping) return

    const child = spawn(this.bin, ['replicate', '-config', this.configPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    this.child = child
    this.state = 'running'
    this.startedAt = new Date().toISOString()
    this.write(`replicator started (pid ${child.pid}) → ${describeReplica(this.spec)}`)

    let pending = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      pending += chunk
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        this.write(line)
        if (/level=(ERROR|WARN)/.test(line)) this.noteError(line)
      }
    })
    child.on('error', (err) => {
      this.noteError(`cannot run ${this.bin}: ${err.message}`)
      this.exited(child, null)
    })
    child.on('exit', (code) => this.exited(child, code))
  }

  private exited(child: ChildProcess, code: number | null): void {
    if (this.child !== child) return
    this.child = null
    if (this.stopping) {
      this.state = 'stopped'
      return
    }
    const ran = Date.now() - Date.parse(this.startedAt ?? '')
    this.failures = ran > STABLE_RUN_MS ? 1 : this.failures + 1
    this.restarts++
    this.exits = [...this.exits.filter((t) => Date.now() - t < CRASH_WINDOW_MS), Date.now()]
    this.backoff(`replicator exited (code ${code})`)
  }

  private backoff(why: string): void {
    if (this.stopping) {
      this.state = 'stopped'
      return
    }
    const delay = Math.min(60_000, 1000 * 2 ** Math.max(0, this.failures - 1))
    this.state = 'backoff'
    this.write(`${why}; restarting in ${delay / 1000}s`)
    if (this.retry) clearTimeout(this.retry)
    this.retry = setTimeout(() => {
      this.retry = null
      void this.start()
    }, delay)
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    const child = this.child
    if (child?.pid !== undefined && child.exitCode === null) {
      await terminate(child.pid, 5000)
    }
    this.child = null
    this.state = 'stopped'
  }

  async checkHealth(): Promise<void> {
    const problems: string[] = []
    const health: Health = { ok: true, problems, checkedAt: new Date().toISOString() }
    // Every restart resets the settle period, so a replicator that dies within
    // a minute would never be judged on change files; count its exits instead.
    const recentExits = this.exits.filter((t) => Date.now() - t < CRASH_WINDOW_MS).length
    if (recentExits >= 2) {
      const why = this.lastError ? `; last error: ${this.lastError.message}` : ''
      problems.push(`replicator exited ${recentExits} times in ${CRASH_WINDOW_MS / 60_000} min${why}`)
    }
    if (this.state !== 'running') {
      const why = this.lastError ? `: ${this.lastError.message}` : ''
      problems.push(`replicator is ${this.state}${why}`)
    } else {
      const { dbPath } = this.spec
      const config = ['-config', this.configPath]
      try {
        const { stdout } = await execFileAsync(this.bin, ['status', '-json', ...config], {
          timeout: 30_000,
          maxBuffer: LISTING_BUFFER,
        })
        const row = JSON.parse(stdout).find((r: { database: string }) => r.database === dbPath)
        // Without the local position, "behind" cannot be computed, and a
        // replica that stopped receiving changes would pass as current.
        if (row) health.localTxid = Number.parseInt(row.local_txid, 16)
        else problems.push('litestream status has no row for this database, so replica lag cannot be measured')
      } catch (err) {
        problems.push(`cannot read local status: ${firstLine(err)}`)
      }
      try {
        const { stdout } = await execFileAsync(this.bin, ['ltx', '-level', 'all', '-json', ...config, dbPath], {
          timeout: 60_000,
          maxBuffer: LISTING_BUFFER,
        })
        const files: { level: number; max_txid: string; timestamp: string }[] = JSON.parse(stdout) ?? []
        const changes = files.filter((f) => f.level < 9)
        if (files.length > 0) {
          health.remoteTxid = Math.max(...files.map((f) => Number.parseInt(f.max_txid, 16)))
        }
        const settled = Date.now() - Date.parse(this.startedAt ?? '') > SETTLE_MS
        if (changes.length === 0) {
          if (settled) problems.push('the replica has no change files, so only snapshots are landing')
        } else {
          health.newestChangeAt = changes
            .map((f) => f.timestamp)
            .sort()
            .at(-1)
          const behind = (health.localTxid ?? 0) - (health.remoteTxid ?? 0)
          const age = Date.now() - Date.parse(health.newestChangeAt ?? '')
          if (behind > 0 && age > STALE_MS) {
            problems.push(
              `the replica is ${behind} transactions behind, and its last change landed ${Math.round(age / 60_000)} min ago`,
            )
          }
        }
      } catch (err) {
        problems.push(`cannot list the replica: ${firstLine(err)}`)
      }
      try {
        const foreign = await foreignReplicators(dbPath, this.own())
        for (const pid of foreign) {
          problems.push(`another replicator (pid ${pid}) was running on this database; stopped it`)
          this.write(`stopped another replicator on this database (pid ${pid})`)
          await terminate(pid, 3000)
        }
      } catch {}
    }
    health.ok = problems.length === 0
    this.health = health
  }

  restoreDue(days: number): boolean {
    if (days <= 0 || this.state !== 'running') return false
    // A replicator that just started has not finished its first sync.
    if (Date.now() - Date.parse(this.startedAt ?? '') < SETTLE_MS) return false
    if (!this.restoreCheck) return true
    const wait = this.restoreCheck.ok ? days * DAY_MS : RESTORE_RETRY_MS
    return Date.now() - Date.parse(this.restoreCheck.at) >= wait
  }

  describe(config: SnapshotConfig, serviceStartMs: number): DatabaseStatus {
    let snapshot: SnapshotStatus | null = null
    if (config.state === 'on') {
      const folder = snapshotFolder(config.settings.destination, this.spec.dbPath)
      const files = listSnapshots(folder)
      snapshot = {
        folder,
        newest: files.at(-1) ?? null,
        kept: files.length,
        lastError: this.snapshotError,
        restoreCheck: this.restoreCheck,
        problems: snapshotProblems(folder, this.snapshotError, this.restoreCheck, serviceStartMs),
      }
    }
    return {
      dbPath: this.spec.dbPath,
      replica: describeReplica(this.spec),
      state: this.state,
      pid: this.child?.pid ?? null,
      startedAt: this.startedAt,
      restarts: this.restarts,
      lastError: this.lastError,
      health: this.health,
      configPath: this.configPath,
      snapshot,
    }
  }

  removeFiles(): void {
    for (const file of [this.configPath, this.logPath, `${this.logPath}.1`]) {
      try {
        unlinkSync(file)
      } catch {}
    }
  }
}

function readLockPid(lockPath: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(lockPath, 'utf8'), 10)
    return Number.isNaN(pid) ? null : pid
  } catch {
    return null
  }
}

function isServiceProcess(pid: number): boolean {
  if (!alive(pid)) return false
  try {
    const args = execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' })
    return /litestream|backup/.test(args) && /\bserve\b/.test(args)
  } catch {
    return true
  }
}

// The lock decides which of several racing `serve` processes owns the socket.
// A stale lock is moved aside by rename, which only one racer can win; the
// winner checks it moved the stale file and not a lock just taken by another.
function acquireLock(lockPath: string): boolean {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600)
      writeSync(fd, String(process.pid))
      closeSync(fd)
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    const holder = readLockPid(lockPath)
    if (holder === null) {
      let age = 0
      try {
        age = Date.now() - statSync(lockPath).mtimeMs
      } catch {
        continue
      }
      if (age < 10_000) return false
    } else if (isServiceProcess(holder)) {
      return false
    }
    const aside = `${lockPath}.stale-${process.pid}`
    try {
      renameSync(lockPath, aside)
    } catch {
      continue
    }
    if (readLockPid(aside) !== holder) {
      try {
        renameSync(aside, lockPath)
      } catch {}
      return false
    }
    try {
      unlinkSync(aside)
    } catch {}
  }
  return false
}

function canonicalSpec(spec: DatabaseSpec): string {
  const entries = Object.entries(spec).filter(([, v]) => v !== undefined)
  return JSON.stringify(Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b))))
}

function sameTarget(a: DatabaseSpec, b: DatabaseSpec): boolean {
  return describeReplica(a) === describeReplica(b) && (a.endpoint ?? '') === (b.endpoint ?? '')
}

function validateSpec(body: unknown): DatabaseSpec {
  if (!body || typeof body !== 'object') throw new Error('expected a JSON object')
  const spec = body as DatabaseSpec
  if (typeof spec.dbPath !== 'string' || !isAbsolute(spec.dbPath)) throw new Error('dbPath must be an absolute path')
  if (typeof spec.replicaPath !== 'string' || !spec.replicaPath) throw new Error('replicaPath is required')
  if (spec.replicaType !== undefined && spec.replicaType !== 's3' && spec.replicaType !== 'file') {
    throw new Error('replicaType must be "s3" or "file"')
  }
  if (spec.replicaType === 'file' && !isAbsolute(spec.replicaPath)) {
    throw new Error('a file replicaPath must be an absolute path')
  }
  // The service's own environment is not the client's, so credentials must
  // arrive in the registration.
  const missing = missingCredentials({
    ...spec,
    bucket: spec.bucket ?? '',
    endpoint: spec.endpoint ?? '',
    accessKeyId: spec.accessKeyId ?? '',
    secretAccessKey: spec.secretAccessKey ?? '',
  })
  if (missing.length > 0) throw new Error(`missing: ${missing.join(', ')}`)
  generateConfig([spec])
  // The service drops registrations whose file is gone, so one registered
  // before its database exists would be dropped at the next check.
  if (!existsSync(spec.dbPath))
    throw new Error(`${spec.dbPath} does not exist; create the database before registering it`)
  return { ...spec, dbPath: canonicalDbPath(spec.dbPath) }
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      data += chunk
      if (data.length > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch {
        reject(new Error('request body is not JSON'))
      }
    })
    req.on('error', reject)
  })
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

export async function serve(paths: ServicePaths = servicePaths()): Promise<void> {
  mkdirSync(paths.home, { recursive: true, mode: 0o700 })
  mkdirSync(paths.dbDir, { recursive: true, mode: 0o700 })

  if (await isServing(paths.socket)) {
    log('service already running; exiting')
    return
  }
  if (!acquireLock(paths.lock)) {
    log('another service holds the lock; exiting')
    return
  }

  const version = packageVersion()
  const startedAt = new Date().toISOString()
  const bin = resolveBinary()
  const replicators = new Map<string, Replicator>()
  const own = () => new Set([...replicators.values()].flatMap((r) => (r.child?.pid ? [r.child.pid] : [])))

  let registry: Record<string, DatabaseSpec> = {}
  try {
    registry = JSON.parse(readFileSync(paths.registry, 'utf8')).dbs ?? {}
  } catch {}
  const saveRegistry = () => {
    const tmp = `${paths.registry}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify({ version: 1, dbs: registry }, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, paths.registry)
  }

  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn)
    queue = next.catch(() => {})
    return next
  }

  let idleTimer: NodeJS.Timeout | null = null
  let healthTimer: NodeJS.Timeout | null = null
  let socketTimer: NodeJS.Timeout | null = null
  let snapshotTimer: NodeJS.Timeout | null = null
  let shuttingDown = false
  let snapshotting = false

  // Restore checks run days apart, so their results outlive a restart.
  let restoreChecks: Record<string, RestoreCheck> = {}
  try {
    restoreChecks = JSON.parse(readFileSync(paths.snapshotState, 'utf8')).restoreChecks ?? {}
  } catch {}
  const saveRestoreChecks = () => {
    const tmp = `${paths.snapshotState}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify({ version: 1, restoreChecks }, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, paths.snapshotState)
  }
  const replicatorFor = (spec: DatabaseSpec) => {
    const r = new Replicator(spec, paths, bin, own)
    r.restoreCheck = restoreChecks[spec.dbPath] ?? null
    return r
  }

  const status = (): ServiceStatus => {
    const config = loadSnapshotConfig()
    const dbs = [...replicators.values()].map((r) => r.describe(config, Date.parse(startedAt)))
    const snapshots: SnapshotsSummary = config.state === 'on' ? { state: 'on', ...config.settings } : config
    return {
      version,
      pid: process.pid,
      startedAt,
      home: paths.home,
      // A database not yet checked has proved nothing; it shows as health
      // null ("unchecked"), and only a passed check counts as ok.
      ok:
        snapshots.state !== 'invalid' &&
        dbs.every((d) => d.state === 'running' && d.health?.ok === true && (d.snapshot?.problems.length ?? 0) === 0),
      snapshots,
      dbs,
    }
  }

  // One database at a time, outside the registration queue: a copy takes
  // seconds, and registrations must not wait on it.
  const snapshotPass = async () => {
    if (snapshotting || shuttingDown) return
    const config = loadSnapshotConfig()
    if (config.state !== 'on') return
    snapshotting = true
    try {
      for (const r of [...replicators.values()]) {
        if (shuttingDown) break
        const { dbPath } = r.spec
        if (snapshotDue(snapshotFolder(config.settings.destination, dbPath))) {
          try {
            const file = await takeSnapshot(dbPath, config.settings, paths.workDir)
            r.snapshotError = null
            r.write(`snapshot saved: ${file.path} (${file.bytes} bytes)`)
          } catch (err) {
            r.snapshotError = { at: new Date().toISOString(), message: firstLine(err) }
            r.write(`snapshot failed: ${firstLine(err)}`)
            log(`snapshot of ${dbPath} failed: ${firstLine(err)}`)
          }
        }
        if (!shuttingDown && r.restoreDue(config.settings.restoreCheckDays)) {
          r.restoreCheck = await checkRestore(bin, r.configPath, dbPath, paths.workDir)
          restoreChecks[dbPath] = r.restoreCheck
          saveRestoreChecks()
          r.write(`restore check ${r.restoreCheck.ok ? 'passed' : 'failed'}: ${r.restoreCheck.detail}`)
        }
      }
    } finally {
      snapshotting = false
    }
  }

  const shutdown = async (why: string) => {
    if (shuttingDown) return
    shuttingDown = true
    log(`shutting down: ${why}`)
    if (healthTimer) clearInterval(healthTimer)
    if (socketTimer) clearInterval(socketTimer)
    if (snapshotTimer) clearInterval(snapshotTimer)
    if (idleTimer) clearTimeout(idleTimer)
    server.close()
    // A registration already in the queue finishes first, so the replicator
    // it starts is stopped below rather than orphaned by the exit.
    await serial(async () => {})
    await Promise.all([...replicators.values()].map((r) => r.stop()))
    try {
      unlinkSync(paths.socket)
    } catch {}
    if (readLockPid(paths.lock) === process.pid) {
      try {
        unlinkSync(paths.lock)
      } catch {}
    }
    process.exit(0)
  }

  // The decision runs in the queue, after every registration that arrived
  // before it, so a registration racing the last unregister is never stopped
  // by a shutdown it beat. Registrations queued after it are refused (503) and
  // the client retries against the next service.
  const shutdownIfIdle = (why: string) =>
    serial(async () => {
      if (replicators.size === 0) void shutdown(why)
    })

  const armIdleExit = () => {
    if (replicators.size > 0 || idleTimer) return
    idleTimer = setTimeout(() => {
      idleTimer = null
      void shutdownIfIdle('no databases registered')
    }, IDLE_EXIT_MS)
  }

  // A registered database whose file is gone (a deleted clone) is dropped, so
  // it cannot keep the service alive and its status failing forever.
  const pruneMissing = async () => {
    let changed = false
    for (const dbPath of Object.keys(registry)) {
      if (existsSync(dbPath)) continue
      const r = replicators.get(dbPath) ?? replicatorFor(registry[dbPath])
      await r.stop()
      r.removeFiles()
      replicators.delete(dbPath)
      delete registry[dbPath]
      changed = true
      log(`dropped ${dbPath}: the database file no longer exists`)
    }
    if (changed) saveRegistry()
  }

  const register = (spec: DatabaseSpec) =>
    serial(async () => {
      if (shuttingDown) return { status: 503, body: { error: 'the service is shutting down; retry' } }
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = null
      await pruneMissing()
      const existing = replicators.get(spec.dbPath)
      if (!existing) {
        // Two databases writing one replica overwrite each other's history,
        // as when a copied clone registers its own database to the same path.
        const sharing = Object.values(registry).find((s) => s.dbPath !== spec.dbPath && sameTarget(s, spec))
        if (sharing) {
          return {
            status: 409,
            body: {
              error: `${describeReplica(spec)} already receives ${sharing.dbPath}; give ${spec.dbPath} its own replicaPath, or unregister ${sharing.dbPath} first`,
            },
          }
        }
        registry[spec.dbPath] = spec
        saveRegistry()
        const r = replicatorFor(spec)
        replicators.set(spec.dbPath, r)
        await r.start()
        log(`registered ${spec.dbPath} → ${describeReplica(spec)}`)
        return { status: 200, body: { status: 'started', dbPath: spec.dbPath, replica: describeReplica(spec) } }
      }
      if (!sameTarget(existing.spec, spec)) {
        return {
          status: 409,
          body: {
            error: `${spec.dbPath} is already replicated to ${describeReplica(existing.spec)}; unregister it before replicating it to ${describeReplica(spec)}`,
          },
        }
      }
      if (canonicalSpec(existing.spec) === canonicalSpec(spec)) {
        return { status: 200, body: { status: 'unchanged', dbPath: spec.dbPath, replica: describeReplica(spec) } }
      }
      registry[spec.dbPath] = spec
      saveRegistry()
      await existing.stop()
      existing.spec = spec
      await existing.start()
      log(`updated settings for ${spec.dbPath}`)
      return { status: 200, body: { status: 'updated', dbPath: spec.dbPath, replica: describeReplica(spec) } }
    })

  const unregister = (dbPath: string) =>
    serial(async () => {
      const r = replicators.get(dbPath)
      if (!r) return { status: 200, body: { status: 'unknown', dbPath } }
      await r.stop()
      r.removeFiles()
      replicators.delete(dbPath)
      delete registry[dbPath]
      saveRegistry()
      log(`unregistered ${dbPath}`)
      return { status: 200, body: { status: 'removed', dbPath } }
    })

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://service')
      if (req.method === 'GET' && url.pathname === '/status') {
        if (url.searchParams.get('refresh')) {
          await serial(pruneMissing)
          armIdleExit()
          await Promise.all([...replicators.values()].map((r) => r.checkHealth()))
        }
        return send(res, 200, status())
      }
      if (req.method === 'POST' && url.pathname === '/register') {
        const result = await register(validateSpec(await readBody(req)))
        return send(res, result.status, result.body)
      }
      if (req.method === 'POST' && url.pathname === '/unregister') {
        const body = (await readBody(req)) as { dbPath?: unknown }
        if (typeof body.dbPath !== 'string') return send(res, 400, { error: 'dbPath is required' })
        const result = await unregister(canonicalDbPath(body.dbPath))
        send(res, result.status, result.body)
        void shutdownIfIdle('last database unregistered')
        return
      }
      if (req.method === 'POST' && url.pathname === '/stop') {
        send(res, 200, { status: 'stopping' })
        void shutdown('stop requested')
        return
      }
      send(res, 404, { error: `no route for ${req.method} ${url.pathname}` })
    } catch (err) {
      send(res, 400, { error: firstLine(err) })
    }
  })

  // Three racers can each believe they took the lock: a racer restoring a lock
  // it moved by mistake can overwrite a third's. The file's contents are the
  // one thing all of them agree on, so whoever it does not name backs out
  // before touching the socket another may already serve.
  if (readLockPid(paths.lock) !== process.pid) {
    log('lost the lock to another service; exiting')
    return
  }
  try {
    unlinkSync(paths.socket)
  } catch {}
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(paths.socket, () => {
      server.off('error', reject)
      resolve()
    })
  })
  if (readLockPid(paths.lock) !== process.pid) {
    log('lost the lock to another service; exiting')
    server.close()
    return
  }
  log(`backup service ${version} listening on ${paths.socket} (pid ${process.pid}, binary ${bin})`)

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  // Clients can register while this runs, so it shares their queue, and a
  // database one of them already started is not started twice.
  await serial(async () => {
    await pruneMissing()
    for (const spec of Object.values(registry)) {
      if (replicators.has(spec.dbPath)) continue
      const r = replicatorFor(spec)
      replicators.set(spec.dbPath, r)
      await r.start()
    }
  })
  armIdleExit()

  // A racer that lost the lock late may already have unlinked our socket, and
  // a client that finds no socket gets bounced by our lock; listen again.
  socketTimer = setInterval(() => {
    if (shuttingDown || existsSync(paths.socket) || readLockPid(paths.lock) !== process.pid) return
    log('socket file is gone; listening again')
    server.closeAllConnections()
    server.close(() => {
      // A racer may create the path first; a listen error with no listener would
      // kill the service and orphan its replicators. The next tick retries.
      const failed = (err: Error) => log(`re-listen failed: ${err.message}`)
      server.once('error', failed)
      server.listen(paths.socket, () => server.off('error', failed))
    })
  }, SOCKET_CHECK_MS)

  const runSnapshots = () => snapshotPass().catch((err) => log(`snapshot pass failed: ${firstLine(err)}`))
  setTimeout(() => {
    if (shuttingDown) return
    void runSnapshots()
    snapshotTimer = setInterval(runSnapshots, SNAPSHOT_PASS_MS)
  }, SNAPSHOT_FIRST_MS).unref()

  healthTimer = setInterval(async () => {
    await serial(pruneMissing).catch((err) => log(`cannot prune missing databases: ${firstLine(err)}`))
    armIdleExit()
    for (const r of replicators.values()) {
      r.checkHealth().catch((err) => log(`health check failed for ${r.spec.dbPath}: ${firstLine(err)}`))
    }
  }, HEALTH_INTERVAL_MS)
}
