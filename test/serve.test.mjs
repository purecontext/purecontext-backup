import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, before, describe, test } from 'node:test'
import { registerDatabase, serviceStatus, stopService, unregisterDatabase } from '../dist/index.js'
import { servicePaths } from '../dist/paths.js'

// Every call below passes its own fixture paths, but one that forgets falls
// back to the default home; point that at a throwaway folder so no test can
// reach the live service or leave files in ~/.config/purecontext/litestream.
const isolatedHome = mkdtempSync(join(tmpdir(), 'pls-default-'))
process.env.PURECONTEXT_LITESTREAM_HOME = isolatedHome
process.on('exit', () => rmSync(isolatedHome, { recursive: true, force: true }))

let hasBinary = true
try {
  execFileSync('litestream', ['version'])
} catch {
  hasBinary = false
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(check, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await sleep(200)
  }
  throw new Error('condition not met in time')
}

function makeDb(dir, name) {
  const path = join(dir, name)
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)')
  db.prepare('INSERT INTO t (v) VALUES (?)').run('first')
  return { path, db }
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'pls-'))
  const paths = servicePaths(home)
  const opts = (db, replica = 'replica') => ({
    dbPath: db.path,
    replicaType: 'file',
    replicaPath: join(home, replica, db.path.split('/').pop()),
  })
  return { home, paths, opts }
}

const servicePids = (home) =>
  execFileSync('ps', ['-axo', 'pid=,args='], { encoding: 'utf8' })
    .split('\n')
    .filter((l) => l.includes('cli.js serve'))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((pid) => {
      try {
        return execFileSync('ps', ['-E', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).includes(home)
      } catch {
        return false
      }
    })

describe('litestream service', { skip: !hasBinary && 'litestream binary not installed' }, () => {
  const fixtures = []
  const make = () => {
    const f = fixture()
    fixtures.push(f)
    return f
  }

  after(async () => {
    for (const f of fixtures) {
      let pid = null
      try {
        pid = Number(readFileSync(f.paths.lock, 'utf8'))
      } catch {}
      const stopped = await stopService(f.paths).catch(() => false)
      // A failing test can leave a service no client can reach; its SIGTERM
      // handler still stops its replicators.
      if (!stopped && pid && alive(pid)) {
        process.kill(pid, 'SIGTERM')
        await until(() => !alive(pid)).catch(() => process.kill(pid, 'SIGKILL'))
      }
      rmSync(f.home, { recursive: true, force: true })
    }
  })

  test('starts on first registration, replicates, and reports health', async () => {
    const { home, paths, opts } = make()
    const a = makeDb(home, 'a.db')
    const result = await registerDatabase(opts(a), paths)
    assert.equal(result.status, 'started')

    for (let i = 0; i < 50; i++) a.db.prepare('INSERT INTO t (v) VALUES (?)').run(`row ${i}`)
    const status = await until(async () => {
      const s = await serviceStatus({ refresh: true }, paths)
      const h = s?.dbs[0]?.health
      return h?.remoteTxid !== undefined && h.remoteTxid === h.localTxid ? s : null
    })
    assert.equal(status.ok, true)
    assert.equal(status.dbs[0].state, 'running')
    assert.deepEqual(status.dbs[0].health.problems, [])
    assert.match(readFileSync(status.dbs[0].configPath, 'utf8'), new RegExp(`- path: ${status.dbs[0].dbPath}`))
    assert.ok(alive(status.pid))
    a.db.close()
  })

  test('a replica that stops receiving changes is reported', async () => {
    const { home, paths, opts } = make()
    const a = makeDb(home, 'a.db')
    process.env.PURECONTEXT_LITESTREAM_STALE_MS = '1000'
    try {
      await registerDatabase(opts(a), paths)
    } finally {
      Reflect.deleteProperty(process.env, 'PURECONTEXT_LITESTREAM_STALE_MS')
    }
    await until(async () => (await serviceStatus({ refresh: true }, paths)).dbs[0].health?.remoteTxid)
    const replica = join(home, 'replica')
    execFileSync('chmod', ['-R', 'a-w', replica])
    try {
      for (let i = 0; i < 20; i++) a.db.prepare('INSERT INTO t (v) VALUES (?)').run(`row ${i}`)
      const problems = await until(async () => {
        const h = (await serviceStatus({ refresh: true }, paths)).dbs[0].health
        return h.problems.length > 0 ? h.problems : null
      })
      assert.match(problems[0], /transactions behind/)
    } finally {
      execFileSync('chmod', ['-R', 'u+w', replica])
      a.db.close()
    }
  })

  test('the same file spelled in another case is the same database', async () => {
    const { home, paths, opts } = make()
    const a = makeDb(home, 'a.db')
    await registerDatabase(opts(a), paths)
    const shouted = { ...opts(a), dbPath: join(home, 'A.DB') }
    assert.equal((await registerDatabase(shouted, paths)).status, 'unchanged')
    assert.equal((await serviceStatus({}, paths)).dbs.length, 1)
    a.db.close()
  })

  test('a replica listing larger than 1 MiB is still read', async () => {
    const { home, paths, opts } = make()
    const a = makeDb(home, 'a.db')
    const real = execFileSync('which', ['litestream'], { encoding: 'utf8' }).trim()
    const wrapper = join(home, 'litestream')
    // Whitespace after the JSON keeps it valid while pushing it past 1 MiB.
    writeFileSync(
      wrapper,
      `#!/bin/sh\nif [ "$1" = ltx ]; then ${real} "$@"; head -c 2097152 /dev/zero | tr '\\0' ' '; exit 0; fi\nexec ${real} "$@"\n`,
      { mode: 0o755 },
    )
    process.env.LITESTREAM_BIN = wrapper
    try {
      await registerDatabase(opts(a), paths)
    } finally {
      Reflect.deleteProperty(process.env, 'LITESTREAM_BIN')
    }
    for (let i = 0; i < 10; i++) a.db.prepare('INSERT INTO t (v) VALUES (?)').run(`row ${i}`)
    const health = await until(async () => {
      const h = (await serviceStatus({ refresh: true }, paths)).dbs[0].health
      return h?.remoteTxid !== undefined && h.remoteTxid === h.localTxid ? h : null
    })
    assert.deepEqual(health.problems, [])
    a.db.close()
  })

  test('a replicator that keeps dying is reported even while it is up', async () => {
    const { home, paths, opts } = make()
    const a = makeDb(home, 'a.db')
    const real = execFileSync('which', ['litestream'], { encoding: 'utf8' }).trim()
    const wrapper = join(home, 'litestream')
    writeFileSync(wrapper, `#!/bin/sh\nif [ "$1" = replicate ]; then sleep 1; exit 1; fi\nexec ${real} "$@"\n`, { mode: 0o755 })
    process.env.LITESTREAM_BIN = wrapper
    try {
      await registerDatabase(opts(a), paths)
    } finally {
      Reflect.deleteProperty(process.env, 'LITESTREAM_BIN')
    }
    const health = await until(async () => {
      const d = (await serviceStatus({}, paths)).dbs[0]
      if (d.restarts < 2 || d.state !== 'running') return null
      return (await serviceStatus({ refresh: true }, paths)).dbs[0].health
    }, 20_000)
    assert.equal(health.ok, false)
    assert.match(health.problems.join('\n'), /exited \d+ times/)
    a.db.close()
  })

  test('a duplicate is ignored, a new destination is refused, changed settings restart', async () => {
    const { home, paths, opts } = make()
    const a = makeDb(home, 'a.db')
    await registerDatabase(opts(a), paths)
    const before = (await serviceStatus({}, paths)).dbs[0].pid

    assert.equal((await registerDatabase(opts(a), paths)).status, 'unchanged')
    assert.equal((await serviceStatus({}, paths)).dbs[0].pid, before)

    await assert.rejects(registerDatabase(opts(a, 'elsewhere'), paths), /already replicated to file:\/\//)

    const updated = await registerDatabase({ ...opts(a), syncInterval: '2s' }, paths)
    assert.equal(updated.status, 'updated')
    const after = (await serviceStatus({}, paths)).dbs[0]
    assert.notEqual(after.pid, before)
    assert.equal(after.state, 'running')
    assert.equal(alive(before), false)
    a.db.close()
  })

  test('two clients racing to start it get one service', async () => {
    const { home, paths, opts } = make()
    const dbs = [makeDb(home, 'a.db'), makeDb(home, 'b.db')]
    const client = (o) =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `import { registerDatabase } from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)}
             import { servicePaths } from ${JSON.stringify(new URL('../dist/paths.js', import.meta.url).href)}
             const r = await registerDatabase(${JSON.stringify(o)}, servicePaths(${JSON.stringify(home)}))
             console.log(r.status)`,
          ],
          { stdio: ['ignore', 'pipe', 'inherit'] },
        )
        let out = ''
        child.stdout.on('data', (d) => {
          out += d
        })
        child.on('exit', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`client exited ${code}`))))
      })
    const results = await Promise.all(dbs.map((d) => client(opts(d))))
    assert.deepEqual(results, ['started', 'started'])

    const status = await serviceStatus({}, paths)
    assert.equal(status.dbs.length, 2)
    assert.equal(Number(readFileSync(paths.lock, 'utf8')), status.pid)
    await sleep(500)
    assert.deepEqual(servicePids(home), [status.pid])
    for (const d of dbs) d.db.close()
  })

  test('a crashed replicator is restarted', async () => {
    const { home, paths, opts } = make()
    const a = makeDb(home, 'a.db')
    await registerDatabase(opts(a), paths)
    const first = (await serviceStatus({}, paths)).dbs[0].pid
    process.kill(first, 'SIGKILL')
    const db = await until(async () => {
      const d = (await serviceStatus({}, paths)).dbs[0]
      return d.state === 'running' && d.pid !== first ? d : null
    })
    assert.equal(db.restarts, 1)
    a.db.close()
  })

  test('another replicator on the same database is stopped first', async () => {
    const { home, paths, opts } = make()
    const a = makeDb(home, 'a.db')
    const config = join(home, 'litestream-old-sidecar.yml')
    writeFileSync(
      config,
      `dbs:\n  - path: ${a.path}\n    replicas:\n      - type: file\n        path: ${join(home, 'old-replica')}\n`,
    )
    const foreign = spawn('litestream', ['replicate', '-config', config], { stdio: 'ignore' })
    try {
      await until(() => alive(foreign.pid))
      await sleep(500)

      await registerDatabase(opts(a), paths)
      await until(() => foreign.exitCode !== null || foreign.signalCode !== null)
      assert.equal((await serviceStatus({}, paths)).dbs[0].state, 'running')
    } finally {
      foreign.kill('SIGKILL')
      a.db.close()
    }
  })

  test('registrations survive a service restart', async () => {
    const { home, paths, opts } = make()
    const a = makeDb(home, 'a.db')
    await registerDatabase(opts(a), paths)
    assert.equal(await stopService(paths), true)
    assert.equal(await serviceStatus({}, paths), null)

    const b = makeDb(home, 'b.db')
    await registerDatabase(opts(b), paths)
    const status = await serviceStatus({}, paths)
    assert.deepEqual(status.dbs.map((d) => d.dbPath.split('/').pop()).sort(), ['a.db', 'b.db'])
    assert.ok(status.dbs.every((d) => d.state === 'running'))
    a.db.close()
    b.db.close()
  })

  test('a registration that starts the service while it resumes gets one replicator', async () => {
    const { home, paths, opts } = make()
    const dbs = ['a.db', 'b.db', 'c.db', 'd.db', 'e.db'].map((n) => makeDb(home, n))
    for (const db of dbs) await registerDatabase(opts(db), paths)
    assert.equal(await stopService(paths), true)

    // The last database resumes last, so this registration lands mid-resume.
    await registerDatabase(opts(dbs.at(-1)), paths)
    await sleep(3000)
    const replicators = execFileSync('ps', ['-axo', 'args='], { encoding: 'utf8' })
      .split('\n')
      .filter((l) => /litestream\S*\s+replicate\b/.test(l) && l.includes(paths.dbDir) && l.includes('/e.db-'))
    assert.equal(replicators.length, 1, replicators.join('\n'))
    for (const db of dbs) db.db.close()
  })

  test('unregistering the last database stops the service', async () => {
    const { home, paths, opts } = make()
    const a = makeDb(home, 'a.db')
    await registerDatabase(opts(a), paths)
    const { pid, dbs } = await serviceStatus({}, paths)
    assert.equal((await unregisterDatabase(a.path, paths)).status, 'removed')
    await until(() => !alive(pid))
    assert.equal(alive(dbs[0].pid), false)
    assert.equal(existsSync(paths.socket), false)
    assert.equal(existsSync(paths.lock), false)
    a.db.close()
  })

  test('a lock left by a dead process does not block startup', async () => {
    const { home, paths, opts } = make()
    const dead = spawn(process.execPath, ['-e', ''])
    await new Promise((r) => dead.on('exit', r))
    writeFileSync(paths.lock, String(dead.pid))

    const a = makeDb(home, 'a.db')
    assert.equal((await registerDatabase(opts(a), paths)).status, 'started')
    const status = await serviceStatus({}, paths)
    assert.equal(Number(readFileSync(paths.lock, 'utf8')), status.pid)
    a.db.close()
  })

  test('a service whose socket file was removed listens again', async () => {
    const { home, paths, opts } = make()
    const a = makeDb(home, 'a.db')
    await registerDatabase(opts(a), paths)
    const { pid } = await serviceStatus({}, paths)
    rmSync(paths.socket)
    await until(() => existsSync(paths.socket), 15_000)
    const status = await serviceStatus({}, paths)
    assert.equal(status.pid, pid)
    assert.equal(status.dbs[0].state, 'running')
    a.db.close()
  })

  test('a lock held by a live service is respected', async () => {
    const { home, paths, opts } = make()
    const a = makeDb(home, 'a.db')
    await registerDatabase(opts(a), paths)
    const { pid } = await serviceStatus({}, paths)

    const second = spawn(process.execPath, [new URL('../dist/cli.js', import.meta.url).pathname, 'serve'], {
      env: { ...process.env, PURECONTEXT_LITESTREAM_HOME: home },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let err = ''
    second.stderr.on('data', (d) => {
      err += d
    })
    const code = await new Promise((r) => second.on('exit', r))
    assert.equal(code, 0)
    assert.match(err, /already running/)
    assert.equal((await serviceStatus({}, paths)).pid, pid)
    a.db.close()
  })

  test('a second database sent to a replica already in use is refused', async () => {
    const { home, paths, opts } = make()
    const a = makeDb(home, 'a.db')
    const b = makeDb(home, 'b.db')
    await registerDatabase(opts(a), paths)
    // A copied clone: its own database, the original's replica path.
    await assert.rejects(registerDatabase({ ...opts(a), dbPath: b.path }, paths), /already receives .*a\.db/)
    const status = await serviceStatus({}, paths)
    assert.deepEqual(
      status.dbs.map((d) => d.dbPath.split('/').pop()),
      ['a.db'],
    )
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(paths.registry, 'utf8')).dbs).map((p) => p.split('/').pop()), [
      'a.db',
    ])
    a.db.close()
    b.db.close()
  })

  test('a failed process scan starts no replicator and is retried', async () => {
    const { home, paths, opts } = make()
    const a = makeDb(home, 'a.db')
    const stub = join(home, 'bin')
    const flag = join(home, 'ps-fails')
    mkdirSync(stub)
    writeFileSync(flag, '')
    writeFileSync(join(stub, 'ps'), `#!/bin/sh\nif [ -f '${flag}' ]; then echo 'ps: broken' >&2; exit 1; fi\nexec /bin/ps "$@"\n`, {
      mode: 0o755,
    })
    const savedPath = process.env.PATH
    process.env.PATH = `${stub}:${savedPath}`
    try {
      assert.equal((await registerDatabase(opts(a), paths)).status, 'started')
    } finally {
      process.env.PATH = savedPath
    }
    const failed = await until(async () => {
      const d = (await serviceStatus({}, paths)).dbs[0]
      return d.lastError ? d : null
    })
    assert.equal(failed.state, 'backoff')
    assert.equal(failed.pid, null)
    assert.match(failed.lastError.message, /cannot list processes/)
    const replicators = execFileSync('/bin/ps', ['-axo', 'args='], { encoding: 'utf8' })
      .split('\n')
      .filter((l) => /litestream\S*\s+replicate\b/.test(l) && l.includes(paths.dbDir))
    assert.deepEqual(replicators, [])

    rmSync(flag)
    const running = await until(async () => {
      const d = (await serviceStatus({}, paths)).dbs[0]
      return d.state === 'running' ? d : null
    })
    assert.ok(alive(running.pid))
    a.db.close()
  })

  test('a database whose file is gone is dropped at the next check', async () => {
    const { home, paths, opts } = make()
    const a = makeDb(home, 'a.db')
    const b = makeDb(home, 'b.db')
    await registerDatabase(opts(a), paths)
    await registerDatabase(opts(b), paths)
    const gone = (await serviceStatus({}, paths)).dbs.find((d) => d.dbPath.endsWith('/b.db'))
    await until(() => existsSync(gone.configPath.replace(/\.yml$/, '.log')))

    b.db.close()
    for (const suffix of ['', '-wal', '-shm']) rmSync(b.path + suffix, { force: true })
    const status = await serviceStatus({ refresh: true }, paths)
    assert.deepEqual(
      status.dbs.map((d) => d.dbPath.split('/').pop()),
      ['a.db'],
    )
    assert.equal(alive(gone.pid), false)
    assert.ok(!Object.keys(JSON.parse(readFileSync(paths.registry, 'utf8')).dbs).some((p) => p.endsWith('/b.db')))
    assert.deepEqual(
      readdirSync(paths.dbDir).filter((f) => f.startsWith('b.db-')),
      [],
    )
    a.db.close()
  })

  test('a database whose file is gone is dropped when the service resumes', async () => {
    const { home, paths, opts } = make()
    const a = makeDb(home, 'a.db')
    await registerDatabase(opts(a), paths)
    assert.equal(await stopService(paths), true)
    a.db.close()
    for (const suffix of ['', '-wal', '-shm']) rmSync(a.path + suffix, { force: true })

    const c = makeDb(home, 'c.db')
    await registerDatabase(opts(c), paths)
    const status = await serviceStatus({}, paths)
    assert.deepEqual(
      status.dbs.map((d) => d.dbPath.split('/').pop()),
      ['c.db'],
    )
    assert.deepEqual(
      readdirSync(paths.dbDir).filter((f) => f.startsWith('a.db-')),
      [],
    )
    await assert.rejects(registerDatabase(opts({ path: join(home, 'never.db') }), paths), /does not exist/)
    c.db.close()
  })

  test('a database never checked, or missing from litestream status, is not ok', async () => {
    const { home, paths, opts } = make()
    const a = makeDb(home, 'a.db')
    const real = execFileSync('which', ['litestream'], { encoding: 'utf8' }).trim()
    const wrapper = join(home, 'litestream')
    writeFileSync(wrapper, `#!/bin/sh\nif [ "$1" = status ]; then echo '[]'; exit 0; fi\nexec ${real} "$@"\n`, {
      mode: 0o755,
    })
    process.env.LITESTREAM_BIN = wrapper
    try {
      await registerDatabase(opts(a), paths)
    } finally {
      Reflect.deleteProperty(process.env, 'LITESTREAM_BIN')
    }
    const unchecked = await serviceStatus({}, paths)
    assert.equal(unchecked.dbs[0].health, null)
    assert.equal(unchecked.ok, false)

    const checked = await serviceStatus({ refresh: true }, paths)
    assert.equal(checked.ok, false)
    assert.equal(checked.dbs[0].health.ok, false)
    assert.match(checked.dbs[0].health.problems.join('\n'), /no row for this database/)
    a.db.close()
  })

  test('a start that fails after the registration is saved is retried', async () => {
    const { home, paths, opts } = make()
    const a = makeDb(home, 'a.db')
    const b = makeDb(home, 'b.db')
    await registerDatabase(opts(a), paths)
    // The replicator's config cannot be written, so its start throws.
    chmodSync(paths.dbDir, 0o500)
    try {
      assert.equal((await registerDatabase(opts(b), paths)).status, 'started')
      const failed = (await serviceStatus({}, paths)).dbs.find((d) => d.dbPath.endsWith('/b.db'))
      assert.equal(failed.state, 'backoff')
      assert.match(failed.lastError.message, /EACCES/)
    } finally {
      chmodSync(paths.dbDir, 0o700)
    }
    const running = await until(async () => {
      const d = (await serviceStatus({}, paths)).dbs.find((x) => x.dbPath.endsWith('/b.db'))
      return d.state === 'running' ? d : null
    })
    assert.ok(alive(running.pid))
    a.db.close()
    b.db.close()
  })

  test('a registration racing the last unregister is kept', async () => {
    const { home, paths, opts } = make()
    for (let round = 0; round < 3; round++) {
      const a = makeDb(home, `a${round}.db`)
      const b = makeDb(home, `b${round}.db`)
      await registerDatabase(opts(a), paths)
      const [removed, registered] = await Promise.all([
        unregisterDatabase(a.path, paths),
        registerDatabase(opts(b), paths),
      ])
      assert.equal(removed.status, 'removed')
      assert.equal(registered.status, 'started')
      const status = await until(async () => {
        const s = await serviceStatus({}, paths)
        return s?.dbs.some((d) => d.dbPath === registered.dbPath && d.state === 'running') ? s : null
      })
      assert.ok(alive(status.pid))
      assert.equal((await unregisterDatabase(b.path, paths)).status, 'removed')
      await until(async () => (await serviceStatus({}, paths)) === null)
      a.db.close()
      b.db.close()
    }
  })
})

describe('sidecar config', () => {
  let config
  before(async () => {
    config = await import('../dist/config.js')
  })

  test('a file replica needs no credentials', () => {
    assert.deepEqual(config.missingCredentials({ dbPath: '/x.db', replicaPath: '/r', replicaType: 'file' }), [])
    assert.match(config.generateConfig([{ dbPath: '/x.db', replicaPath: '/r', replicaType: 'file' }]), /type: file\n\s+path: \/r/)
  })

  test('an s3 replica without credentials is reported', () => {
    const saved = { ...process.env }
    for (const k of Object.keys(process.env)) if (k.startsWith('LITESTREAM_')) delete process.env[k]
    try {
      assert.deepEqual(config.missingCredentials({ dbPath: '/x.db', replicaPath: 'r' }), [
        'bucket',
        'endpoint',
        'accessKeyId',
        'secretAccessKey',
      ])
    } finally {
      Object.assign(process.env, saved)
    }
  })
})
