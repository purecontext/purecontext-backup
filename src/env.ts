import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_ENV_PATH = join(homedir(), '.config', 'purecontext', 'litestream.env')

export function loadLitestreamEnv(envPath?: string): void {
  const path = envPath ?? DEFAULT_ENV_PATH
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    return
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const raw = trimmed.slice(eq + 1).trim()
    const val = raw.replace(/^["']|["']$/g, '')
    if (!(key in process.env)) process.env[key] = val
  }
}
