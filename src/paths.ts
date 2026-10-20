import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

// macOS caps a unix socket path at 104 bytes.
const MAX_SOCKET_PATH = 103

export interface ServicePaths {
  home: string
  socket: string
  lock: string
  registry: string
  log: string
  dbDir: string
}

export function servicePaths(
  home = process.env.PURECONTEXT_LITESTREAM_HOME ?? join(homedir(), '.config', 'purecontext', 'litestream'),
): ServicePaths {
  const socket = join(home, 'serve.sock')
  if (Buffer.byteLength(socket) > MAX_SOCKET_PATH) {
    throw new Error(`[litestream] service socket path is too long for a unix socket: ${socket}`)
  }
  return {
    home,
    socket,
    lock: join(home, 'serve.lock'),
    registry: join(home, 'registry.json'),
    log: join(home, 'serve.log'),
    dbDir: join(home, 'dbs'),
  }
}

// One database must have one identity however it is spelled (/tmp versus
// /private/tmp, or Jill versus jill on a case-insensitive disk), or two
// registrations could start two replicators. Only the native realpath
// returns the case stored on disk.
export function canonicalDbPath(dbPath: string): string {
  const abs = resolve(dbPath)
  if (existsSync(abs)) return realpathSync.native(abs)
  const dir = dirname(abs)
  return existsSync(dir) ? join(realpathSync.native(dir), basename(abs)) : abs
}

export function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  return pkg.version
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}
