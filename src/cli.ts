#!/usr/bin/env node
import { serviceStatus, stopService, unregisterDatabase } from './client.js'
import { serve } from './serve.js'

const USAGE = `usage: purecontext-litestream <command>

  serve                 run the replication service in the foreground
  status [--json] [--cached]
                        show each registered database and its replica health;
                        exits 1 when any database has a problem, 2 when the
                        service is not running
  unregister <dbPath>   stop replicating a database
  stop                  stop the service; registrations are kept`

const [command, ...args] = process.argv.slice(2)

switch (command) {
  case 'serve':
    await serve()
    break
  case 'status': {
    const json = args.includes('--json')
    const status = await serviceStatus({ refresh: !args.includes('--cached') })
    if (!status) {
      console.log(json ? JSON.stringify({ running: false }) : 'litestream service is not running')
      process.exit(2)
    }
    if (json) {
      console.log(JSON.stringify({ running: true, ...status }, null, 2))
    } else {
      const count = status.dbs.length
      console.log(
        `litestream service ${status.version} (pid ${status.pid}), ${count} database${count === 1 ? '' : 's'}`,
      )
      for (const db of status.dbs) {
        const problems = db.state === 'running' ? (db.health?.problems ?? []) : [`replicator is ${db.state}`]
        const mark = problems.length > 0 ? 'FAIL' : db.health ? 'ok' : 'unchecked'
        console.log(`  ${mark.padEnd(9)} ${db.dbPath} → ${db.replica}`)
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
    console.log((await stopService()) ? 'stopped' : 'litestream service is not running')
    break
  default:
    console.error(USAGE)
    process.exit(command ? 64 : 0)
}
