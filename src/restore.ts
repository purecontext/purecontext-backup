import { spawn } from 'node:child_process'
import { unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadLitestreamEnv } from './env.js'

export interface RestoreOptions {
  dbPath: string
  replicaPath: string
  outputPath: string
  timestamp?: string
  bucket?: string
  endpoint?: string
  region?: string
  accessKeyId?: string
  secretAccessKey?: string
  envFile?: string
}

function resolveEnv(opts: RestoreOptions) {
  return {
    bucket: opts.bucket ?? process.env.LITESTREAM_BUCKET,
    endpoint: opts.endpoint ?? process.env.LITESTREAM_ENDPOINT,
    region: opts.region ?? process.env.LITESTREAM_REGION ?? 'auto',
    accessKeyId: opts.accessKeyId ?? process.env.LITESTREAM_ACCESS_KEY_ID,
    secretAccessKey: opts.secretAccessKey ?? process.env.LITESTREAM_SECRET_ACCESS_KEY,
  }
}

function generateConfig(opts: RestoreOptions): string {
  const env = resolveEnv(opts)
  return `dbs:
  - path: ${opts.dbPath}
    replicas:
      - type: s3
        bucket: ${env.bucket}
        path: ${opts.replicaPath}
        endpoint: ${env.endpoint}
        region: ${env.region}
        access-key-id: ${env.accessKeyId}
        secret-access-key: ${env.secretAccessKey}
        force-path-style: true
`
}

export function restoreDatabase(opts: RestoreOptions): Promise<boolean> {
  loadLitestreamEnv(opts.envFile)
  return new Promise((resolve) => {
    const env = resolveEnv(opts)
    const missing = (['bucket', 'endpoint', 'accessKeyId', 'secretAccessKey'] as const).filter((k) => !env[k])

    if (missing.length > 0) {
      console.error(`[restore] missing env vars: ${missing.join(', ')}`)
      resolve(false)
      return
    }

    const configPath = join(tmpdir(), `litestream-restore-${process.pid}.yml`)
    writeFileSync(configPath, generateConfig(opts))

    const args = ['restore', '-config', configPath, '-o', opts.outputPath]
    if (opts.timestamp) args.push('-timestamp', opts.timestamp)
    args.push(opts.dbPath)

    console.error(`[restore] pulling snapshot → ${opts.outputPath}${opts.timestamp ? ` (at ${opts.timestamp})` : ''}`)

    const child = spawn('litestream', args, { stdio: 'inherit' })

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        console.error('[restore] litestream binary not found. Install: brew install benbjohnson/litestream/litestream')
      } else {
        console.error('[restore] failed:', err.message)
      }
      try {
        unlinkSync(configPath)
      } catch {}
      resolve(false)
    })

    child.on('exit', (code) => {
      try {
        unlinkSync(configPath)
      } catch {}
      if (code === 0) {
        console.error('[restore] complete. Inspect before promoting to live.')
      }
      resolve(code === 0)
    })
  })
}
