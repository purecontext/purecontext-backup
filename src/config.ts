export interface LitestreamOptions {
  name?: string
  configDir?: string
  dbPath: string
  replicaPath: string
  replicaType?: 's3' | 'file'
  bucket?: string
  endpoint?: string
  region?: string
  accessKeyId?: string
  secretAccessKey?: string
  syncInterval?: string
  snapshotInterval?: string
  retention?: string
  l0Retention?: string
  l0RetentionCheckInterval?: string
  envFile?: string
  logFile?: string
  logLevel?: 'debug' | 'info' | 'warn' | 'error'
}

export function resolveEnv(opts: LitestreamOptions) {
  return {
    bucket: opts.bucket ?? process.env.LITESTREAM_BUCKET,
    endpoint: opts.endpoint ?? process.env.LITESTREAM_ENDPOINT,
    region: opts.region ?? process.env.LITESTREAM_REGION ?? 'auto',
    accessKeyId: opts.accessKeyId ?? process.env.LITESTREAM_ACCESS_KEY_ID,
    secretAccessKey: opts.secretAccessKey ?? process.env.LITESTREAM_SECRET_ACCESS_KEY,
  }
}

export function missingCredentials(opts: LitestreamOptions): string[] {
  if (opts.replicaType === 'file') return []
  const env = resolveEnv(opts)
  return (['bucket', 'endpoint', 'accessKeyId', 'secretAccessKey'] as const).filter((k) => !env[k])
}

export function describeReplica(opts: LitestreamOptions): string {
  if (opts.replicaType === 'file') return `file://${opts.replicaPath}`
  return `s3://${resolveEnv(opts).bucket}/${opts.replicaPath}`
}

// Litestream parses config with non-strict YAML: unknown keys are silently
// ignored. Misplacing a key yields a running daemon with defaults and no error,
// so placement below is load-bearing and verified against the 0.5.x binary.
//
// Top level: l0-retention, l0-retention-check-interval, snapshot.{interval,retention}
// Replica level: bucket, path, endpoint, region, credentials, force-path-style, sync-interval
//
// The L0 retention monitor issues 2 LIST calls per check per database regardless
// of whether the database changed (upstream issue #1171). At the 15s default that
// is ~480 requests/hour per idle database; a 24h interval reduces it to ~2/day.
// A value of 0 disables the monitor outright but is rejected by 0.5.16 and
// earlier, so a long interval is used instead.
function assertPositiveDuration(value: string, key: string): void {
  if (/^0+(s|m|h|ms|us|ns)?$/.test(value.trim())) {
    throw new Error(
      `[litestream] ${key} must be greater than 0 (got "${value}"). Litestream refuses to start with a zero duration, which would silently disable backups.`,
    )
  }
}

function replicaSection(opts: LitestreamOptions): string {
  const sync = opts.syncInterval ?? '1s'
  if (opts.replicaType === 'file') {
    return `      - type: file
        path: ${opts.replicaPath}
        sync-interval: ${sync}`
  }
  const env = resolveEnv(opts)
  return `      - type: s3
        bucket: ${env.bucket}
        path: ${opts.replicaPath}
        endpoint: ${env.endpoint}
        region: ${env.region}
        access-key-id: ${env.accessKeyId}
        secret-access-key: ${env.secretAccessKey}
        force-path-style: true
        sync-interval: ${sync}`
}

export function generateConfig(dbs: LitestreamOptions[]): string {
  const first = dbs[0]
  const l0Retention = first.l0Retention ?? '8760h'
  const l0CheckInterval = first.l0RetentionCheckInterval ?? '24h'
  const snapshotInterval = first.snapshotInterval ?? '24h'
  const snapshotRetention = first.retention ?? '720h'
  const logLevel = first.logLevel ?? 'warn'

  assertPositiveDuration(l0Retention, 'l0-retention')
  assertPositiveDuration(l0CheckInterval, 'l0-retention-check-interval')

  const sections = dbs.map(
    (opts) => `  - path: ${opts.dbPath}
    replicas:
${replicaSection(opts)}`,
  )

  // Litestream 0.5 logs to stdout unless told otherwise, and only stderr is
  // read, so without this every replication error was discarded.
  return `logging:
  level: ${logLevel}
  stderr: true

l0-retention: ${l0Retention}
l0-retention-check-interval: ${l0CheckInterval}

snapshot:
  interval: ${snapshotInterval}
  retention: ${snapshotRetention}

dbs:
${sections.join('\n')}
`
}
