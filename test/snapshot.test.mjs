import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, describe, test } from 'node:test'
import { gunzipSync } from 'node:zlib'
import { registerDatabase, serviceStatus, stopService } from '../dist/index.js'
import { servicePaths } from '../dist/paths.js'
import {
  listSnapshots,
  loadSnapshotConfig,
  selectKept,
  snapshotDue,
  snapshotFolder,
  snapshotProblems,
  takeSnapshot,
  verifyDatabase,
} from '../dist/snapshot.js'

const isolatedHome = mkdtempSync(join(tmpdir(), 'pls-default-'))
process.env.PURECONTEXT_LITESTREAM_HOME = isolatedHome
const scratch = mkdtempSync(join(tmpdir(), 'pls-snap-'))
process.on('exit', () => {
  rmSync(isolatedHome, { recursive: true, force: true })
  rmSync(scratch, { recursive: true, force: true })
})

let n = 0
const dir = () => {
  const d = join(scratch, String(n++))
  mkdirSync(d, { recursive: true })
  return d
}

function makeDb(path, rows = 200) {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
  const insert = db.prepare('INSERT INTO t (v) VALUES (?)')
  for (let i = 0; i < rows; i++) insert.run(`row ${i} ${'x'.repeat(200)}`)
  return db
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(check, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await sleep(200)
  }
  throw new Error('condition not met in time')
}

const local = (y, m, d, h = 12) => new Date(y, m - 1, d, h)
const key = (t) =>
  `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`

describe('rotation', () => {
  test('keeps the newest of each recent day, week and month', () => {
    // One snapshot a day for a year, ending Wednesday Oct 21 2026.
    const times = []
    for (
      let d = new Date(2025, 9, 22, 12);
      d <= local(2026, 10, 21);
      d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 12)
    ) {
      times.push(d)
    }
    const kept = [...selectKept(times, { daily: 7, weekly: 4, monthly: 6 })].map((i) => key(times[i])).sort()
    assert.deepEqual(kept, [
      '2026-05-31',
      '2026-06-30',
      '2026-07-31',
      '2026-08-31',
      '2026-09-30',
      // Newest of the weeks starting Sep 28 and Oct 5
      '2026-10-04',
      '2026-10-11',
      '2026-10-15',
      '2026-10-16',
      '2026-10-17',
      '2026-10-18',
      '2026-10-19',
      '2026-10-20',
      '2026-10-21',
    ])
  })

  test('keeps only the newest snapshot of a day, and a tier set to zero keeps nothing', () => {
    const times = [local(2026, 10, 21, 1), local(2026, 10, 21, 23), local(2026, 10, 20, 9)]
    assert.deepEqual([...selectKept(times, { daily: 1, weekly: 0, monthly: 0 })], [1])
    assert.deepEqual([...selectKept(times, { daily: 0, weekly: 0, monthly: 1 })], [1])
  })
})

describe('config', () => {
  const write = (body) => {
    const path = join(dir(), 'backup.json')
    writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body))
    return path
  }

  test('a missing file or section means off', () => {
    assert.deepEqual(loadSnapshotConfig(join(scratch, 'nope.json')), { state: 'off' })
    assert.deepEqual(loadSnapshotConfig(write({})), { state: 'off' })
  })

  test('fills defaults for what is left out', () => {
    assert.deepEqual(loadSnapshotConfig(write({ snapshots: { destination: '/backups' } })), {
      state: 'on',
      settings: { destination: '/backups', keep: { daily: 7, weekly: 4, monthly: 6 }, restoreCheckDays: 7 },
    })
  })

  test('refuses a relative destination, a bad count, keeping nothing, and broken JSON', () => {
    for (const body of [
      { snapshots: { destination: 'backups' } },
      { snapshots: { destination: '/b', keep: { daily: -1 } } },
      { snapshots: { destination: '/b', keep: { daily: 1.5 } } },
      { snapshots: { destination: '/b', keep: { daily: 0, weekly: 0, monthly: 0 } } },
      { snapshots: { destination: '/b', restoreCheckDays: 'weekly' } },
      '{ not json',
    ]) {
      assert.equal(loadSnapshotConfig(write(body)).state, 'invalid', JSON.stringify(body))
    }
  })
})

describe('snapshots', () => {
  test('a damaged database fails verification', async () => {
    const path = join(dir(), 'damaged.db')
    makeDb(path, 2000).close()
    await verifyDatabase(path)
    const fd = openSync(path, 'r+')
    writeSync(fd, Buffer.alloc(4096, 0xab), 0, 4096, 4096 * 3)
    closeSync(fd)
    await assert.rejects(verifyDatabase(path))
  })

  test('damage SQLite reads without error is still caught by the integrity check', async () => {
    const path = join(dir(), 'skewed.db')
    const db = makeDb(path)
    // An index whose definition no longer matches its entries: every query
    // still works, and only the integrity check's findings reveal it.
    db.exec(`CREATE INDEX i ON t(v); PRAGMA writable_schema = ON;
      UPDATE sqlite_master SET sql = 'CREATE INDEX i ON t(id)' WHERE name = 'i'`)
    db.close()
    const check = new DatabaseSync(path, { readOnly: true })
    assert.equal(check.prepare('SELECT count(*) AS n FROM t').get().n, 200)
    check.close()
    await assert.rejects(verifyDatabase(path), /integrity check failed/)
  })

  test('lands a whole, compressed, restorable copy and rotates old ones', async () => {
    const d = dir()
    const dbPath = join(d, 'live.db')
    const live = makeDb(dbPath)
    const destination = join(d, 'dest')
    const settings = { destination, keep: { daily: 2, weekly: 0, monthly: 0 }, restoreCheckDays: 7 }
    const folder = snapshotFolder(destination, dbPath)

    await takeSnapshot(dbPath, settings, join(d, 'work'), new Date('2026-10-19T12:00:00Z'))
    await takeSnapshot(dbPath, settings, join(d, 'work'), new Date('2026-10-20T12:00:00Z'))
    live.prepare('INSERT INTO t (v) VALUES (?)').run('after')
    const newest = await takeSnapshot(dbPath, settings, join(d, 'work'), new Date('2026-10-21T12:00:00Z'))

    const files = listSnapshots(folder)
    assert.deepEqual(
      files.map((f) => f.at),
      ['2026-10-20T12:00:00.000Z', '2026-10-21T12:00:00.000Z'],
      'the oldest falls out of a two-day rotation',
    )
    assert.equal(newest.path, files[1].path)
    assert.ok(readdirSync(folder).every((name) => !name.endsWith('.partial')))
    assert.deepEqual(readdirSync(join(d, 'work')), [])
    assert.deepEqual(JSON.parse(readFileSync(join(folder, 'source.json'), 'utf8')), { dbPath })

    const restored = join(d, 'restored.db')
    writeFileSync(restored, gunzipSync(readFileSync(newest.path)))
    await verifyDatabase(restored)
    const copy = new DatabaseSync(restored, { readOnly: true })
    assert.equal(copy.prepare('SELECT count(*) AS n FROM t').get().n, 201)
    copy.close()
    live.close()
  })

  test('a damaged database lands nothing', async () => {
    const d = dir()
    const dbPath = join(d, 'damaged.db')
    makeDb(dbPath, 2000).close()
    const fd = openSync(dbPath, 'r+')
    writeSync(fd, Buffer.alloc(4096, 0xab), 0, 4096, 4096 * 3)
    closeSync(fd)
    const destination = join(d, 'dest')
    const settings = { destination, keep: { daily: 7, weekly: 0, monthly: 0 }, restoreCheckDays: 0 }
    await assert.rejects(takeSnapshot(dbPath, settings, join(d, 'work')))
    assert.deepEqual(listSnapshots(snapshotFolder(destination, dbPath)), [])
  })

  test('is due once per local day', async () => {
    const d = dir()
    const dbPath = join(d, 'live.db')
    makeDb(dbPath).close()
    const settings = { destination: join(d, 'dest'), keep: { daily: 7, weekly: 0, monthly: 0 }, restoreCheckDays: 0 }
    const folder = snapshotFolder(settings.destination, dbPath)
    const now = local(2026, 10, 21, 15)
    assert.equal(snapshotDue(folder, now), true)
    await takeSnapshot(dbPath, settings, join(d, 'work'), local(2026, 10, 20, 15))
    assert.equal(snapshotDue(folder, now), true)
    await takeSnapshot(dbPath, settings, join(d, 'work'), local(2026, 10, 21, 1))
    assert.equal(snapshotDue(folder, now), false)
  })

  test('problems are judged from the destination', async () => {
    const d = dir()
    const dbPath = join(d, 'live.db')
    makeDb(dbPath).close()
    const settings = { destination: join(d, 'dest'), keep: { daily: 7, weekly: 0, monthly: 0 }, restoreCheckDays: 0 }
    const folder = snapshotFolder(settings.destination, dbPath)
    const now = Date.parse('2026-10-21T12:00:00Z')
    assert.deepEqual(snapshotProblems(folder, null, null, now - 1000, now), [], 'a new service has had no chance yet')
    assert.match(snapshotProblems(folder, null, null, now - 48 * 3_600_000, now)[0], /no snapshot has reached/)
    await takeSnapshot(dbPath, settings, join(d, 'work'), new Date('2026-10-19T12:00:00Z'))
    assert.match(snapshotProblems(folder, null, null, 0, now)[0], /48 h old/)
    await takeSnapshot(dbPath, settings, join(d, 'work'), new Date('2026-10-21T11:00:00Z'))
    assert.deepEqual(snapshotProblems(folder, null, null, 0, now), [])
    assert.match(snapshotProblems(folder, { at: '', message: 'disk full' }, null, 0, now)[0], /disk full/)
    assert.match(
      snapshotProblems(folder, null, { at: '', ok: false, detail: 'restore failed: x' }, 0, now)[0],
      /restore check failed/,
    )
  })
})

let hasBinary = true
try {
  execFileSync('litestream', ['version'])
} catch {
  hasBinary = false
}

describe('service snapshots', { skip: !hasBinary && 'litestream binary not installed' }, () => {
  const homes = []
  after(async () => {
    for (const home of homes) await stopService(servicePaths(home)).catch(() => {})
  })

  test('takes a snapshot and passes a restore check, and reports both', async () => {
    const d = dir()
    const home = mkdtempSync(join(tmpdir(), 'pls-'))
    homes.push(home)
    const paths = servicePaths(home)
    const dbPath = join(d, 'live.db')
    const live = makeDb(dbPath)
    const destination = join(d, 'dest')
    const config = join(d, 'backup.json')
    writeFileSync(config, JSON.stringify({ snapshots: { destination, keep: { daily: 3 }, restoreCheckDays: 7 } }))

    const env = {
      PURECONTEXT_BACKUP_CONFIG: config,
      PURECONTEXT_BACKUP_SNAPSHOT_FIRST_MS: '300',
      PURECONTEXT_BACKUP_SNAPSHOT_MS: '500',
      PURECONTEXT_LITESTREAM_SETTLE_MS: '1500',
    }
    Object.assign(process.env, env)
    try {
      await registerDatabase({ dbPath, replicaType: 'file', replicaPath: join(home, 'replica', 'live.db') }, paths)
    } finally {
      for (const k of Object.keys(env)) Reflect.deleteProperty(process.env, k)
    }

    const status = await until(async () => {
      const s = await serviceStatus({}, paths)
      return s?.dbs[0]?.snapshot?.newest && s.dbs[0].snapshot.restoreCheck ? s : null
    })
    assert.equal(status.snapshots.state, 'on')
    assert.equal(status.snapshots.destination, destination)
    const snap = status.dbs[0].snapshot
    assert.equal(snap.kept, 1)
    assert.ok(statSync(snap.newest.path).size > 0)
    assert.equal(snap.restoreCheck.ok, true, snap.restoreCheck.detail)
    assert.match(snap.restoreCheck.detail, /restored 200 rows; the live database has 200/)
    assert.deepEqual(snap.problems, [])
    assert.ok(existsSync(paths.snapshotState), 'the restore result outlives a restart')
    live.close()
  })
})
