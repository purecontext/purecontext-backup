# @purecontext/backup

SQLite backup in two independent layers. A small background service runs one [Litestream](https://litestream.io) replicator per database, replicating it to S3-compatible storage or a local directory with point-in-time recovery. It can also take a verified snapshot of every database each day into a folder you choose, such as a synced Google Drive, rotated by day, week and month, and regularly restore the replica to prove it works.

This package was `@purecontext/litestream` through 0.3.4. The API is unchanged; only the name and the snapshots are new.

Designed for Node.js servers and MCP servers that use SQLite. Registration is skipped with a warning when credentials are missing. Your app runs fine either way.

## Install

```bash
npm install @purecontext/backup
```

Litestream must be installed separately:

```bash
brew install benbjohnson/litestream/litestream
```

## Quick Start

```ts
import { registerDatabase } from '@purecontext/backup'

await registerDatabase({
  dbPath: './data/my-app.db',
  replicaPath: 'my-app/my-app.db',
})
```

Create the database before registering it; a path that does not exist is refused.

## Replication Service

`registerDatabase` starts the service when it is absent, detached so it keeps running after the caller exits, and asks it to replicate the database. Several processes can register the same database, as several sessions of one app do, and it still gets a single replicator that outlives them all. Then:

- **One replicator per database.** Registering the same database again with the same settings changes nothing. Changed settings restart its replicator. A different destination is refused until the database is unregistered. Any other litestream process replicating the same file, such as an older sidecar, is stopped first. When the process list cannot be read to check for one, the replicator does not start; it waits in backoff and tries again.
- **One database per replica.** A second database registered to a destination another database already uses is refused, as when a copied clone registers its own database to the original's replica path. Two databases writing one replica would overwrite each other's history.
- **Registrations persist.** They are kept in `registry.json` and resumed whenever the service starts. A registered database whose file no longer exists, such as a deleted clone, is dropped from the registry when the service resumes, at each health check, and at the next registration. The service stays up while any database is registered and exits after the last one is unregistered. A registration that arrives while it is shutting down is retried against the next service.
- **One service per home.** A lock decides between clients that start it at the same moment, and a lock left by a dead process is reclaimed.
- **Upgrades.** A client newer than the running service stops it and starts its own version. The registrations carry over.
- **Supervision.** A replicator that exits, or fails to start, is retried with backoff, up to one minute between attempts.
- **Health.** Every five minutes the service compares the replica with the local database. It reports a problem when the replica has no change files, so only snapshots are landing. It also reports one when the replica is behind and has received nothing for five minutes, and when litestream reports no local position for the database, so lag cannot be measured. A running process proves nothing on its own: the service is `ok` only when every database is running and has passed a check. A database not yet checked shows `health: null`, printed as `unchecked`, and is not `ok`.

Credentials resolve in the client, as below, and travel with the registration. The service's own environment is never consulted.

The service lives in `~/.config/purecontext/litestream`, or in `PURECONTEXT_LITESTREAM_HOME` when that is set. That folder holds the socket, lock, registry, the service log `serve.log`, and per-database configs and logs in `dbs/`. Unregistering or dropping a database removes its config and logs. The folder is created with mode 700. `registry.json` and the configs in `dbs/` hold the S3 secret key in plain text, so they are created with mode 600, like the sidecar's config. The folder keeps its `litestream` name from before the rename, so a service of either name finds the same socket and lock, and a machine mid-update never runs two.

### Command line

```bash
purecontext-backup status        # health of every registered database; exit 1 on a problem or an unchecked database, 2 when not running
purecontext-backup status --json # the same, for other tools
purecontext-backup unregister ./data/my-app.db
purecontext-backup stop          # registrations are kept
purecontext-backup serve         # run in the foreground
```

`serviceStatus()`, `unregisterDatabase()` and `stopService()` do the same from code.

### File replicas

Set `replicaType: 'file'` and an absolute `replicaPath` to replicate to a local directory instead of S3. No credentials are needed. This works with the sidecar too.

### Moving from the sidecar

When a database moves to the service, every process that replicates it must move in the same release. The service stops any sidecar it finds on the database when it registers and again at each health check. A process still on the old version that starts afterward runs its own sidecar until the next check, up to five minutes, with two replicators on one database. Restart every process that uses the database together.

## Snapshots

Replication copies every change, including a damaged one, to one storage account under one set of credentials. Snapshots are the second layer: whole copies of each registered database, in a place with its own credentials, kept long enough to outlast a mistake.

Turn them on in `~/.config/purecontext/backup.json`, or the file `PURECONTEXT_BACKUP_CONFIG` names. The service rereads it on every pass, so an edit needs no restart.

```json
{
  "snapshots": {
    "destination": "/Users/me/Library/CloudStorage/GoogleDrive-me@example.com/My Drive/Backups/purecontext",
    "keep": { "daily": 7, "weekly": 4, "monthly": 6 },
    "restoreCheckDays": 7
  }
}
```

| Key | Default | Meaning |
|-----|---------|---------|
| `destination` | | Absolute path of the folder snapshots go to. A folder a sync client uploads, such as Google Drive or iCloud Drive, takes them off the machine. |
| `keep.daily` | 7 | Keep the newest snapshot of each of this many recent days. |
| `keep.weekly` | 4 | Likewise for weeks, starting Monday. |
| `keep.monthly` | 6 | Likewise for months. |
| `restoreCheckDays` | 7 | Days between restore checks of the replica. 0 turns them off. |

The tiers share files: one snapshot can be this month's, this week's and today's at once. With the defaults, at most 17 are kept per database. A tier set to 0 keeps nothing for itself, and at least one tier must keep something.

- **Once a day.** Every five minutes the service checks whether each database has a snapshot from today, in local time, and takes one if not. A machine asleep at night catches up when it wakes.
- **Verified before it lands.** The copy is made with SQLite's backup API, which is safe while the database is in use, then switched to a single-file journal and run through `PRAGMA integrity_check`. Only a copy that passes is compressed and moved into the destination, under a temporary name first, so a synced folder never uploads a partial or damaged file and a bad copy never replaces a good one.
- **Layout.** `<destination>/<host>/<database file>-<hash>/<database file>-<hash>-<UTC time>.db.gz`, with a `source.json` naming the database's path. Restore one with `gunzip -c <file> > restored.db`.
- **Restore checks.** Every `restoreCheckDays`, the service restores the replica into a scratch file, checks its integrity, and compares its row count with the live database. Fewer than 90% of the live rows, a failed restore, or a damaged result is a problem. A failed check retries after an hour. Results are kept in `snapshots.json` in the service folder.
- **Health from the destination.** Status reads the destination itself. A newest snapshot more than 36 hours old, a failed snapshot or a failed restore check is a problem, and makes the service not `ok`. So does an invalid config file. Snapshots need `node:sqlite`, in Node 22.16 or later.

## Credentials

Credentials resolve in order:

1. **Options** passed directly to `registerDatabase()` / `restoreDatabase()` (or the sidecar's `startLitestream()`)
2. **Environment variables**: `LITESTREAM_BUCKET`, `LITESTREAM_ENDPOINT`, `LITESTREAM_REGION`, `LITESTREAM_ACCESS_KEY_ID`, `LITESTREAM_SECRET_ACCESS_KEY`
3. **Env file** at `~/.config/purecontext/litestream.env` (loaded automatically, override with `envFile` option)

Example env file:

```env
LITESTREAM_BUCKET=my-backups
LITESTREAM_ENDPOINT=https://your-storage-endpoint.com/storage/v1/s3
LITESTREAM_REGION=us-west-2
LITESTREAM_ACCESS_KEY_ID=your-access-key
LITESTREAM_SECRET_ACCESS_KEY=your-secret-key
```

Environment variables are loaded non-destructively. If a variable is already set in `process.env`, the env file value is ignored.

## Options

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `dbPath` | yes | | Path to your SQLite database. |
| `replicaPath` | yes | | Path within the S3 bucket, or an absolute directory for a file replica. |
| `replicaType` | | `s3` | `s3` or `file`. |
| `bucket` | | env var | S3 bucket name. |
| `endpoint` | | env var | S3-compatible endpoint URL. |
| `region` | | `auto` | S3 region. |
| `accessKeyId` | | env var | S3 access key. |
| `secretAccessKey` | | env var | S3 secret key. |
| `syncInterval` | | `1s` | How often WAL frames are replicated. |
| `snapshotInterval` | | `24h` | How often full snapshots are taken. |
| `retention` | | `720h` | How long to keep backup history (30 days). |
| `envFile` | | `~/.config/purecontext/litestream.env` | Custom env file path. |
| `name` | | `pid-{process.pid}` | Sidecar only. Stable identifier for this instance. Controls config filename and orphan detection. |
| `configDir` | | system temp dir | Sidecar only. Directory for the generated Litestream config file. |
| `logFile` | | | Sidecar only. File path for Litestream stderr output. Appended with timestamps. |

## Restore

```ts
import { restoreDatabase } from '@purecontext/backup'

await restoreDatabase({
  dbPath: './data/my-app.db',
  replicaPath: 'my-app/my-app.db',
  outputPath: './data/my-app.restored.db',
  timestamp: '2026-04-15T14:30:00Z', // optional, omit for latest
})
```

Restores to a sidecar file. Inspect before promoting to live.

## Optional Integration

For projects where backup is nice-to-have, use dynamic import and list the package as `optionalDependencies`:

```ts
async function maybeStartBackup(dbPath: string) {
  try {
    const { registerDatabase } = await import('@purecontext/backup')
    await registerDatabase({ dbPath, replicaPath: 'my-app/my-app.db' })
  } catch {
    // package not installed, or the service could not start
  }
}
```

## In-Process Sidecar (older API)

Before the service, the package ran Litestream as a child of the calling process. That API is still exported for projects on 0.2.x, but new code should use `registerDatabase`. The sidecar ties a replicator to the process that started it: when several processes use one database, the last to start kills the others' replicator, and the database goes unreplicated once that process exits.

```ts
import { startLitestream, stopLitestream } from '@purecontext/backup'

startLitestream({
  name: 'my-app',
  configDir: './data',          // config written to ./data/litestream-my-app.yml
  dbPath: './data/my-app.db',
  replicaPath: 'my-app/my-app.db',
})

stopLitestream()                // also runs on SIGINT / SIGTERM; the config file is removed on exit
```

Litestream runs as a child process. When your server exits, the sidecar exits with it.

### Process isolation

Each caller provides a `name` that uniquely identifies its Litestream instance. The name controls two things:

1. **Config filename.** The generated Litestream YAML config is written as `litestream-{name}.yml` in the `configDir` directory.
2. **Orphan detection.** On startup, the library runs `pgrep -f litestream-{name}.yml` to find and kill stale processes from prior abnormal exits before spawning a new one.

This means multiple projects can run Litestream simultaneously without interfering with each other. A project named `platform` only cleans up `litestream-platform.yml` processes. A project named `recall` only cleans up `litestream-recall.yml` processes.

If `name` is omitted, it falls back to `pid-{process.pid}`, which is unique per run but cannot detect orphans from prior runs. Always provide a stable name in production.

### Config directory

The config file contains S3 credentials (resolved from env vars or the credentials file). Placing it in a project-local directory that is already gitignored keeps credentials out of world-readable locations like `/tmp`. If `configDir` is omitted, the config is written to the system temp directory for backward compatibility.

### Multi-database replication

Use `startLitestreamAll` to replicate multiple databases with a single Litestream process:

```ts
import { startLitestreamAll } from '@purecontext/backup'

startLitestreamAll([
  {
    name: 'my-app',
    configDir: './data',
    dbPath: './data/main.db',
    replicaPath: 'my-app/main.db',
  },
  {
    dbPath: './data/analytics.db',
    replicaPath: 'my-app/analytics.db',
  },
])
```

The `name` and `configDir` are read from the first entry in the array. All databases share a single Litestream process and config file.

### Orphan cleanup

When a parent process dies without cleanup (force quit, `SIGKILL`, crash), the Litestream child process becomes an orphan. On the next startup:

1. `pgrep -f litestream-{name}.yml` finds all processes matching this instance's config filename.
2. Each orphan receives `SIGTERM`.
3. The library polls for up to 2 seconds, waiting for graceful exit.
4. Any process still running after the deadline receives `SIGKILL`.
5. A new Litestream process is spawned with a fresh config.

If `pgrep` fails or returns no results, startup proceeds normally. The mechanism is self-healing: orphans are always cleaned up on the next startup, regardless of how the previous process died.

## License

MIT
