#!/usr/bin/env node
import { serviceStatus, stopService, unregisterDatabase } from './client.js'
import { servicePaths } from './paths.js'
import { serve } from './serve.js'

const USAGE = `usage: purecontext-backup <command>

  serve [--home <dir>]  run the backup service in the foreground
  status [--json] [--cached]
                        show each registered database, its replica health and
                        its snapshots; exits 1 when anything has a problem, 2
                        when the service is not running
  unregister <dbPath>   stop backing up a database
  stop                  stop the service; registrations are kept`

const [command, ...args] = process.argv.slice(2)

const ago = (iso: string) => {
  const h = (Date.now() - Date.parse(iso)) / 3_600_000
  return h < 1 ? `${Math.round(h * 60)} min ago` : `${Math.round(h)} h ago`
}

switch (command) {
  case 'serve': {
    const at = args.indexOf('--home')
    await serve(at === -1 ? servicePaths() : servicePaths(args[at + 1]))
    break
  }
  case 'status': {
    const json = args.includes('--json')
    const status = await serviceStatus({ refresh: !args.includes('--cached') })
    if (!status) {
      console.log(json ? JSON.stringify({ running: false }) : 'backup service is not running')
      process.exit(2)
    }
    if (json) {
      console.log(JSON.stringify({ running: true, ...status }, null, 2))
    } else {
      const count = status.dbs.length
      console.log(`backup service ${status.version} (pid ${status.pid}), ${count} database${count === 1 ? '' : 's'}`)
      const s = status.snapshots
      if (s.state === 'on') {
        console.log(
          `  snapshots to ${s.destination}, keeping ${s.keep.daily} daily, ${s.keep.weekly} weekly, ${s.keep.monthly} monthly`,
        )
      } else if (s.state === 'invalid') {
        console.log(`  FAIL snapshots are misconfigured: ${s.error}`)
      } else {
        console.log('  snapshots are off')
      }
      for (const db of status.dbs) {
        const problems = [
          ...(db.state === 'running' ? (db.health?.problems ?? []) : [`replicator is ${db.state}`]),
          ...(db.snapshot?.problems ?? []),
        ]
        const mark = problems.length > 0 ? 'FAIL' : db.health ? 'ok' : 'unchecked'
        console.log(`  ${mark.padEnd(9)} ${db.dbPath} → ${db.replica}`)
        if (db.snapshot?.newest) {
          console.log(`            snapshot ${ago(db.snapshot.newest.at)}, ${db.snapshot.kept} kept`)
        }
        if (db.snapshot?.restoreCheck?.ok) {
          console.log(`            restore check passed ${ago(db.snapshot.restoreCheck.at)}`)
        }
        for (const p of problems) console.log(`            ${p}`)
      }
    }
    process.exit(status.ok ? 0 : 1)
    break
  }
  case 'unregister': {
    if (!args[0]) {
      console.error(USAGE)
      process.exit(64)
    }
    const result = await unregisterDatabase(args[0])
    console.log(`${result.dbPath}: ${result.status}`)
    break
  }
  case 'stop':
    console.log((await stopService()) ? 'stopped' : 'backup service is not running')
    break
  default:
    console.error(USAGE)
    process.exit(command ? 64 : 0)
}
