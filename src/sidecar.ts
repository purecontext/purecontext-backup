import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type LitestreamOptions, describeReplica, generateConfig, missingCredentials } from './config.js'
import { loadLitestreamEnv } from './env.js'

export type { LitestreamOptions } from './config.js'

interface LitestreamState {
  child: ChildProcess
  configPath: string
}

let state: LitestreamState | null = null

function configFileName(name: string): string {
  return `litestream-${name}.yml`
}

function killOrphans(configName: string): void {
  let pids: string
  try {
    pids = execFileSync('pgrep', ['-f', configName], { encoding: 'utf-8' }).trim()
  } catch {
    return
  }
  if (!pids) return

  for (const line of pids.split('\n')) {
    const pid = Number.parseInt(line.trim(), 10)
    if (Number.isNaN(pid)) continue

    console.error(`[litestream] killing orphaned replicator (pid ${pid})`)
    try {
      process.kill(pid, 'SIGTERM')
    } catch {}
  }

  const deadline = Date.now() + 2000
  for (const line of pids.split('\n')) {
    const pid = Number.parseInt(line.trim(), 10)
    if (Number.isNaN(pid)) continue

    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0)
      } catch {
        break
      }
      execFileSync('sleep', ['0.1'])
    }

    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
}

function stopPreviousChild(): void {
  if (!state) return

  const { child } = state
  const pid = child.pid
  if (pid === undefined || child.exitCode !== null || child.killed) return

  console.error(`[litestream] stopping previous replicator (pid ${child.pid})`)
  child.kill('SIGTERM')

  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    execFileSync('sleep', ['0.1'])
  }

  try {
    child.kill('SIGKILL')
  } catch {
    // already gone
  }
}

export function startLitestream(opts: LitestreamOptions): boolean {
  return startLitestreamAll([opts])
}

export function startLitestreamAll(dbs: LitestreamOptions[]): boolean {
  if (dbs.length === 0) return false

  loadLitestreamEnv(dbs[0].envFile)
  const missing = missingCredentials(dbs[0])

  if (missing.length > 0) {
    console.error(`[litestream] not started — missing: ${missing.join(', ')}. Backups are OFF.`)
    return false
  }

  const name = dbs[0].name ?? `pid-${process.pid}`
  const cfgName = configFileName(name)
  const dir = dbs[0].configDir ?? tmpdir()

  stopPreviousChild()
  killOrphans(cfgName)

  mkdirSync(dir, { recursive: true })
  const configPath = join(dir, cfgName)
  writeFileSync(configPath, generateConfig(dbs))

  const child = spawn('litestream', ['replicate', '-config', configPath], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })

  const logFile = dbs.find((d) => d.logFile)?.logFile
  child.stderr?.on('data', (data: Buffer) => {
    const msg = data.toString().trim()
    if (!msg) return
    const line = `[${new Date().toISOString()}] ${msg}\n`
    console.error(`[litestream] ${msg}`)
    if (logFile) {
      try {
        appendFileSync(logFile, line)
      } catch {}
    }
  })

  child.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') {
      console.error('[litestream] binary not found. Install: brew install benbjohnson/litestream/litestream')
    } else {
      console.error('[litestream] failed to start:', err.message)
    }
    cleanup()
  })

  child.on('exit', () => {
    cleanup()
  })

  state = { child, configPath }

  process.on('SIGINT', stopLitestream)
  process.on('SIGTERM', stopLitestream)

  for (const db of dbs) {
    console.error(`[litestream] replicating ${db.dbPath} → ${describeReplica(db)}`)
  }
  return true
}

function cleanup(): void {
  if (!state) return
  try {
    unlinkSync(state.configPath)
  } catch {}
  state = null
}

export function stopLitestream(): void {
  if (!state) return
  state.child.kill('SIGTERM')
  cleanup()
}
