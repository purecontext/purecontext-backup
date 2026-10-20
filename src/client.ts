import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, renameSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type LitestreamOptions, missingCredentials, resolveEnv } from './config.js'
import { loadLitestreamEnv } from './env.js'
import { type ServicePaths, canonicalDbPath, compareVersions, packageVersion, servicePaths } from './paths.js'
import { isServing, rpc } from './rpc.js'
import type { DatabaseSpec, ServiceStatus } from './serve.js'

export interface RegisterResult {
  status: 'started' | 'unchanged' | 'updated' | 'skipped'
  dbPath: string
  replica?: string
  reason?: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await sleep(100)
  }
  return false
}

function spawnService(paths: ServicePaths): void {
  mkdirSync(paths.home, { recursive: true, mode: 0o700 })
  try {
    if (statSync(paths.log).size > 1_000_000) renameSync(paths.log, `${paths.log}.1`)
  } catch {}
  const out = openSync(paths.log, 'a', 0o600)
  const child = spawn(process.execPath, [fileURLToPath(new URL('./cli.js', import.meta.url)), 'serve'], {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, PURECONTEXT_LITESTREAM_HOME: paths.home },
  })
  child.unref()
  closeSync(out)
}

export async function serviceStatus(
  opts: { refresh?: boolean } = {},
  paths: ServicePaths = servicePaths(),
): Promise<ServiceStatus | null> {
  try {
    const res = await rpc(paths.socket, 'GET', opts.refresh ? '/status?refresh=1' : '/status', undefined, 120_000)
    return res.status === 200 ? res.body : null
  } catch {
    return null
  }
}

// Starts the service when it is absent, detached so it outlives this process.
// A running service older than this package is stopped and replaced; its
// registrations persist on disk and the new one resumes them.
export async function ensureService(paths: ServicePaths = servicePaths()): Promise<void> {
  const running = await serviceStatus({}, paths)
  if (running) {
    if (compareVersions(running.version, packageVersion()) >= 0) return
    console.error(`[litestream] replacing service ${running.version} with ${packageVersion()}`)
    await rpc(paths.socket, 'POST', '/stop', {}, 30_000).catch(() => {})
    await waitFor(async () => !(await isServing(paths.socket)), 15_000)
  }
  spawnService(paths)
  if (!(await waitFor(() => isServing(paths.socket), 10_000))) {
    throw new Error(`[litestream] the service did not start; see ${paths.log}`)
  }
}

function toSpec(opts: LitestreamOptions, dbPath: string): DatabaseSpec {
  const { name, configDir, envFile, logFile, ...rest } = opts
  if (opts.replicaType === 'file') return { ...rest, dbPath, replicaPath: resolve(opts.replicaPath) }
  return { ...rest, ...resolveEnv(opts), dbPath }
}

export async function registerDatabase(
  opts: LitestreamOptions,
  paths: ServicePaths = servicePaths(),
): Promise<RegisterResult> {
  loadLitestreamEnv(opts.envFile)
  const dbPath = canonicalDbPath(opts.dbPath)
  const missing = missingCredentials(opts)
  if (missing.length > 0) {
    const reason = `missing: ${missing.join(', ')}`
    console.error(`[litestream] ${dbPath} not registered — ${reason}. Backups are OFF.`)
    return { status: 'skipped', dbPath, reason }
  }
  await ensureService(paths)
  const res = await rpc(paths.socket, 'POST', '/register', toSpec(opts, dbPath), 60_000)
  if (res.status !== 200) {
    throw new Error(`[litestream] ${res.body?.error ?? `register failed with HTTP ${res.status}`}`)
  }
  return res.body
}

export async function unregisterDatabase(
  dbPath: string,
  paths: ServicePaths = servicePaths(),
): Promise<{ status: 'removed' | 'unknown' | 'not-running'; dbPath: string }> {
  const canonical = canonicalDbPath(dbPath)
  if (!(await isServing(paths.socket))) return { status: 'not-running', dbPath: canonical }
  const res = await rpc(paths.socket, 'POST', '/unregister', { dbPath: canonical }, 30_000)
  if (res.status !== 200) throw new Error(`[litestream] ${res.body?.error ?? `HTTP ${res.status}`}`)
  return res.body
}

export async function stopService(paths: ServicePaths = servicePaths()): Promise<boolean> {
  if (!(await isServing(paths.socket))) return false
  await rpc(paths.socket, 'POST', '/stop', {}, 30_000)
  return waitFor(async () => !(await isServing(paths.socket)), 15_000)
}
