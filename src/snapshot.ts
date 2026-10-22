import { execFile } from 'node:child_process'
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, hostname } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { createGzip } from 'node:zlib'
import { databaseId } from './paths.js'

const execFileAsync = promisify(execFile)

export interface Keep {
  daily: number
  weekly: number
  monthly: number
}

export interface SnapshotSettings {
  destination: string
  keep: Keep
  /** Days between restores of the replica, compared against the live database; 0 turns them off. */
  restoreCheckDays: number
}

/** What the machine's config file says: snapshots off, on, or misconfigured. */
export type SnapshotConfig =
  | { state: 'off' }
  | { state: 'on'; settings: SnapshotSettings }
  | { state: 'invalid'; error: string }

export interface SnapshotFile {
  at: string
  path: string
  bytes: number
}

export interface RestoreCheck {
  at: string
  ok: boolean
  detail: string
}

export interface SnapshotStatus {
  folder: string
  newest: SnapshotFile | null
  kept: number
  lastError: { at: string; message: string } | null
  restoreCheck: RestoreCheck | null
  problems: string[]
}

export const DEFAULT_KEEP: Keep = { daily: 7, weekly: 4, monthly: 6 }
const DEFAULT_RESTORE_CHECK_DAYS = 7
// A machine asleep overnight skips a day; two missed days is a problem.
const STALE_SNAPSHOT_MS = 36 * 60 * 60_000
// The restore is compared with the live database read a moment later, so a
// healthy replica is within a few writes of it; losing a tenth is not that.
const RESTORE_ROW_FLOOR = 0.9
const PARTIAL_MAX_AGE_MS = 60 * 60_000

export function configPath(): string {
  return process.env.PURECONTEXT_BACKUP_CONFIG ?? join(homedir(), '.config', 'purecontext', 'backup.json')
}

const count = (value: unknown, key: string): number => {
  if (value === undefined) return DEFAULT_KEEP[key as keyof Keep]
  if (!Number.isInteger(value) || (value as number) < 0)
    throw new Error(`keep.${key} must be a whole number of 0 or more`)
  return value as number
}

// Read on every pass, so an edit takes effect without restarting the service.
export function loadSnapshotConfig(path = configPath()): SnapshotConfig {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { state: 'off' }
  }
  try {
    const snapshots = JSON.parse(raw).snapshots
    if (snapshots === undefined) return { state: 'off' }
    if (typeof snapshots?.destination !== 'string' || !isAbsolute(snapshots.destination)) {
      throw new Error('snapshots.destination must be an absolute path')
    }
    const keep = {
      daily: count(snapshots.keep?.daily, 'daily'),
      weekly: count(snapshots.keep?.weekly, 'weekly'),
      monthly: count(snapshots.keep?.monthly, 'monthly'),
    }
    if (keep.daily + keep.weekly + keep.monthly === 0) throw new Error('keep must keep at least one snapshot')
    const restoreCheckDays = snapshots.restoreCheckDays ?? DEFAULT_RESTORE_CHECK_DAYS
    if (typeof restoreCheckDays !== 'number' || restoreCheckDays < 0) {
      throw new Error('restoreCheckDays must be a number of 0 or more')
    }
    return { state: 'on', settings: { destination: snapshots.destination, keep, restoreCheckDays } }
  } catch (err) {
    return { state: 'invalid', error: `${path}: ${err instanceof Error ? err.message : err}` }
  }
}

const pad = (n: number) => String(n).padStart(2, '0')
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const monthKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
// Weeks start on Monday, keyed by that Monday's date.
const weekKey = (d: Date) => dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)))

/**
 * Which snapshots a daily, weekly and monthly rotation keeps: the newest in
 * each of the last `keep.daily` days that have one, and likewise for weeks and
 * months, in local time. One snapshot can fill a place in every tier.
 */
export function selectKept(times: Date[], keep: Keep): Set<number> {
  const order = times.map((t, i) => ({ t, i })).sort((a, b) => b.t.getTime() - a.t.getTime())
  const kept = new Set<number>()
  for (const [key, n] of [
    [dayKey, keep.daily],
    [weekKey, keep.weekly],
    [monthKey, keep.monthly],
  ] as const) {
    const seen = new Set<string>()
    for (const { t, i } of order) {
      if (seen.size >= n) break
      const k = key(t)
      if (seen.has(k)) continue
      seen.add(k)
      kept.add(i)
    }
  }
  return kept
}

const stamp = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
const SNAPSHOT_NAME = /-(\d{8}T\d{6}Z)\.db\.gz$/

function parseStamp(s: string): Date {
  return new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`)
}

export function snapshotFolder(destination: string, dbPath: string): string {
  return join(destination, hostname().replace(/\.local$/, ''), databaseId(dbPath))
}

export function listSnapshots(folder: string): SnapshotFile[] {
  let names: string[]
  try {
    names = readdirSync(folder)
  } catch {
    return []
  }
  const files: SnapshotFile[] = []
  for (const name of names) {
    const m = name.match(SNAPSHOT_NAME)
    if (!m || name.startsWith('.')) continue
    const path = join(folder, name)
    try {
      files.push({ at: parseStamp(m[1]).toISOString(), path, bytes: statSync(path).size })
    } catch {}
  }
  return files.sort((a, b) => a.at.localeCompare(b.at))
}

async function sqlite() {
  try {
    return await import('node:sqlite')
  } catch {
    throw new Error(`snapshots need node:sqlite, in Node 22.16 or later (this is ${process.version})`)
  }
}

/** Runs SQLite's full integrity check; throws with its findings when the file is damaged. */
export async function verifyDatabase(path: string): Promise<void> {
  const { DatabaseSync } = await sqlite()
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const rows = db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>
    const findings = rows.map((r) => r.integrity_check)
    if (findings.length !== 1 || findings[0] !== 'ok') {
      throw new Error(`integrity check failed: ${findings.slice(0, 3).join('; ')}`)
    }
  } finally {
    db.close()
  }
}

/** Rows in every ordinary table, including the shadow tables behind virtual ones. */
export async function countRows(path: string): Promise<number> {
  const { DatabaseSync } = await sqlite()
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL%'",
      )
      .all() as Array<{ name: string }>
    let total = 0
    for (const { name } of tables) {
      const row = db.prepare(`SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`).get() as { n: number }
      total += row.n
    }
    return total
  } finally {
    db.close()
  }
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path)
  } catch {}
}

// A copy interrupted by a shutdown leaves its partial file behind.
function sweepPartials(folder: string): void {
  let names: string[]
  try {
    names = readdirSync(folder)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.endsWith('.partial')) continue
    const path = join(folder, name)
    try {
      if (Date.now() - statSync(path).mtimeMs > PARTIAL_MAX_AGE_MS) unlinkSync(path)
    } catch {}
  }
}

/**
 * Copies the live database with SQLite's backup API, checks the copy, and
 * moves it into the destination compressed, then applies the rotation. The
 * copy is made and checked on local disk, so a synced folder never receives a
 * half-written or damaged file, and a bad copy never displaces a good one.
 */
export async function takeSnapshot(
  dbPath: string,
  settings: SnapshotSettings,
  workDir: string,
  now = new Date(),
): Promise<SnapshotFile> {
  const { DatabaseSync, backup } = await sqlite()
  // A missing destination is usually a sync client that is not running or not
  // signed in. Creating it would put snapshots on local disk under the synced
  // path, where they look backed up and never leave the machine.
  let isDir = false
  try {
    isDir = statSync(settings.destination).isDirectory()
  } catch {}
  if (!isDir) {
    throw new Error(`destination ${settings.destination} does not exist; is the sync client running?`)
  }
  const folder = snapshotFolder(settings.destination, dbPath)
  mkdirSync(folder, { recursive: true })
  mkdirSync(workDir, { recursive: true, mode: 0o700 })
  sweepPartials(folder)
  const source = join(folder, 'source.json')
  if (!existsSync(source)) writeFileSync(source, `${JSON.stringify({ dbPath }, null, 2)}\n`)

  const name = `${databaseId(dbPath)}-${stamp(now)}.db.gz`
  const work = join(workDir, `${name.slice(0, -3)}.${process.pid}`)
  const partial = join(folder, `.${name}.partial`)
  const target = join(folder, name)
  try {
    const live = new DatabaseSync(dbPath, { readOnly: true })
    try {
      await backup(live, work)
    } finally {
      live.close()
    }
    // The copy inherits WAL mode; a snapshot should be one self-contained file.
    const copy = new DatabaseSync(work)
    try {
      copy.exec('PRAGMA journal_mode = DELETE')
    } finally {
      copy.close()
    }
    await verifyDatabase(work)
    // Compress on local disk, then copy and rename, so the synced folder only
    // ever sees a whole file under its final name.
    await pipeline(createReadStream(work), createGzip(), createWriteStream(`${work}.gz`))
    copyFileSync(`${work}.gz`, partial)
    // A sync layer can drop a short write without reporting an error.
    const expected = statSync(`${work}.gz`).size
    const landed = statSync(partial).size
    if (landed !== expected) throw new Error(`copy into the destination is short: ${landed} of ${expected} bytes`)
    renameSync(partial, target)
  } finally {
    for (const suffix of ['', '-wal', '-shm', '-journal', '.gz']) removeQuietly(`${work}${suffix}`)
    removeQuietly(partial)
  }

  const files = listSnapshots(folder)
  const kept = selectKept(
    files.map((f) => new Date(f.at)),
    settings.keep,
  )
  files.forEach((f, i) => {
    if (!kept.has(i)) removeQuietly(f.path)
  })
  return { at: now.toISOString(), path: target, bytes: statSync(target).size }
}

/** Due when the destination holds no snapshot from today, in local time. */
export function snapshotDue(folder: string, now = new Date()): boolean {
  const newest = listSnapshots(folder).at(-1)
  if (!newest) return true
  // A file stamped ahead by a clock that was briefly wrong counts as today's,
  // or every pass would take another copy until that date arrived.
  if (Date.parse(newest.at) > now.getTime()) return false
  return dayKey(new Date(newest.at)) !== dayKey(now)
}

/** Empties the work folder; only the lock holder uses it, so anything there is left from a killed run. */
export function clearWorkDir(workDir: string): void {
  let names: string[]
  try {
    names = readdirSync(workDir)
  } catch {
    return
  }
  for (const name of names) removeQuietly(join(workDir, name))
}

/**
 * Restores the replica into a scratch file with litestream, checks it, and
 * compares its rows with the live database read right after, proving the
 * replica can be restored and is not far behind.
 */
export async function checkRestore(
  bin: string,
  configPath: string,
  dbPath: string,
  workDir: string,
): Promise<RestoreCheck> {
  mkdirSync(workDir, { recursive: true, mode: 0o700 })
  const out = join(workDir, `restore-${databaseId(dbPath)}-${process.pid}.db`)
  const at = new Date().toISOString()
  try {
    removeQuietly(out)
    await execFileAsync(bin, ['restore', '-config', configPath, '-o', out, dbPath], {
      timeout: 30 * 60_000,
      maxBuffer: 16 * 1024 * 1024,
    })
    await verifyDatabase(out)
    const restored = await countRows(out)
    const live = await countRows(dbPath)
    const detail = `restored ${restored} rows; the live database has ${live}`
    if (restored < live * RESTORE_ROW_FLOOR) {
      return { at, ok: false, detail: `the restore is far behind: ${detail}` }
    }
    return { at, ok: true, detail }
  } catch (err) {
    const message = String(err instanceof Error ? err.message : err).split('\n')[0]
    return { at, ok: false, detail: `restore failed: ${message}` }
  } finally {
    for (const suffix of ['', '-wal', '-shm', '.tmp']) removeQuietly(`${out}${suffix}`)
  }
}

/** Problems with a database's snapshots, judged from the destination itself. */
export function snapshotProblems(
  folder: string,
  lastError: SnapshotStatus['lastError'],
  restore: RestoreCheck | null,
  runningSinceMs: number,
  now = Date.now(),
): string[] {
  const problems: string[] = []
  const newest = listSnapshots(folder).at(-1)
  if (newest) {
    const age = now - Date.parse(newest.at)
    if (age > STALE_SNAPSHOT_MS) problems.push(`the newest snapshot is ${Math.round(age / 3_600_000)} h old`)
  } else if (now - runningSinceMs > STALE_SNAPSHOT_MS) {
    problems.push(`no snapshot has reached ${folder}`)
  }
  if (lastError) problems.push(`the last snapshot failed: ${lastError.message}`)
  if (restore && !restore.ok) problems.push(`the last restore check failed: ${restore.detail}`)
  return problems
}
