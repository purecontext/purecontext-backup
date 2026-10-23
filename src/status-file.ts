import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { type ServicePaths, canonicalDbPath, servicePaths } from './paths.js'
import type { ServiceStatus } from './serve.js'

export interface StatusFile {
  writtenAt: string
  status: ServiceStatus
}

export interface BackupProblems {
  /** False when no service holds the lock; the file then says nothing current. */
  running: boolean
  problems: string[]
}

// The service checks health every 5 minutes; three missed passes is a hang.
const STALE_MS = 15 * 60_000

export function writeStatusFile(paths: ServicePaths, status: ServiceStatus): void {
  const tmp = `${paths.statusFile}.${process.pid}.tmp`
  const file: StatusFile = { writtenAt: new Date().toISOString(), status }
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, paths.statusFile)
}

export function removeStatusFile(paths: ServicePaths): void {
  try {
    unlinkSync(paths.statusFile)
  } catch {}
}

export function readStatusFile(paths: ServicePaths = servicePaths()): StatusFile | null {
  try {
    return JSON.parse(readFileSync(paths.statusFile, 'utf8'))
  } catch {
    return null
  }
}

function lockHolderAlive(lockPath: string): boolean {
  try {
    const pid = Number.parseInt(readFileSync(lockPath, 'utf8'), 10)
    if (Number.isNaN(pid)) return false
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * What is wrong with the backups of `dbPaths`, read from the file the service
 * writes, so it costs no socket call and no litestream run. A database the
 * service has not checked yet is not a problem; one it does not know is.
 */
export function backupProblems(
  dbPaths: string[],
  opts: { paths?: ServicePaths; now?: number; staleMs?: number } = {},
): BackupProblems {
  const paths = opts.paths ?? servicePaths()
  if (!lockHolderAlive(paths.lock)) return { running: false, problems: [] }
  const file = readStatusFile(paths)
  // A service from before this file existed writes none; the next client to
  // register replaces it with one that does.
  if (!file) return { running: true, problems: [] }
  const problems: string[] = []
  const age = (opts.now ?? Date.now()) - Date.parse(file.writtenAt)
  if (age > (opts.staleMs ?? STALE_MS)) {
    problems.push(
      `the backup service has not reported in ${Math.round(age / 60_000)} min, so its health checks have stopped`,
    )
  }
  const { status } = file
  if (status.snapshots.state === 'invalid') problems.push(`snapshot config is invalid: ${status.snapshots.error}`)
  for (const dbPath of dbPaths) {
    const canonical = canonicalDbPath(dbPath)
    const d = status.dbs.find((x) => x.dbPath === canonical)
    if (!d) {
      problems.push(`${canonical} is not registered with the backup service`)
      continue
    }
    if (d.state !== 'running') {
      problems.push(`${canonical}: replicator is ${d.state}${d.lastError ? `: ${d.lastError.message}` : ''}`)
    }
    for (const p of d.health?.problems ?? []) problems.push(`${canonical}: ${p}`)
    for (const p of d.snapshot?.problems ?? []) problems.push(`${canonical}: snapshot: ${p}`)
  }
  return { running: true, problems }
}
