// Storage engine tests: WAL durability/recovery, locking, compaction, indexes, blobs, backup, server.js lifecycle.
import { test, describe, after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createDb, DbLockedError, DbCorruptionError, BlobCorruptError, DbError, verifyDataDir, backupDataDir, restoreBackup } from '../src/db.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const DB_URL = pathToFileURL(path.join(ROOT, 'src', 'db.js')).href
const quiet = { info() {}, warn() {}, error() {} }
const cleanups = []
const spawned = [] // child processes; a failing test must never leave them running
const tmpdir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-db-test-')); cleanups.push(d); return d }
after(() => {
  for (const p of spawned) { try { p.kill('SIGKILL') } catch { /* already gone */ } }
  for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true })
})
const open = (dir, o = {}) => createDb(dir, { logger: quiet, fsync: 'never', ...o })
const names = (dir, re) => fs.readdirSync(dir).filter((n) => re.test(n)).sort()
const lastWal = (dir) => path.join(dir, names(dir, /^wal-\d{10}\.log$/).at(-1))
const lastSnap = (dir) => path.join(dir, names(dir, /^snapshot-\d{10}\.rds$/).at(-1))
/** Everything in the db as plain JSON, for exact before/after comparisons (order included). */
const dump = (db) => JSON.parse(JSON.stringify(Object.fromEntries(db.collections().filter((c) => db.count(c)).sort().map((c) => [c, db.find(c)]))))
/** What the disk looks like after a crash: all files written so far, minus the lock. */
function crashCopy(dir) {
  const dst = tmpdir()
  fs.cpSync(dir, dst, { recursive: true, filter: (s) => path.basename(s) !== 'LOCK' })
  return dst
}
const flipByte = (file, at) => { const b = fs.readFileSync(file); b[at] ^= 0xff; fs.writeFileSync(file, b) }
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
/** Runs code in a child node process that imports the engine. */
function child(code, env = {}) {
  const guard = 'process.stdin.on(\'end\', () => process.exit(0)); process.stdin.resume();' // exit if the test process dies
  const p = spawn(process.execPath, ['--input-type=module', '-e', `import * as E from ${JSON.stringify(DB_URL)};\n${guard}\n${code}`], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  spawned.push(p)
  p.out = ''
  p.err = ''
  p.stdout.on('data', (d) => { p.out += d })
  p.stderr.on('data', (d) => { p.err += d })
  p.exited = new Promise((r) => p.on('exit', (code, signal) => r({ code, signal })))
  p.waitFor = (re, ms = 15000) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${re}; stdout=${p.out} stderr=${p.err}`)), ms)
    const check = () => { if (typeof re === 'function' ? re(p.out) : re.test(p.out)) { clearTimeout(t); resolve() } }
    p.stdout.on('data', check)
    check()
  })
  return p
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** Polls until fn() is truthy (machines running many test suites at once are slow; never rely on a fixed sleep). */
async function waitUntil(fn, ms = 8000, what = 'condition') {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await fn()) return; await sleep(10) }
  throw new Error(`timed out waiting for ${what}`)
}

describe('document API (memory mode keeps the original semantics)', () => {
  test('insert/get/find/findOne/update/remove/removeWhere/id', () => {
    const db = createDb()
    const a = db.insert('things', { name: 'a', n: 1 })
    const b = db.insert('things', { name: 'b', n: 2 })
    assert.match(a.id, /^thi_[0-9a-f]{16}$/)
    assert.ok(Date.parse(a.createdAt))
    assert.equal(db.get('things', a.id), a, 'get returns the live row')
    assert.equal(db.get('things', 'nope'), null)
    assert.equal(db.get('nocol', 'x'), null)
    assert.deepEqual(db.find('things').map((r) => r.name), ['a', 'b'], 'insertion order')
    assert.deepEqual(db.find('things', (r) => r.n > 1), [b])
    assert.equal(db.findOne('things', (r) => r.name === 'b'), b)
    assert.equal(db.findOne('things', () => false), null)
    assert.deepEqual(db.find('missing'), [])
    const u = db.update('things', a.id, { n: 5, extra: true })
    assert.equal(u, a, 'update returns the live row')
    assert.equal(a.n, 5)
    assert.ok(a.updatedAt)
    assert.equal(db.update('things', 'nope', { n: 1 }), null)
    assert.equal(db.remove('things', a.id), true)
    assert.equal(db.remove('things', a.id), false)
    db.insert('things', { name: 'c', n: 3 })
    db.insert('things', { name: 'd', n: 4 })
    assert.equal(db.removeWhere('things', (r) => r.n >= 3), 2)
    assert.deepEqual(db.find('things'), [b])
    assert.equal(db.removeWhere('nothing', () => true), 0)
    assert.match(db.id('blob'), /^blob_[0-9a-f]{16}$/)
    assert.notEqual(db.id('x'), db.id('x'))
    assert.ok(db.collections().includes('users'), 'core collections exist')
  })

  test('explicit ids and createdAt are honoured; duplicate ids are rejected', () => {
    const db = createDb()
    const r = db.insert('c', { id: 'fixed', createdAt: '2020-01-01T00:00:00.000Z', v: 1 })
    assert.equal(r.id, 'fixed')
    assert.equal(r.createdAt, '2020-01-01T00:00:00.000Z')
    assert.throws(() => db.insert('c', { id: 'fixed' }), { code: 'EDBDUPLICATE' })
    assert.equal(db.count('c'), 1)
    const s = db.insert('c', { id: undefined, createdAt: undefined })
    assert.match(s.id, /^c_/)
    assert.ok(s.createdAt)
    assert.throws(() => db.insert('c', { id: {} }), TypeError)
    assert.throws(() => db.insert('c', { id: '' }), TypeError)
    assert.equal(db.insert('c', { id: 7 }).id, 7)
    assert.equal(db.get('c', 7).id, 7)
  })

  test('update never changes the id, undefined unsets a field, patch must be an object', () => {
    const db = createDb()
    const r = db.insert('c', { a: 1, b: 2 })
    const id = r.id
    db.update('c', id, { id: 'hijack', a: undefined, b: 3, __proto__: { polluted: true }, ['__proto__']: 'x' })
    assert.equal(r.id, id)
    assert.equal(db.get('c', id), r)
    assert.equal('a' in r, false)
    assert.equal(r.b, 3)
    assert.equal(Object.getPrototypeOf(r), Object.prototype)
    assert.equal(db.update('c', id, undefined), r, 'empty patch only touches updatedAt')
    assert.throws(() => db.update('c', id, 'str'), TypeError)
    assert.throws(() => db.update('c', id, [1]), TypeError)
  })

  test('input validation: collection names, documents, predicates', () => {
    const db = createDb()
    for (const bad of ['', 'a b', '../x', 'a/b', 'x'.repeat(200), 5, null, undefined, '__proto__ ']) assert.throws(() => db.insert(bad, {}), TypeError, String(bad))
    assert.throws(() => db.insert('c', 'str'), TypeError)
    assert.throws(() => db.insert('c', [1]), TypeError)
    assert.throws(() => db.removeWhere('c'), TypeError, 'a missing predicate must not wipe the collection')
    assert.doesNotThrow(() => db.insert('c'), 'undefined doc is allowed (id + createdAt only)')
    assert.throws(() => db.insert('c', { big: 1n }), TypeError, 'JSON-unsafe values fail loudly before any state change')
    assert.equal(db.count('c'), 1)
    const cyc = {}
    cyc.self = cyc
    assert.throws(() => db.insert('c', cyc), TypeError)
    assert.equal(db.count('c'), 1)
  })

  test('predicate gets (row, index); mutating the collection from a predicate is safe', () => {
    const db = createDb()
    for (let i = 0; i < 5; i++) db.insert('c', { i })
    assert.deepEqual(db.find('c', (r, idx) => idx % 2 === 0).map((r) => r.i), [0, 2, 4])
    const seen = []
    db.find('c', (r) => { seen.push(r.i); if (r.i === 1) db.remove('c', r.id); return true })
    assert.equal(db.count('c'), 4)
  })

  test('record size is bounded', () => {
    const db = createDb()
    assert.throws(() => db.insert('c', { s: 'x'.repeat(65 * 1024 * 1024) }), RangeError)
    assert.equal(db.count('c'), 0)
  })

  test('a closed in-memory db still reads but refuses writes', () => {
    const db = createDb()
    const r = db.insert('c', { a: 1 })
    db.close()
    db.close()
    assert.equal(db.get('c', r.id), r)
    assert.throws(() => db.insert('c', {}), { code: 'EDBCLOSED' })
  })
})

describe('persistence and write-ahead log', () => {
  test('state survives close/reopen, including update/remove/removeWhere/unset and order', () => {
    const dir = tmpdir()
    let db = open(dir)
    const a = db.insert('c', { n: 1, tag: 'x' })
    const b = db.insert('c', { n: 2 })
    db.insert('c', { n: 3 })
    db.insert('c', { n: 4 })
    db.update('c', a.id, { n: 10, tag: undefined, nested: { deep: [1, 2, { z: 1 }] } })
    db.remove('c', b.id)
    db.removeWhere('c', (r) => r.n === 4)
    db.insert('other', { v: 'é€😀' })
    const before = dump(db)
    db.close()
    db = open(dir)
    assert.deepEqual(dump(db), before)
    assert.equal(db.get('c', a.id).tag, undefined)
    assert.equal('tag' in db.get('c', a.id), false)
    db.close()
  })

  test('crash without close: every acknowledged write is replayed from the log', () => {
    const dir = tmpdir()
    const db = open(dir)
    for (let i = 0; i < 200; i++) db.insert('c', { i })
    db.update('c', db.find('c')[5].id, { i: 'five' })
    const before = dump(db)
    const copy = crashCopy(dir)
    const db2 = open(copy)
    assert.deepEqual(dump(db2), before)
    assert.equal(db2.stats().recovery.replayedRecords, 201)
    db2.close()
    db.close()
  })

  test('WAL lines are checksummed JSON with a gapless sequence and a header', () => {
    const dir = tmpdir()
    const db = open(dir)
    db.insert('c', { a: 1 })
    db.insert('c', { a: 2 })
    const lines = fs.readFileSync(lastWal(dir), 'utf8').trimEnd().split('\n')
    assert.equal(lines.length, 3)
    const seqs = []
    for (const l of lines) {
      const m = /^([0-9a-f]{8}) (\{.*\})$/.exec(l)
      assert.ok(m, `line framing: ${l}`)
      const { crc32 } = zlibCrc()
      assert.equal(m[1], crc32(Buffer.from(m[2])).toString(16).padStart(8, '0'))
      seqs.push(JSON.parse(m[2]).s)
    }
    assert.deepEqual(seqs, [undefined, 1, 2])
    db.close()
  })

  test('torn tail: every cut of the last record is repaired; earlier records survive; log stays usable', () => {
    const dir = tmpdir()
    const db = open(dir)
    for (let i = 0; i < 5; i++) db.insert('c', { i, pad: 'p'.repeat(20) })
    const full = fs.readFileSync(lastWal(dir))
    const lastLen = full.length - full.lastIndexOf(10, full.length - 2) - 1
    for (let cut = 1; cut < lastLen; cut++) {
      const d2 = crashCopy(dir)
      fs.truncateSync(lastWal(d2), full.length - cut)
      const db2 = open(d2)
      const expected = cut === 1 ? 5 : 4 // losing only the newline keeps a checksum-valid record
      assert.equal(db2.count('c'), expected, `cut=${cut}`)
      db2.insert('c', { i: 'after' })
      db2.close()
      const db3 = open(d2)
      assert.equal(db3.count('c'), expected + 1, `reopen cut=${cut}`)
      db3.close()
    }
    db.close()
  })

  test('torn tail: garbage (NUL block, random bytes, partial line) after valid records is discarded', () => {
    for (const tail of [Buffer.alloc(4096), crypto.randomBytes(300), Buffer.from('deadbeef {"s":4,"o":"i"'), Buffer.from('zzzz\n\n\nqqq')]) {
      const dir = tmpdir()
      const db = open(dir)
      for (let i = 0; i < 3; i++) db.insert('c', { i })
      const copy = crashCopy(dir)
      fs.appendFileSync(lastWal(copy), tail)
      const db2 = open(copy)
      assert.equal(db2.count('c'), 3)
      assert.ok(db2.stats().recovery.tornTailBytes > 0)
      db2.insert('c', { i: 3 })
      db2.close()
      const db3 = open(copy)
      assert.equal(db3.count('c'), 4)
      db3.close()
      db.close()
    }
  })

  test('torn header: an empty or half-written new log is recreated', () => {
    const dir = tmpdir()
    const db = open(dir)
    db.insert('c', { a: 1 })
    db.compact()
    for (const keep of [0, 5, 30]) {
      const copy = crashCopy(dir)
      const w = lastWal(copy)
      fs.writeFileSync(w, fs.readFileSync(w).subarray(0, keep))
      const d = open(copy)
      assert.equal(d.count('c'), 1, `keep=${keep}`)
      d.insert('c', { a: 2 })
      d.close()
      const e = open(copy)
      assert.equal(e.count('c'), 2, `keep=${keep} after reopen`)
      e.close()
    }
    db.close()
  })

  test('corruption in the middle is refused loudly (flipped byte, deleted record, swapped records, duplicate record)', () => {
    const dir = tmpdir()
    const db = open(dir)
    for (let i = 0; i < 6; i++) db.insert('c', { i })
    const lines = fs.readFileSync(lastWal(dir), 'latin1').split('\n')
    lines.pop()
    const mutate = (fn) => { const d = crashCopy(dir); fs.writeFileSync(lastWal(d), fn([...lines]).join('\n') + '\n', 'latin1'); return d }
    const cases = {
      'flipped byte': mutate((l) => { l[3] = l[3].slice(0, 20) + (l[3][20] === 'x' ? 'y' : 'x') + l[3].slice(21); return l }),
      'deleted record': mutate((l) => { l.splice(3, 1); return l }),
      'swapped records': mutate((l) => { [l[2], l[3]] = [l[3], l[2]]; return l }),
      'duplicated record': mutate((l) => { l.splice(3, 0, l[3]); return l }),
      'deleted header': mutate((l) => { l.splice(0, 1); return l }),
    }
    for (const [name, d] of Object.entries(cases)) {
      assert.throws(() => open(d), (e) => e instanceof DbCorruptionError && e.code === 'EDBCORRUPT' && /wal-/.test(e.message), name)
      assert.ok(!fs.existsSync(path.join(d, 'LOCK')), `${name}: failed open must release the lock`)
    }
    db.close()
  })

  test('RD_RECOVER=truncate: keeps everything before the damage, preserves the discarded bytes, then opens cleanly', () => {
    const dir = tmpdir()
    const db = open(dir)
    for (let i = 0; i < 6; i++) db.insert('c', { i })
    const copy = crashCopy(dir)
    const w = lastWal(copy)
    const buf = fs.readFileSync(w)
    const starts = []
    for (let i = 0; i < buf.length; i++) if (buf[i] === 10) starts.push(i + 1)
    flipByte(w, starts[2] + 12) // damage the third record (the header is line 0, starts[] holds the offsets after each newline)
    assert.throws(() => open(copy), DbCorruptionError)
    const db2 = open(copy, { recover: 'truncate' })
    assert.deepEqual(db2.find('c').map((r) => r.i), [0, 1], 'records before the damage survive')
    assert.equal(db2.stats().recovery.truncatedCorruption, true)
    assert.equal(names(copy, /\.corrupt-/).length, 1, 'discarded bytes are kept for forensics')
    db2.insert('c', { i: 'new' })
    db2.close()
    const db3 = open(copy)
    assert.deepEqual(db3.find('c').map((r) => r.i), [0, 1, 'new'])
    db3.close()
    db.close()
  })

  test('a torn tail in an older (non-final) log file is corruption, not a torn tail', () => {
    const dir = tmpdir()
    const db = open(dir, { keepGenerations: 5 })
    db.insert('c', { a: 1 })
    db.compact()
    db.insert('c', { a: 2 })
    db.compact()
    db.insert('c', { a: 3 })
    const copy = crashCopy(dir)
    const wals = names(copy, /^wal-/)
    assert.ok(wals.length >= 2, wals.join())
    // lose the newest snapshot so recovery has to replay the older log chain, then tear the end of an older log
    fs.rmSync(lastSnap(copy))
    const old = path.join(copy, wals[0])
    fs.truncateSync(old, fs.statSync(old).size - 5)
    assert.throws(() => open(copy), DbCorruptionError)
    db.close()
  })

  test('hard kill (SIGKILL) while writing loses no acknowledged write', async () => {
    const dir = tmpdir()
    const p = child(`
      const db = E.createDb(${JSON.stringify(dir)}, { logger: { info() {}, warn() {}, error() {} }, fsync: 'never' })
      for (let i = 0; i < 200000; i++) {
        const r = db.insert('c', { i, pad: 'x'.repeat(i % 50) })
        process.stdout.write(r.id + '\\n')
        if (i % 25 === 0) await new Promise((res) => setImmediate(res))
      }
    `)
    await p.waitFor((out) => out.split('\n').length > 400)
    p.kill('SIGKILL')
    const { signal } = await p.exited
    assert.equal(signal, 'SIGKILL')
    const acked = p.out.split('\n').filter((l) => /^c_[0-9a-f]{16}$/.test(l))
    assert.ok(acked.length >= 400)
    const db = open(dir)
    for (const id of acked) assert.ok(db.get('c', id), `acknowledged record ${id} survived`)
    assert.ok(db.count('c') <= acked.length + 30, 'only records the child had already written beyond what it printed')
    db.insert('c', { after: 'crash' })
    db.close()
  })
})

function zlibCrc() {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c }
  return { crc32: (buf) => { let c = -1; for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0 } }
}

describe('crash consistency (property tests)', () => {
  /** Runs a mixed workload and returns the dir plus, for every logged record, the byte offset where it ends and the full state after it. */
  function history(seed, ops = 40) {
    const rnd = mulberry32(seed)
    const dir = tmpdir()
    const db = open(dir, { compactMinBytes: 2 ** 30 })
    const marks = [{ end: db.stats().wal.bytes, state: dump(db) }]
    const rec = () => marks.push({ end: db.stats().wal.bytes, state: dump(db) })
    for (let i = 0; i < ops; i++) {
      const rows = db.find('c')
      const x = rnd()
      if (x < 0.45 || !rows.length) db.insert('c', { i, s: 'é'.repeat(i % 5), n: { deep: [i, null, 'x'] } })
      else if (x < 0.7) db.update('c', rows[Math.floor(rnd() * rows.length)].id, { v: i, gone: undefined })
      else if (x < 0.8) db.remove('c', rows[Math.floor(rnd() * rows.length)].id)
      else if (x < 0.9) db.transaction(() => { db.insert('c', { tx: i }); db.insert('d', { tx: i }); if (rows.length) db.remove('c', rows[0].id) })
      else db.removeWhere('c', (r) => r.i % 7 === 3)
      rec()
    }
    return { dir, db, marks }
  }

  test('truncating the log at EVERY byte offset recovers exactly the last complete record', () => {
    const { dir, db, marks } = history(11)
    const walName = path.basename(lastWal(dir))
    const wal = fs.readFileSync(lastWal(dir))
    const headerEnd = marks[0].end
    assert.equal(wal.length, marks.at(-1).end)
    const work = tmpdir()
    let checked = 0
    for (let cut = 0; cut <= wal.length; cut++) {
      const copy = fs.mkdtempSync(path.join(work, 'cut-'))
      fs.writeFileSync(path.join(copy, walName), wal.subarray(0, cut))
      const d = open(copy, { snapshotOnClose: false })
      // a record counts if all of it except possibly its newline made it to disk
      let k = 0
      while (k + 1 < marks.length && marks[k + 1].end - 1 <= cut) k++
      const expected = cut < headerEnd - 1 ? marks[0].state : marks[k].state
      assert.deepEqual(dump(d), expected, `cut at ${cut}/${wal.length} (expected state after record #${k})`)
      d.close()
      checked++
    }
    assert.equal(checked, wal.length + 1)
    db.close()
  })

  test('random damage to the log: the result is always an exact prefix of the history, or a loud refusal', () => {
    const rnd = mulberry32(99)
    for (const seed of [1, 2, 3]) {
      const { dir, db, marks } = history(seed, 30)
      const wal = fs.readFileSync(lastWal(dir))
      let recovered = 0
      let refused = 0
      for (let trial = 0; trial < 150; trial++) {
        const b = Buffer.from(wal)
        const kind = Math.floor(rnd() * 5)
        let damaged = b
        if (kind === 0) { damaged[Math.floor(rnd() * b.length)] ^= 1 << Math.floor(rnd() * 8) } // bit flip
        else if (kind === 1) damaged = b.subarray(0, Math.floor(rnd() * b.length)) // truncate
        else if (kind === 2) damaged = Buffer.concat([b, crypto.randomBytes(1 + Math.floor(rnd() * 200))]) // garbage tail
        else if (kind === 3) { // zero a random block
          const at = Math.floor(rnd() * b.length)
          b.fill(0, at, Math.min(b.length, at + 1 + Math.floor(rnd() * 64)))
        } else { // drop a random line
          const lines = b.toString('latin1').split('\n')
          lines.splice(1 + Math.floor(rnd() * (lines.length - 2)), 1)
          damaged = Buffer.from(lines.join('\n'), 'latin1')
        }
        const copy = crashCopy(dir)
        fs.writeFileSync(lastWal(copy), damaged)
        let d
        try { d = open(copy) } catch (e) {
          assert.ok(e instanceof DbCorruptionError, `only DbCorruptionError may escape, got ${e.stack}`)
          refused++
          continue
        }
        const got = dump(d)
        assert.ok(marks.some((m) => JSON.stringify(m.state) === JSON.stringify(got)), `kind=${kind}: recovered state is not any prefix of the history`)
        recovered++
        d.insert('c', { still: 'writable' })
        d.close()
      }
      assert.ok(recovered > 20 && refused > 10, `exercised both outcomes (recovered ${recovered}, refused ${refused})`)
      db.close()
    }
  })

  test('any single flipped bit anywhere in a snapshot is detected (never loaded silently)', () => {
    const dir = tmpdir()
    const db = open(dir, { keepGenerations: 1 })
    for (let i = 0; i < 40; i++) db.insert('c', { i, s: 'x'.repeat(i) })
    db.close()
    const snap = lastSnap(dir)
    const good = fs.readFileSync(snap)
    const rnd = mulberry32(5)
    for (let trial = 0; trial < 250; trial++) {
      const copy = tmpdir()
      const b = Buffer.from(good)
      b[Math.floor(rnd() * b.length)] ^= 1 << Math.floor(rnd() * 8)
      fs.writeFileSync(path.join(copy, path.basename(snap)), b)
      assert.throws(() => open(copy), DbCorruptionError, `trial ${trial}`)
    }
  })

  test('any single flipped bit in a blob is detected on read', () => {
    const dir = tmpdir()
    const db = open(dir)
    db.putBlob('blob_fuzz', crypto.randomBytes(300))
    const p = path.join(dir, 'blobs', fs.readdirSync(path.join(dir, 'blobs'))[0], 'blob_fuzz')
    const good = fs.readFileSync(p)
    const rnd = mulberry32(8)
    for (let trial = 0; trial < 200; trial++) {
      const b = Buffer.from(good)
      b[Math.floor(rnd() * b.length)] ^= 1 << Math.floor(rnd() * 8)
      fs.writeFileSync(p, b)
      assert.throws(() => db.getBlob('blob_fuzz'), BlobCorruptError, `trial ${trial}`)
    }
    db.close()
  })
})

describe('durability modes', () => {
  test('always fsyncs every write, never fsyncs nothing until flush, batch groups them', async () => {
    const always = open(tmpdir(), { fsync: 'always' })
    for (let i = 0; i < 5; i++) always.insert('c', { i })
    assert.ok(always.stats().wal.fsyncs >= 5)
    assert.equal(always.stats().wal.pendingFsync, false)
    always.close()

    const never = open(tmpdir(), { fsync: 'never' })
    for (let i = 0; i < 5; i++) never.insert('c', { i })
    assert.equal(never.stats().wal.fsyncs, 0)
    never.flush()
    assert.equal(never.stats().wal.fsyncs, 1, 'flush() is an explicit durability barrier even in never mode')
    never.close()

    const batch = open(tmpdir(), { fsync: 'batch', fsyncIntervalMs: 20 })
    for (let i = 0; i < 50; i++) batch.insert('c', { i })
    assert.equal(batch.stats().wal.pendingFsync, true)
    await waitUntil(() => !batch.stats().wal.pendingFsync, 8000, 'group commit')
    const s = batch.stats().wal
    assert.ok(s.fsyncs >= 1 && s.fsyncs < 50, `group commit: ${s.fsyncs} fsyncs for 50 writes`)
    batch.close()
  })

  test('RD_FSYNC / RD_* env parsing is validated', () => {
    assert.throws(() => createDb(undefined, { fsync: 'sometimes' }), /RD_FSYNC/)
    const keep = { ...process.env }
    try {
      process.env.RD_FSYNC = 'bogus'
      assert.throws(() => createDb(), /RD_FSYNC must be one of always\|batch\|never/)
      process.env.RD_FSYNC = 'ALWAYS'
      const db = createDb(tmpdir(), { logger: quiet })
      assert.equal(db.stats().fsync, 'always')
      db.close()
      process.env.RD_FSYNC = 'never'
      process.env.RD_KEEP_GENERATIONS = '0'
      assert.throws(() => createDb(), /RD_KEEP_GENERATIONS/)
      process.env.RD_KEEP_GENERATIONS = '2x'
      assert.throws(() => createDb(), /RD_KEEP_GENERATIONS/)
      delete process.env.RD_KEEP_GENERATIONS
      process.env.RD_SNAPSHOT_ON_CLOSE = 'maybe'
      assert.throws(() => createDb(), /RD_SNAPSHOT_ON_CLOSE/)
    } finally {
      for (const k of ['RD_FSYNC', 'RD_KEEP_GENERATIONS', 'RD_SNAPSHOT_ON_CLOSE']) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k] }
    }
  })

  test('a write error mid-record is rolled back: memory and log stay consistent and the db keeps working', () => {
    const dir = tmpdir()
    const db = open(dir)
    db.insert('c', { i: 0 })
    const orig = fs.writeSync
    let armed = true
    fs.writeSync = function (fd, buf, off, len, ...rest) {
      if (armed && Buffer.isBuffer(buf) && len > 20) {
        armed = false
        orig.call(fs, fd, buf, off, Math.floor(len / 2)) // half a record reaches the file...
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }) // ...then the disk fills up
      }
      return orig.call(fs, fd, buf, off, len, ...rest)
    }
    try { assert.throws(() => db.insert('c', { i: 1 }), { code: 'ENOSPC' }) } finally { fs.writeSync = orig }
    assert.equal(db.count('c'), 1, 'failed insert left no trace in memory')
    assert.equal(db.health().ok, true)
    db.insert('c', { i: 2 })
    const copy = crashCopy(dir)
    const db2 = open(copy)
    assert.deepEqual(db2.find('c').map((r) => r.i), [0, 2])
    db2.close()
    db.close()
  })

  test('an fsync failure poisons the engine: no further writes are accepted', () => {
    const dir = tmpdir()
    let fatal = null
    const db = open(dir, { fsync: 'always', onFatal: (e) => { fatal = e } })
    db.insert('c', { i: 0 })
    const orig = fs.fsyncSync
    fs.fsyncSync = () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }) }
    try { assert.throws(() => db.insert('c', { i: 1 }), { code: 'EIO' }) } finally { fs.fsyncSync = orig }
    assert.equal(db.health().ok, false)
    assert.ok(fatal && fatal.code === 'EDBFAILED')
    assert.throws(() => db.insert('c', { i: 2 }), { code: 'EDBFAILED' })
    assert.throws(() => db.update('c', db.find('c')[0].id, { x: 1 }), { code: 'EDBFAILED' })
    assert.throws(() => db.putBlob('b1', 'x'), { code: 'EDBFAILED' })
    db.close()
    assert.ok(!fs.existsSync(path.join(dir, 'LOCK')))
  })
})

describe('exclusive lock', () => {
  test('a second open of the same dir in one process is refused until the first closes (also via symlink)', () => {
    const dir = tmpdir()
    const link = path.join(tmpdir(), 'link')
    fs.symlinkSync(dir, link)
    const a = open(dir)
    assert.throws(() => open(dir), (e) => e instanceof DbLockedError && e.code === 'EDBLOCKED' && e.message.includes(String(process.pid)))
    assert.throws(() => open(link), DbLockedError)
    assert.throws(() => open(path.join(dir, '..', path.basename(dir))), DbLockedError)
    a.close()
    assert.ok(!fs.existsSync(path.join(dir, 'LOCK')))
    const b = open(link)
    b.close()
  })

  test('another process holds the lock; after kill -9 the stale lock is detected and taken over', async () => {
    const dir = tmpdir()
    const p = child(`
      const db = E.createDb(${JSON.stringify(dir)}, { logger: { info() {}, warn() {}, error() {} } })
      db.insert('c', { from: 'child' })
      process.stdout.write('READY\\n')
      setInterval(() => {}, 1000)
    `)
    await p.waitFor(/READY/)
    assert.throws(() => open(dir), (e) => e instanceof DbLockedError && e.message.includes(String(p.pid)), 'live foreign lock')
    p.kill('SIGKILL')
    await p.exited
    assert.ok(fs.existsSync(path.join(dir, 'LOCK')), 'kill -9 leaves the lock file behind')
    const db = open(dir)
    assert.equal(db.count('c'), 1, 'child data recovered from its log')
    db.close()
  })

  test('graceful exit of the owner releases the lock', async () => {
    const dir = tmpdir()
    const p = child(`const db = E.createDb(${JSON.stringify(dir)}, { logger: { info() {}, warn() {}, error() {} } }); db.insert('c', {}); process.stdout.write('READY\\n')`)
    await p.waitFor(/READY/)
    p.stdin.end() // the child process.exit()s without ever calling db.close(): the exit hook must release the lock
    await p.exited
    assert.ok(!fs.existsSync(path.join(dir, 'LOCK')))
    open(dir).close()
  })

  test('stale detection: dead pid, same pid but not held here, expired foreign lease; live foreign lease blocks; garbage', () => {
    const dir = tmpdir()
    const lockFile = path.join(dir, 'LOCK')
    const writeLock = (o, ageMs = 0) => {
      fs.writeFileSync(lockFile, typeof o === 'string' ? o : JSON.stringify({ nonce: 'abc', startedAt: new Date().toISOString(), ...o }))
      const t = new Date(Date.now() - ageMs)
      fs.utimesSync(lockFile, t, t)
    }
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.toString()
    writeLock({ pid: Number(dead), host: os.hostname() })
    open(dir).close()
    writeLock({ pid: process.pid, host: os.hostname(), nonce: 'from-a-previous-life' })
    open(dir).close()
    writeLock({ pid: 1, host: 'some-other-host' })
    assert.throws(() => open(dir), DbLockedError)
    assert.throws(() => open(dir, { lockLeaseMs: 60_000 }), DbLockedError)
    writeLock({ pid: 1, host: 'some-other-host' }, 40_000)
    open(dir, { lockLeaseMs: 30_000 }).close()
    writeLock({ pid: 1, host: 'some-other-host' }, 40_000)
    assert.throws(() => open(dir, { lockLeaseMs: 120_000 }), DbLockedError, 'lease is configurable')
    writeLock('not json at all', 60_000)
    open(dir).close()
    writeLock({ pid: 1, host: 'some-other-host' })
    const forced = open(dir, { forceUnlock: true })
    forced.close()
  })

  test('lost lock is fenced: heartbeat notices a takeover, the engine stops writing and does not delete the new owner lock', async () => {
    const dir = tmpdir()
    let fatal = null
    const db = open(dir, { lockLeaseMs: 300, onFatal: (e) => { fatal = e } })
    db.insert('c', { a: 1 })
    fs.writeFileSync(path.join(dir, 'LOCK'), JSON.stringify({ pid: 1, host: 'usurper', nonce: 'someone-else', startedAt: new Date().toISOString() }))
    await waitUntil(() => fatal, 8000, 'heartbeat to notice the takeover')
    assert.ok(fatal, 'onFatal called')
    assert.equal(db.health().ok, false)
    assert.throws(() => db.insert('c', {}), { code: 'EDBFAILED' })
    db.close()
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'LOCK'), 'utf8')).nonce, 'someone-else')
  })

  test('the heartbeat keeps the lock lease fresh', async () => {
    const dir = tmpdir()
    const db = open(dir, { lockLeaseMs: 300 })
    const t0 = fs.statSync(path.join(dir, 'LOCK')).mtimeMs
    await waitUntil(() => fs.statSync(path.join(dir, 'LOCK')).mtimeMs > t0, 8000, 'heartbeat')
    assert.ok(fs.statSync(path.join(dir, 'LOCK')).mtimeMs > t0)
    assert.throws(() => open(dir, { lockLeaseMs: 300 }), DbLockedError)
    db.close()
  })
})

describe('snapshots and compaction', () => {
  function populate(db, rnd, n = 300) {
    const cols = ['a', 'b', 'c']
    for (let i = 0; i < n; i++) {
      const c = cols[i % 3]
      const r = rnd()
      const rows = db.find(c)
      if (r < 0.55 || !rows.length) db.insert(c, { i, v: Math.floor(rnd() * 10), s: 's'.repeat(i % 7) })
      else if (r < 0.8) db.update(c, rows[Math.floor(rnd() * rows.length)].id, { v: i })
      else if (r < 0.9) db.remove(c, rows[Math.floor(rnd() * rows.length)].id)
      else { const target = Math.floor(rnd() * 10); db.removeWhere(c, (x) => x.v === target) }
    }
  }

  test('compaction keeps state identical (live, after reopen) and shrinks the log', () => {
    const dir = tmpdir()
    const db = open(dir)
    populate(db, mulberry32(7), 600)
    db.insert('blobby', { blobId: 'b1' })
    const before = dump(db)
    const walBefore = db.stats().wal.bytes
    const info = db.compact()
    assert.deepEqual(dump(db), before)
    assert.ok(db.stats().wal.bytes < walBefore / 4, 'log restarted')
    assert.equal(db.stats().wal.records, 0)
    assert.equal(db.stats().snapshot.gen, info.gen)
    db.insert('a', { post: 'compaction' })
    const before2 = dump(db)
    const copy = crashCopy(dir)
    const db2 = open(copy)
    assert.deepEqual(dump(db2), before2, 'snapshot + tail log recovers exactly')
    db2.close()
    db.close()
    const db3 = open(dir)
    assert.deepEqual(dump(db3), before2)
    db3.close()
  })

  test('snapshot lines are checksummed and the file ends with a commit marker', () => {
    const dir = tmpdir()
    const db = open(dir)
    db.insert('c', { a: 1 })
    db.compact()
    const lines = fs.readFileSync(lastSnap(dir), 'utf8').trimEnd().split('\n')
    assert.ok(lines.every((l) => /^[0-9a-f]{8} \{/.test(l)))
    const last = JSON.parse(lines.at(-1).slice(9))
    assert.equal(last.t, 'end')
    assert.match(last.sha256, /^[0-9a-f]{64}$/)
    db.close()
  })

  test('the log threshold grows with the snapshot but is clamped by compactMaxBytes (bounds replay time)', () => {
    const db = open(tmpdir(), { compactMinBytes: 1000, compactMaxBytes: 3000 })
    for (let i = 0; i < 400; i++) db.insert('c', { i, pad: 'x'.repeat(20) })
    db.compact()
    assert.ok(db.stats().snapshot.bytes > 10_000)
    assert.equal(db.stats().wal.compactThresholdBytes, 3000)
    db.close()
    const roomy = open(tmpdir(), { compactMinBytes: 1000, compactMaxBytes: 2 ** 30 })
    for (let i = 0; i < 400; i++) roomy.insert('c', { i, pad: 'x'.repeat(20) })
    roomy.compact()
    assert.equal(roomy.stats().wal.compactThresholdBytes, roomy.stats().snapshot.bytes)
    roomy.close()
  })

  test('automatic compaction triggers once the log passes the threshold', async () => {
    const dir = tmpdir()
    const db = open(dir, { compactMinBytes: 4000 })
    for (let i = 0; i < 100; i++) db.insert('c', { i, pad: 'x'.repeat(40) })
    await waitUntil(() => db.stats().compactions.count >= 1, 8000, 'automatic compaction')
    const s = db.stats()
    assert.ok(s.compactions.count >= 1, 'compacted automatically')
    const before = dump(db)
    db.close()
    const db2 = open(dir)
    assert.deepEqual(dump(db2), before)
    db2.close()
  })

  test('generations: keeps the newest N snapshots and the logs needed to reach them; older files are pruned', () => {
    const dir = tmpdir()
    const db = open(dir, { keepGenerations: 2 })
    for (let g = 0; g < 5; g++) { db.insert('c', { g }); db.compact() }
    assert.equal(names(dir, /^snapshot-/).length, 2)
    const snapGens = names(dir, /^snapshot-/).map((n) => Number(n.slice(9, 19)))
    const walGens = names(dir, /^wal-/).map((n) => Number(n.slice(4, 14)))
    assert.ok(walGens.every((g) => g >= Math.min(...snapGens)))
    db.close()
    const one = tmpdir()
    const db1 = open(one, { keepGenerations: 1 })
    for (let g = 0; g < 3; g++) { db1.insert('c', { g }); db1.compact() }
    assert.equal(names(one, /^snapshot-/).length, 1)
    assert.equal(names(one, /^wal-/).length, 1)
    db1.close()
  })

  test('close() snapshots only when there were writes; reopen then replays nothing', () => {
    const dir = tmpdir()
    let db = open(dir)
    db.insert('c', { a: 1 })
    db.close()
    assert.equal(names(dir, /^snapshot-/).length, 1)
    db = open(dir)
    assert.equal(db.stats().recovery.replayedRecords, 0)
    const snapName = names(dir, /^snapshot-/)[0]
    db.close()
    assert.deepEqual(names(dir, /^snapshot-/), [snapName], 'no writes: no new snapshot')
    db = open(dir, { snapshotOnClose: false })
    db.insert('c', { a: 2 })
    db.close()
    db = open(dir)
    assert.equal(db.stats().recovery.replayedRecords, 1)
    db.close()
  })

  test('crash during compaction: leftover tmp, snapshot without its new log, new log without snapshot', () => {
    const dir = tmpdir()
    const db = open(dir, { keepGenerations: 3 })
    for (let i = 0; i < 20; i++) db.insert('c', { i })
    db.compact()
    for (let i = 20; i < 30; i++) db.insert('c', { i })
    const expected = dump(db)

    // (a) crashed while writing the snapshot: tmp file left behind
    let copy = crashCopy(dir)
    fs.writeFileSync(path.join(copy, 'snapshot-0000000099.rds.tmp'), 'partial garbage')
    let d = open(copy)
    assert.deepEqual(dump(d), expected)
    assert.ok(!fs.existsSync(path.join(copy, 'snapshot-0000000099.rds.tmp')), 'stale tmp removed')
    d.close()

    // (b) snapshot N+1 durable but the process died before wal N+1 existed
    db.compact()
    copy = crashCopy(dir)
    const newest = names(copy, /^wal-/).at(-1)
    fs.rmSync(path.join(copy, newest))
    d = open(copy)
    assert.deepEqual(dump(d), expected)
    d.close()

    // (c) new log created (and written to) but the snapshot rename never happened
    db.insert('c', { i: 'x' })
    copy = crashCopy(dir)
    fs.rmSync(path.join(copy, names(copy, /^snapshot-/).at(-1)))
    d = open(copy)
    assert.equal(d.count('c'), 31)
    d.close()
    db.close()
  })

  test('a corrupt newest snapshot falls back to the previous generation without losing data, and is quarantined', () => {
    const dir = tmpdir()
    const db = open(dir, { keepGenerations: 2 })
    for (let i = 0; i < 30; i++) db.insert('c', { i })
    db.compact()
    for (let i = 30; i < 50; i++) db.insert('c', { i })
    db.compact()
    db.insert('c', { i: 50 })
    const expected = dump(db)
    const copy = crashCopy(dir)
    const snap = lastSnap(copy)
    flipByte(snap, 200)
    const d = open(copy)
    assert.deepEqual(dump(d), expected, 'lossless: older snapshot + log chain')
    assert.equal(d.stats().recovery.fellBackToOlderSnapshot, true)
    assert.equal(names(copy, /\.corrupt-/).length, 1)
    d.close()
    const again = open(copy)
    assert.deepEqual(dump(again), expected)
    assert.equal(again.stats().recovery.fellBackToOlderSnapshot, false, 're-anchored on a fresh snapshot')
    again.close()
    db.close()
  })

  test('snapshots with any defect are rejected: truncated, bad checksum, edited row, missing end marker', () => {
    const dir = tmpdir()
    const db = open(dir, { keepGenerations: 1 })
    for (let i = 0; i < 10; i++) db.insert('c', { i })
    db.close()
    const snap = lastSnap(dir)
    const good = fs.readFileSync(snap)
    const variants = {
      truncated: good.subarray(0, good.length - 30),
      'no end marker': good.subarray(0, good.lastIndexOf('\n', good.length - 2) + 1),
      'edited row (valid line crc recomputed is impossible without the sha)': Buffer.from(good.toString('latin1').replace('"i":3', '"i":4'), 'latin1'),
      empty: Buffer.alloc(0),
    }
    for (const [name, buf] of Object.entries(variants)) {
      const d = tmpdir()
      fs.writeFileSync(path.join(d, path.basename(snap)), buf)
      assert.throws(() => open(d), DbCorruptionError, name)
    }
  })

  test('with no usable snapshot and no complete log chain, startup refuses instead of starting empty', () => {
    const dir = tmpdir()
    const db = open(dir, { keepGenerations: 1 })
    db.insert('c', { a: 1 })
    db.compact()
    db.insert('c', { a: 2 })
    const copy = crashCopy(dir)
    flipByte(lastSnap(copy), 150)
    assert.throws(() => open(copy), (e) => e instanceof DbCorruptionError && /(log does not continue|snapshot)/.test(e.message))
    db.close()
  })
})

describe('secondary indexes', () => {
  const sameAsFind = (db, col, field, values) => {
    for (const v of values) {
      const got = db.findBy(col, field, v)
      const want = db.find(col, (r) => r[field] === v)
      assert.equal(got.length, want.length, `${col}.${field}=${String(v)} count`)
      got.forEach((r, i) => assert.equal(r, want[i], `${col}.${field}=${String(v)} same row #${i} (identity and order)`))
    }
  }

  test('lookups stay consistent across insert/update/remove/removeWhere', () => {
    const db = createDb()
    db.index('u', 'email')
    const a = db.insert('u', { email: 'a@x' })
    const b = db.insert('u', { email: 'b@x' })
    const a2 = db.insert('u', { email: 'a@x' })
    assert.deepEqual(db.findBy('u', 'email', 'a@x'), [a, a2])
    db.update('u', a.id, { email: 'c@x' })
    assert.deepEqual(db.findBy('u', 'email', 'a@x'), [a2])
    assert.deepEqual(db.findBy('u', 'email', 'c@x'), [a])
    db.remove('u', a2.id)
    assert.deepEqual(db.findBy('u', 'email', 'a@x'), [])
    db.removeWhere('u', (r) => r.email === 'b@x')
    assert.deepEqual(db.findBy('u', 'email', 'b@x'), [])
    assert.equal(db.findOneBy('u', 'email', 'c@x'), a)
    assert.equal(db.findOneBy('u', 'email', 'zzz'), null)
    db.update('u', a.id, { email: undefined })
    assert.deepEqual(db.findBy('u', 'email', undefined), [a], 'unset field is findable as undefined, like find()')
    assert.deepEqual(db.findBy('u', 'email', 'c@x'), [])
    assert.deepEqual(db.findBy('nope', 'email', 'x'), [])
    assert.deepEqual(db.findBy('u', 'id', a.id), [a])
    assert.deepEqual(db.findBy('u', 'id', 'missing'), [])
  })

  test('semantics match === exactly: NaN is never found, 0 and -0 are the same, types are distinct', () => {
    const db = createDb()
    db.index('c', 'v')
    const rows = [NaN, 0, -0, '0', null, undefined, false, 1, '1', true].map((v) => db.insert('c', { v }))
    sameAsFind(db, 'c', 'v', [NaN, 0, -0, '0', null, undefined, false, 1, '1', true, 'zz'])
    assert.deepEqual(db.findBy('c', 'v', NaN), [])
    assert.equal(db.findBy('c', 'v', 0).length, 2)
    assert.equal(rows.length, 10)
  })

  test('order matches find() even after rows move between buckets', () => {
    const db = createDb()
    db.index('c', 'g')
    const r = [1, 2, 3, 4].map((n) => db.insert('c', { g: 'x', n }))
    db.update('c', r[0].id, { g: 'y' })
    db.update('c', r[0].id, { g: 'x' }) // moved back: now last in the bucket, but first in the collection
    assert.deepEqual(db.findBy('c', 'g', 'x').map((x) => x.n), [1, 2, 3, 4])
    sameAsFind(db, 'c', 'g', ['x', 'y'])
  })

  test('property test: 4000 random operations (incl. transactions, rollbacks, bulk removes), index always equals find()', () => {
    const rnd = mulberry32(20240607)
    const dir = tmpdir()
    let db = open(dir, { compactMinBytes: 20_000 })
    const COLS = ['p', 'q']
    const domain = [0, 1, 2, 3, 'a', 'b', null, undefined, NaN, -0, true]
    for (const c of COLS) { db.index(c, 'k'); db.index(c, 'g') }
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)]
    const randomOp = () => {
      const c = pick(COLS)
      const rows = db.find(c)
      const x = rnd()
      if (x < 0.35 || !rows.length) db.insert(c, { k: pick(domain), g: pick(domain), n: Math.floor(rnd() * 100) })
      else if (x < 0.6) db.update(c, pick(rows).id, rnd() < 0.5 ? { k: pick(domain) } : { g: pick(domain), n: 1 })
      else if (x < 0.7) db.update(c, pick(rows).id, { k: undefined })
      else if (x < 0.85) db.remove(c, pick(rows).id)
      else db.removeWhere(c, (r) => r.k === pick(domain) && rnd() < 0.7)
    }
    const check = () => { for (const c of COLS) for (const f of ['k', 'g']) sameAsFind(db, c, f, domain) }
    for (let step = 0; step < 4000; step++) {
      const x = rnd()
      if (x < 0.8) randomOp()
      else {
        const before = dump(db)
        const willThrow = rnd() < 0.5
        try {
          db.transaction(() => {
            const n = 1 + Math.floor(rnd() * 6)
            for (let i = 0; i < n; i++) randomOp()
            db.transaction(() => { randomOp(); randomOp() })
            if (willThrow) throw new Error('boom')
          })
          assert.equal(willThrow, false)
        } catch (e) {
          assert.equal(e.message, 'boom')
          assert.deepEqual(dump(db), before, 'rollback restores the exact state, order included')
        }
      }
      if (step % 100 === 0) check()
      if (step === 2000) { db.close(); db = open(dir, { compactMinBytes: 20_000 }); for (const c of COLS) { db.index(c, 'k'); db.index(c, 'g') } }
    }
    check()
    const final = dump(db)
    db.close()
    db = open(dir)
    assert.deepEqual(dump(db), final, 'everything the random run did is durable and replays to the same state')
    db.close()
  })

  test('findBy builds the index on first use; quota of 16 indexes per collection falls back to a scan; guard against out-of-band edits', () => {
    const db = createDb()
    const rows = Array.from({ length: 20 }, (_, i) => db.insert('c', Object.fromEntries(Array.from({ length: 20 }, (_, f) => [`f${f}`, i % 3]))))
    for (let f = 0; f < 20; f++) assert.equal(db.findBy('c', `f${f}`, 1).length, 7, `field f${f}`)
    assert.equal(db.stats().collections.c.indexes.length, 16)
    assert.throws(() => db.index('c', 'f19'), RangeError)
    assert.throws(() => db.index('c', 'bad field!'), TypeError)
    assert.throws(() => db.findBy('c', '__proto__ x', 1), TypeError)
    // stale entries from direct mutation are filtered; reindex repairs lookups
    rows[0].f0 = 'edited'
    assert.equal(db.findBy('c', 'f0', 0).includes(rows[0]), false)
    assert.deepEqual(db.findBy('c', 'f0', 'edited'), [])
    db.reindex('c', 'f0')
    assert.deepEqual(db.findBy('c', 'f0', 'edited'), [rows[0]])
    assert.equal(db.dropIndex('c', 'f0'), true)
    assert.equal(db.dropIndex('c', 'f0'), false)
  })

  test('indexes work on a persisted database after reopen', () => {
    const dir = tmpdir()
    let db = open(dir)
    db.index('c', 'k')
    for (let i = 0; i < 50; i++) db.insert('c', { k: i % 5 })
    db.close()
    db = open(dir)
    assert.equal(db.findBy('c', 'k', 3).length, 10)
    db.close()
  })
})

describe('transactions', () => {
  test('one log record per transaction; commit is durable and atomic across a crash', () => {
    const dir = tmpdir()
    const db = open(dir)
    const keep = db.insert('c', { n: 'keep' })
    const rec0 = db.stats().wal.records
    const out = db.transaction(() => {
      const a = db.insert('c', { n: 'a' })
      db.update('c', keep.id, { n: 'changed' })
      db.insert('d', { ref: a.id })
      db.remove('c', a.id)
      return 'result'
    })
    assert.equal(out, 'result')
    assert.equal(db.stats().wal.records, rec0 + 1)
    assert.equal(db.stats().writes.transactions, 1)
    const full = dump(db)
    const copy = crashCopy(dir)
    assert.deepEqual(dump(open(copy)), full)
    // torn transaction record: none of its effects may appear
    const torn = crashCopy(dir)
    const w = lastWal(torn)
    fs.truncateSync(w, fs.statSync(w).size - 10)
    const d = open(torn)
    assert.equal(d.get('c', keep.id).n, 'keep')
    assert.equal(d.count('d'), 0)
    d.close()
    db.close()
  })

  test('exceptions roll everything back, including removals (order restored) and nested savepoints', () => {
    const db = createDb()
    const rows = [1, 2, 3, 4, 5].map((n) => db.insert('c', { n }))
    const before = dump(db)
    assert.throws(() => db.transaction(() => {
      db.remove('c', rows[1].id)
      db.removeWhere('c', (r) => r.n >= 4)
      db.update('c', rows[0].id, { n: 100, fresh: true })
      db.insert('c', { n: 6 })
      throw new Error('fail')
    }), /fail/)
    assert.deepEqual(dump(db), before)
    assert.equal(db.stats().writes.rollbacks, 1)

    db.transaction(() => {
      db.insert('c', { n: 'outer' })
      try {
        db.transaction(() => { db.insert('c', { n: 'inner' }); db.remove('c', rows[0].id); throw new Error('inner fail') })
      } catch { /* handled: only the inner part is undone */ }
      db.insert('c', { n: 'outer2' })
    })
    assert.deepEqual(db.find('c').map((r) => r.n), [1, 2, 3, 4, 5, 'outer', 'outer2'])
  })

  test('callbacks must be synchronous; a failed append rolls the memory state back', () => {
    const dir = tmpdir()
    const db = open(dir)
    db.insert('c', { a: 1 })
    const before = dump(db)
    assert.throws(() => db.transaction(async () => { db.insert('c', { a: 2 }) }), TypeError)
    assert.deepEqual(dump(db), before)
    assert.throws(() => db.transaction('nope'), TypeError)
    const orig = fs.writeSync
    fs.writeSync = () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }) }
    try { assert.throws(() => db.transaction(() => { db.insert('c', { a: 3 }); db.insert('c', { a: 4 }) }), { code: 'EIO' }) } finally { fs.writeSync = orig }
    assert.deepEqual(dump(db), before)
    assert.throws(() => db.transaction(() => db.compact()), /transaction/)
    db.close()
  })

  test('removeWhere over many rows is a single atomic operation', () => {
    const db = createDb()
    for (let i = 0; i < 120_000; i++) db.insert('big', { i, even: i % 2 === 0 })
    assert.equal(db.removeWhere('big', (r) => r.even), 60_000)
    assert.equal(db.count('big'), 60_000)
    assert.ok(db.find('big', (r) => r.even).length === 0)
  })
})

describe('legacy db.json migration', () => {
  test('first open migrates the old single-file format (rows, order, blobs) and keeps the original', () => {
    const dir = tmpdir()
    const legacy = {
      users: [{ id: 'usr_1', createdAt: 't', email: 'a@b.c' }, { id: 'usr_2', createdAt: 't', email: 'x@y.z' }],
      files: [{ id: 'fil_1', userId: 'usr_1', versions: [{ blobId: 'blob_aaaa', size: 5 }] }],
      custom_things: [{ id: 'cus_1', x: 1 }, { x: 'no id' }, { id: 'cus_1', dup: true }, 'not a row'],
      '../evil': [{ id: 'z' }],
      notACollection: 5,
    }
    fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(legacy))
    fs.mkdirSync(path.join(dir, 'blobs'))
    fs.writeFileSync(path.join(dir, 'blobs', 'blob_aaaa'), 'hello')
    fs.writeFileSync(path.join(dir, 'blobs', 'weird name'), 'x')
    const logs = []
    const db = open(dir, { logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error() {} } })
    assert.deepEqual(db.find('users').map((u) => u.email), ['a@b.c', 'x@y.z'])
    assert.equal(db.get('files', 'fil_1').versions[0].blobId, 'blob_aaaa')
    assert.equal(db.getBlob('blob_aaaa').toString(), 'hello')
    assert.equal(db.count('custom_things'), 2, 'duplicate id and non-object skipped, id-less row gets an id')
    assert.ok(db.find('custom_things').every((r) => typeof r.id === 'string'))
    assert.equal(db.collections().includes('../evil'), false)
    assert.ok(!fs.existsSync(path.join(dir, 'db.json')))
    assert.equal(names(dir, /^db\.json\.migrated/).length, 1)
    assert.deepEqual(names(path.join(dir, 'blobs'), /^[^0-9a-f]|^\w{3,}$/).filter((n) => fs.statSync(path.join(dir, 'blobs', n)).isFile()), ['weird name'], 'only the unusable file remains flat')
    assert.ok(logs.some((l) => /migrated legacy db\.json/.test(l)))
    assert.equal(db.stats().recovery.migratedLegacyDb.rows, 5)
    db.insert('users', { email: 'new@b.c' })
    db.close()
    const again = open(dir)
    assert.equal(again.count('users'), 3)
    assert.equal(again.getBlob('blob_aaaa').toString(), 'hello')
    again.close()
  })

  test('a corrupt legacy file is never clobbered; startup is refused', () => {
    const dir = tmpdir()
    fs.writeFileSync(path.join(dir, 'db.json'), '{"users": [ {"id": ')
    assert.throws(() => open(dir), (e) => e instanceof DbCorruptionError && /db\.json/.test(e.message))
    assert.equal(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'), '{"users": [ {"id": ')
    assert.ok(!fs.existsSync(path.join(dir, 'LOCK')))
    fs.writeFileSync(path.join(dir, 'db.json'), '[1,2]')
    assert.throws(() => open(dir), DbCorruptionError)
  })

  test('a leftover db.json next to engine data (interrupted migration) is ignored, not re-imported', () => {
    const dir = tmpdir()
    let db = open(dir)
    db.insert('users', { email: 'real@x' })
    db.close()
    fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ users: [{ id: 'u', email: 'stale@x' }] }))
    db = open(dir)
    assert.deepEqual(db.find('users').map((u) => u.email), ['real@x'])
    assert.ok(!fs.existsSync(path.join(dir, 'db.json')))
    db.close()
  })

  test('a stale db.json.tmp from the old engine is cleaned up; other modules\' files in the data dir are never touched', () => {
    const dir = tmpdir()
    fs.writeFileSync(path.join(dir, 'db.json.tmp'), '{')
    fs.writeFileSync(path.join(dir, 'snapshot-0000000007.rds.tmp'), 'partial')
    fs.writeFileSync(path.join(dir, 'secret.key'), 'master-secret')
    fs.writeFileSync(path.join(dir, 'secret.key.tmp'), 'half-written by another module')
    open(dir).close()
    assert.ok(!fs.existsSync(path.join(dir, 'db.json.tmp')))
    assert.ok(!fs.existsSync(path.join(dir, 'snapshot-0000000007.rds.tmp')))
    assert.equal(fs.readFileSync(path.join(dir, 'secret.key'), 'utf8'), 'master-secret')
    assert.ok(fs.existsSync(path.join(dir, 'secret.key.tmp')))
  })
})

describe('blob store', () => {
  const blobPath = (dir, id) => {
    const found = []
    for (const s of fs.readdirSync(path.join(dir, 'blobs'))) { const p = path.join(dir, 'blobs', s, id); if (fs.existsSync(p)) found.push(p) }
    assert.equal(found.length, 1)
    return found[0]
  }

  test('put/get/overwrite/delete/has/stat; accepts Buffer, Uint8Array, string', () => {
    for (const dir of [undefined, tmpdir()]) {
      const db = open(dir)
      const data = crypto.randomBytes(1000)
      const info = db.putBlob('blob_one', data)
      assert.equal(info.size, 1000)
      if (dir) assert.equal(info.sha256, crypto.createHash('sha256').update(data).digest('hex'))
      assert.ok(db.getBlob('blob_one').equals(data))
      assert.equal(db.hasBlob('blob_one'), true)
      assert.equal(db.statBlob('blob_one').size, 1000)
      db.putBlob('blob_one', 'replaced')
      assert.equal(db.getBlob('blob_one').toString(), 'replaced')
      db.putBlob('blob_u8', new Uint8Array([1, 2, 3]))
      assert.deepEqual([...db.getBlob('blob_u8')], [1, 2, 3])
      db.putBlob('blob_empty', Buffer.alloc(0))
      assert.equal(db.getBlob('blob_empty').length, 0)
      assert.equal(db.deleteBlob('blob_one'), true)
      assert.equal(db.deleteBlob('blob_one'), false)
      assert.equal(db.getBlob('blob_one'), null)
      assert.equal(db.hasBlob('blob_one'), false)
      assert.equal(db.statBlob('blob_one'), null)
      assert.throws(() => db.putBlob('x1', 42), TypeError)
      assert.throws(() => db.putBlob('x1', null), TypeError)
      db.close()
    }
  })

  test('memory mode copies on put (callers cannot alias stored bytes)', () => {
    const db = createDb()
    const buf = Buffer.from('abc')
    db.putBlob('blob_a', buf)
    buf[0] = 0x7a
    assert.equal(db.getBlob('blob_a').toString(), 'abc')
  })

  test('ids are validated: no path traversal, no separators, no hidden files', () => {
    for (const dir of [undefined, tmpdir()]) {
      const db = open(dir)
      for (const bad of ['../escape', '..', '.', '.hidden', 'a/b', 'a\\b', '/abs', '', 'a\0b', 'x'.repeat(129), 'sp ace', 5, null, undefined, {}]) {
        assert.throws(() => db.putBlob(bad, 'x'), TypeError, String(bad))
        assert.equal(db.getBlob(bad), null)
        assert.equal(db.deleteBlob(bad), false)
        assert.equal(db.hasBlob(bad), false)
      }
      if (dir) assert.deepEqual(fs.readdirSync(dir).filter((n) => !/^(blobs|LOCK|wal-.*|snapshot-.*)$/.test(n)), [], 'nothing written outside the store')
      db.close()
    }
  })

  test('size limit is enforced', () => {
    const db = open(tmpdir(), { blobMaxBytes: 100 })
    db.putBlob('blob_ok', Buffer.alloc(100))
    assert.throws(() => db.putBlob('blob_big', Buffer.alloc(101)), RangeError)
    assert.equal(db.hasBlob('blob_big'), false)
    db.close()
  })

  test('checksum verification on read: flipped payload byte, truncation, damaged header, empty file', () => {
    const dir = tmpdir()
    const db = open(dir)
    const data = crypto.randomBytes(500)
    db.putBlob('blob_x', data)
    const p = blobPath(dir, 'blob_x')
    const good = fs.readFileSync(p)
    assert.equal(good.length, 500 + 44)
    const variants = {
      'payload bit flip': (b) => { b[100] ^= 1; return b },
      'truncated': (b) => b.subarray(0, 300),
      'extended': (b) => Buffer.concat([b, Buffer.from('x')]),
      'magic damaged': (b) => { b[0] = 0; return b },
      'stored hash damaged': (b) => { b[20] ^= 1; return b },
      'length field damaged': (b) => { b[11] ^= 1; return b },
      'empty': () => Buffer.alloc(0),
    }
    for (const [name, fn] of Object.entries(variants)) {
      fs.writeFileSync(p, fn(Buffer.from(good)))
      assert.throws(() => db.getBlob('blob_x'), (e) => e instanceof BlobCorruptError && e.code === 'EBLOBCORRUPT' && e.blobId === 'blob_x', name)
      assert.deepEqual(db.verifyBlobs().corrupt.map((c) => c.id), ['blob_x'], name)
    }
    fs.writeFileSync(p, good)
    assert.ok(db.getBlob('blob_x').equals(data))
    assert.deepEqual(db.verifyBlobs(), { checked: 1, bytes: 500, corrupt: [] })
    db.close()
  })

  test('writes are atomic: failure leaves the old blob intact and no temp files', () => {
    const dir = tmpdir()
    const db = open(dir)
    db.putBlob('blob_a', 'old')
    const orig = fs.renameSync
    fs.renameSync = () => { throw new Error('rename failed') }
    try { assert.throws(() => db.putBlob('blob_a', 'new'), /rename failed/) } finally { fs.renameSync = orig }
    assert.equal(db.getBlob('blob_a').toString(), 'old')
    const all = fs.readdirSync(path.join(dir, 'blobs'), { recursive: true })
    assert.deepEqual(all.filter((n) => n.endsWith('.tmp')), [])
    db.putBlob('blob_b', 'ok')
    assert.deepEqual(fs.readdirSync(path.join(dir, 'blobs'), { recursive: true }).filter((n) => n.endsWith('.tmp')), [])
    db.close()
  })

  test('blobs are sharded and files/dirs created by the engine are private (0700/0600)', { skip: process.platform === 'win32' }, () => {
    const dir = path.join(tmpdir(), 'fresh-data-dir')
    const db = open(dir)
    for (let i = 0; i < 40; i++) db.putBlob(`blob_${i}`, 'x')
    db.insert('c', {})
    db.compact()
    const shards = fs.readdirSync(path.join(dir, 'blobs'))
    assert.ok(shards.length > 4 && shards.every((s) => /^[0-9a-f]{2}$/.test(s)))
    assert.equal(fs.statSync(blobPath(dir, 'blob_3')).mode & 0o077, 0)
    assert.equal(fs.statSync(dir).mode & 0o077, 0)
    assert.equal(fs.statSync(path.join(dir, 'blobs')).mode & 0o077, 0)
    assert.equal(fs.statSync(lastSnap(dir)).mode & 0o077, 0)
    assert.equal(fs.statSync(lastWal(dir)).mode & 0o077, 0)
    assert.equal(fs.statSync(path.join(dir, 'LOCK')).mode & 0o077, 0)
    db.close()
  })

  test('blobs survive restart and counts in stats follow puts/overwrites/deletes', () => {
    const dir = tmpdir()
    let db = open(dir)
    db.putBlob('blob_a', 'aaa')
    db.putBlob('blob_b', 'bbbb')
    assert.deepEqual([db.stats().blobs.count, db.stats().blobs.bytes], [2, 7])
    db.putBlob('blob_a', 'a')
    db.deleteBlob('blob_b')
    db.putBlob('blob_c', 'cc')
    assert.deepEqual([db.stats().blobs.count, db.stats().blobs.bytes], [2, 3])
    db.close()
    db = open(dir)
    assert.deepEqual([db.stats().blobs.count, db.stats().blobs.bytes], [2, 3])
    assert.equal(db.getBlob('blob_c').toString(), 'cc')
    db.close()
  })

  test('gcBlobs removes only unreferenced, old-enough blobs and refuses unsafe callbacks', () => {
    const dir = tmpdir()
    const db = open(dir)
    for (const id of ['blob_keep', 'blob_orphan', 'blob_fresh', 'blob_orphan2']) db.putBlob(id, id)
    for (const id of ['blob_keep', 'blob_orphan', 'blob_orphan2']) { const t = new Date(Date.now() - 3_600_000); fs.utimesSync(blobPath(dir, id), t, t) }
    const refs = new Set(['blob_keep'])
    assert.throws(() => db.gcBlobs(), TypeError)
    assert.throws(() => db.gcBlobs(() => undefined), /boolean/, 'a callback that forgets to return would otherwise delete everything')
    assert.throws(() => db.gcBlobs((id) => (id === 'blob_keep' ? true : 1)), /boolean/)
    assert.equal(db.hasBlob('blob_orphan'), true)
    assert.throws(() => db.gcBlobs(() => { throw new Error('lookup failed') }), /lookup failed/)
    assert.equal(db.hasBlob('blob_orphan'), true, 'nothing deleted when the callback throws')
    const dry = db.gcBlobs((id) => refs.has(id), { dryRun: true })
    assert.equal(dry.dryRun, true)
    assert.equal(dry.removed, 2)
    assert.equal(db.hasBlob('blob_orphan'), true, 'dry run deletes nothing')
    const res = db.gcBlobs((id) => refs.has(id))
    assert.equal(res.removed, 2)
    assert.equal(res.scanned, 4)
    assert.equal(res.skippedRecent, 1, 'blob_fresh is inside the grace period')
    assert.deepEqual(res.candidates.sort(), ['blob_orphan', 'blob_orphan2'])
    assert.equal(db.hasBlob('blob_keep'), true)
    assert.equal(db.hasBlob('blob_fresh'), true)
    assert.equal(db.hasBlob('blob_orphan'), false)
    assert.equal(db.stats().blobs.count, 2)
    assert.equal(db.gcBlobs(() => false, { graceMs: 0 }).removed, 2, 'graceMs is configurable')
    db.close()
  })

  test('gcBlobs works on in-memory databases too', () => {
    const db = createDb()
    db.putBlob('blob_a', 'a')
    db.putBlob('blob_b', 'b')
    assert.equal(db.gcBlobs((id) => id === 'blob_a', { graceMs: 0 }).removed, 1)
    assert.equal(db.hasBlob('blob_b'), false)
    assert.equal(db.hasBlob('blob_a'), true)
  })

  test('gcBlobs also cleans stale temp files but not fresh ones', () => {
    const dir = tmpdir()
    const db = open(dir)
    db.putBlob('blob_a', 'x')
    const shard = path.dirname(blobPath(dir, 'blob_a'))
    const stale = path.join(shard, '.blob_dead.123.abcd.tmp')
    const fresh = path.join(shard, '.blob_live.123.abcd.tmp')
    fs.writeFileSync(stale, 'partial')
    fs.writeFileSync(fresh, 'partial')
    const old = new Date(Date.now() - 2 * 3_600_000)
    fs.utimesSync(stale, old, old)
    const res = db.gcBlobs(() => true)
    assert.equal(res.staleTmpRemoved, 1)
    assert.ok(!fs.existsSync(stale) && fs.existsSync(fresh))
    db.close()
  })
})

describe('stats and health', () => {
  test('stats() describes collections, wal, snapshot, compactions, blobs, recovery, lock', () => {
    const dir = tmpdir()
    const db = open(dir)
    db.index('users', 'email')
    db.insert('users', { email: 'a' })
    db.insert('users', { email: 'b' })
    db.update('users', db.find('users')[0].id, { x: 1 })
    db.remove('users', db.find('users')[1].id)
    db.putBlob('blob_s', 'xyz')
    const s = db.stats()
    assert.equal(s.mode, 'persistent')
    assert.equal(s.dataDir, fs.realpathSync(dir))
    assert.equal(s.collections.users.count, 1)
    assert.deepEqual(s.collections.users.indexes, ['email'])
    assert.equal(s.totals.docs, 1)
    assert.deepEqual(s.writes, { inserts: 2, updates: 1, removes: 1, transactions: 0, rollbacks: 0 })
    assert.equal(s.wal.seq, 4)
    assert.equal(s.wal.records, 4)
    assert.ok(s.wal.bytes > 0)
    assert.deepEqual([s.blobs.count, s.blobs.bytes], [1, 3])
    assert.equal(s.lock.pid, process.pid)
    assert.equal(s.health.ok, true)
    assert.equal(s.compactions.count, 0)
    db.compact()
    const t = db.stats()
    assert.equal(t.compactions.count, 1)
    assert.equal(t.snapshot.rows, 1)
    assert.ok(t.snapshot.bytes > 0 && t.snapshot.createdAt)
    assert.equal(t.wal.records, 0)
    assert.equal(t.wal.seq, 4, 'sequence numbers continue across compaction')
    db.close()
    assert.equal(db.health().closed, true)
    const m = createDb().stats()
    assert.equal(m.mode, 'memory')
    assert.equal(m.wal, null)
  })
})

describe('backup, verify, restore', () => {
  function seed(dir, o = {}) {
    const db = open(dir, o)
    for (let i = 0; i < 50; i++) db.insert('users', { i, email: `u${i}@x` })
    db.update('users', db.find('users')[3].id, { name: 'three' })
    db.remove('users', db.find('users')[4].id)
    for (let i = 0; i < 5; i++) db.putBlob(`blob_${i}`, crypto.randomBytes(300 + i))
    return db
  }

  test('db.backup(dest) writes an independently openable, verified copy (without stopping the db)', () => {
    const dir = tmpdir()
    const db = seed(dir)
    db.insert('users', { i: 'tail-in-wal' }) // not yet in any snapshot
    const dest = path.join(tmpdir(), 'bk')
    const res = db.backup(dest)
    assert.equal(res.ok, true)
    assert.equal(res.blobs, 5)
    assert.equal(res.docs, 50)
    assert.ok(fs.existsSync(path.join(dest, 'MANIFEST.json')))
    const rep = verifyDataDir(dest)
    assert.equal(rep.ok, true, JSON.stringify(rep.errors))
    assert.equal(rep.docs, 50)
    assert.equal(rep.blobs.checked, 5)
    db.insert('users', { i: 'written-after-backup' })
    const copy = open(dest)
    assert.deepEqual(dump(copy).users.map((u) => u.i).slice(-1), ['tail-in-wal'])
    assert.ok(copy.getBlob('blob_3').equals(db.getBlob('blob_3')))
    copy.close()
    assert.throws(() => db.backup(dest), /not empty/)
    assert.throws(() => db.backup(path.join(dir, 'inside')), /outside the data directory/)
    db.close()
  })

  test('db.backup reports corrupt source blobs instead of silently copying them', () => {
    const dir = tmpdir()
    const db = seed(dir)
    const p = fs.readdirSync(path.join(dir, 'blobs'), { recursive: true }).find((n) => n.endsWith('blob_2'))
    flipByte(path.join(dir, 'blobs', p), 60)
    const res = db.backup(path.join(tmpdir(), 'bk'))
    assert.equal(res.ok, false)
    assert.deepEqual(res.problems.map((x) => x.blob), ['blob_2'])
    assert.equal(res.blobs, 4)
    db.close()
  })

  test('files other modules keep in the data dir (secret.key) travel with every kind of backup and restore', () => {
    const dir = tmpdir()
    const db = seed(dir)
    fs.writeFileSync(path.join(dir, 'secret.key'), 'master-secret', { mode: 0o600 })
    fs.mkdirSync(path.join(dir, 'extra-module'))
    fs.writeFileSync(path.join(dir, 'extra-module', 'state.json'), '{"k":1}')
    fs.symlinkSync('/etc/passwd', path.join(dir, 'sneaky-link'))
    fs.writeFileSync(path.join(dir, 'scratch.tmp'), 'ignored')
    db.flush()
    const inproc = path.join(tmpdir(), 'inproc')
    db.backup(inproc)
    const live = path.join(tmpdir(), 'live')
    backupDataDir(dir, live, { lock: false, logger: quiet })
    db.close()
    const cold = path.join(tmpdir(), 'cold')
    backupDataDir(dir, cold, { logger: quiet })
    for (const bk of [inproc, live, cold]) {
      assert.equal(fs.readFileSync(path.join(bk, 'secret.key'), 'utf8'), 'master-secret', bk)
      assert.equal(fs.readFileSync(path.join(bk, 'extra-module', 'state.json'), 'utf8'), '{"k":1}')
      assert.ok(!fs.existsSync(path.join(bk, 'sneaky-link')), 'symlinks are never followed or copied')
      assert.ok(!fs.existsSync(path.join(bk, 'scratch.tmp')))
      assert.ok(!fs.existsSync(path.join(bk, 'LOCK')))
      assert.equal(verifyDataDir(bk).ok, true)
    }
    const target = path.join(tmpdir(), 'restored')
    restoreBackup(live, target, { logger: quiet })
    assert.equal(fs.readFileSync(path.join(target, 'secret.key'), 'utf8'), 'master-secret')
    assert.equal(fs.statSync(path.join(target, 'secret.key')).mode & 0o077, 0, 'permissions preserved')
    assert.ok(!fs.existsSync(path.join(target, 'MANIFEST.json')), 'a running data dir carries no stale manifest')
  })

  test('memory databases can be exported too, and { link: true } hard-links blobs', () => {
    const m = createDb()
    m.insert('c', { a: 1 })
    m.putBlob('blob_m', 'mem blob')
    const dest = path.join(tmpdir(), 'bk')
    assert.equal(m.backup(dest).blobs, 1)
    const d = open(dest)
    assert.equal(d.getBlob('blob_m').toString(), 'mem blob')
    d.close()
    const dir = tmpdir()
    const db = seed(dir)
    const dest2 = path.join(tmpdir(), 'bk2')
    db.backup(dest2, { link: true })
    assert.equal(verifyDataDir(dest2).ok, true)
    db.close()
  })

  test('verify detects every kind of damage and never modifies the directory', () => {
    const dir = tmpdir()
    const db = seed(dir, { keepGenerations: 2 })
    db.compact()
    db.insert('users', { i: 'wal' })
    db.compact()
    db.close()
    assert.equal(verifyDataDir(dir).ok, true)
    const clean = verifyDataDir(dir)
    assert.ok(clean.snapshots.length >= 1 && clean.snapshots.every((s) => s.ok))

    const corrupt = (fn) => { const d = tmpdir(); fs.cpSync(dir, d, { recursive: true }); fn(d); const before = fs.readdirSync(d, { recursive: true }).sort(); const rep = verifyDataDir(d); assert.deepEqual(fs.readdirSync(d, { recursive: true }).sort(), before, 'verify is read-only'); return rep }
    assert.equal(corrupt((d) => flipByte(lastSnap(d), 100)).ok, false, 'newest snapshot')
    assert.equal(corrupt((d) => flipByte(path.join(d, names(d, /^snapshot-/)[0]), 100)).ok, false, 'older snapshot (lost redundancy) is reported too')
    const blobRep = corrupt((d) => { const p = fs.readdirSync(path.join(d, 'blobs'), { recursive: true }).find((n) => n.endsWith('blob_1')); flipByte(path.join(d, 'blobs', p), 70) })
    assert.equal(blobRep.ok, false)
    assert.equal(blobRep.blobs.corrupt[0].id, 'blob_1')
    assert.equal(corrupt((d) => fs.writeFileSync(path.join(d, 'db.json.zz'), '')).ok, true)
    const torn = corrupt((d) => fs.appendFileSync(lastWal(d), 'garbage-without-newline'))
    assert.equal(torn.ok, true, 'a torn tail is normal after a crash: warning, not error')
    assert.ok(torn.warnings.some((w) => /torn-tail/.test(w)))
    assert.equal(verifyDataDir(path.join(dir, 'nope')).ok, false)
    assert.equal(verifyDataDir(tmpdir()).ok, true)
  })

  test('restore verifies first, refuses non-empty destinations without force, and moves the old data aside with force', () => {
    const dir = tmpdir()
    const db = seed(dir)
    const bk = path.join(tmpdir(), 'bk')
    db.backup(bk)
    const expected = dump(db)
    db.close()

    const target = path.join(tmpdir(), 'restored')
    const r = restoreBackup(bk, target, { logger: quiet })
    assert.equal(r.docs, 49)
    assert.equal(r.blobs, 5)
    const rdb = open(target)
    assert.deepEqual(dump(rdb), expected)
    assert.equal(rdb.verifyBlobs().corrupt.length, 0)
    rdb.insert('users', { i: 'new' })
    rdb.close()

    assert.throws(() => restoreBackup(bk, target, { logger: quiet }), /not empty/)
    const live = open(target)
    assert.throws(() => restoreBackup(bk, target, { force: true, logger: quiet }), DbLockedError, 'never restore over a data dir that is in use')
    live.close()
    const forced = restoreBackup(bk, target, { force: true, logger: quiet })
    assert.ok(forced.previousMovedTo && fs.existsSync(forced.previousMovedTo))
    const again = open(target)
    assert.deepEqual(dump(again), expected, 'old (newer) data moved aside, backup content restored')
    again.close()
    const old = open(forced.previousMovedTo)
    assert.equal(old.count('users'), expected.users.length + 1)
    old.close()

    // a damaged backup is refused before anything is touched
    flipByte(path.join(bk, names(bk, /^snapshot-/)[0]), 90)
    const t2 = path.join(tmpdir(), 'r2')
    assert.throws(() => restoreBackup(bk, t2, { logger: quiet }), DbCorruptionError)
    assert.ok(!fs.existsSync(t2))
  })

  test('file-level backup: refuses a live server (lock), --live copies consistently while the db is open', () => {
    const dir = tmpdir()
    const db = seed(dir)
    db.flush()
    assert.throws(() => backupDataDir(dir, path.join(tmpdir(), 'x'), { logger: quiet }), DbLockedError)
    const bk = path.join(tmpdir(), 'live')
    const res = backupDataDir(dir, bk, { lock: false, logger: quiet })
    assert.equal(res.ok, true)
    assert.equal(res.live, true)
    const copy = open(bk)
    assert.deepEqual(dump(copy), dump(db))
    copy.close()
    db.close()
    const bk2 = path.join(tmpdir(), 'cold')
    const cold = backupDataDir(dir, bk2, { logger: quiet })
    assert.equal(cold.live, false)
    assert.equal(verifyDataDir(bk2).ok, true)
    assert.throws(() => backupDataDir(dir, path.join(dir, 'inside'), { logger: quiet }), /nested/)
    assert.ok(!fs.existsSync(path.join(dir, 'LOCK')), 'lock released after the backup')
  })

  test('live backup of a log with a torn tail trims the tail in the copy only', () => {
    const dir = tmpdir()
    const db = seed(dir)
    const crashed = crashCopy(dir)
    fs.appendFileSync(lastWal(crashed), 'partial record with no newline')
    const bk = path.join(tmpdir(), 'bk')
    const res = backupDataDir(crashed, bk, { lock: false, logger: quiet })
    assert.equal(res.ok, true)
    assert.ok(fs.readFileSync(lastWal(crashed), 'latin1').endsWith('no newline'), 'source untouched')
    assert.equal(verifyDataDir(bk).warnings.some((w) => /torn/.test(w)), false)
    db.close()
  })
})

describe('performance sanity', () => {
  test('100k inserts and 100k indexed lookups on a persistent db within a generous budget', () => {
    const dir = tmpdir()
    const db = open(dir, { fsync: 'batch', compactMinBytes: 16 * 1024 * 1024 })
    db.index('perf', 'key')
    const N = 100_000
    let t = process.hrtime.bigint()
    for (let i = 0; i < N; i++) db.insert('perf', { key: `k${i}`, n: i, userId: `usr_${i % 1000}`, payload: 'x'.repeat(40) })
    const insertMs = Number(process.hrtime.bigint() - t) / 1e6
    t = process.hrtime.bigint()
    let hits = 0
    for (let i = 0; i < N; i++) hits += db.findBy('perf', 'key', `k${(i * 7919) % N}`).length
    const lookupMs = Number(process.hrtime.bigint() - t) / 1e6
    assert.equal(hits, N)
    t = process.hrtime.bigint()
    const info = db.compact()
    const compactMs = Number(process.hrtime.bigint() - t) / 1e6
    t = process.hrtime.bigint()
    db.close()
    const re = open(dir)
    const reopenMs = Number(process.hrtime.bigint() - t) / 1e6
    assert.equal(re.count('perf'), N)
    assert.equal(re.findBy('perf', 'key', 'k4242')[0].n, 4242)
    re.close()
    console.log(`    perf: insert ${(N / insertMs * 1000) | 0}/s (${insertMs.toFixed(0)}ms), indexed lookup ${(N / lookupMs * 1000) | 0}/s (${lookupMs.toFixed(0)}ms), compact ${compactMs.toFixed(0)}ms (${(info.snapshotBytes / 1e6).toFixed(1)}MB), close+reopen ${reopenMs.toFixed(0)}ms`)
    assert.ok(insertMs < 20_000, `inserts took ${insertMs}ms`)
    assert.ok(lookupMs < 5_000, `lookups took ${lookupMs}ms`)
    assert.ok(compactMs < 10_000 && reopenMs < 10_000)
  })

  test('recovery of a 100k-record log (no snapshot) is fast', () => {
    const dir = tmpdir()
    const db = open(dir, { compactMinBytes: 2 ** 30 })
    for (let i = 0; i < 100_000; i++) db.insert('perf', { n: i })
    const copy = crashCopy(dir)
    const t = process.hrtime.bigint()
    const re = open(copy)
    const ms = Number(process.hrtime.bigint() - t) / 1e6
    assert.equal(re.count('perf'), 100_000)
    assert.equal(re.stats().recovery.replayedRecords, 100_000)
    assert.ok(ms < 10_000, `replay took ${ms}ms`)
    re.close()
    db.close()
  })
})

describe('engine edge cases', () => {
  test('closed persistent db: reads work, writes and blob writes throw, close is idempotent, lock released', () => {
    const dir = tmpdir()
    const db = open(dir)
    const r = db.insert('c', { a: 1 })
    db.putBlob('blob_a', 'x')
    db.close()
    db.close()
    assert.equal(db.get('c', r.id).a, 1)
    assert.equal(db.getBlob('blob_a').toString(), 'x')
    assert.throws(() => db.insert('c', {}), { code: 'EDBCLOSED' })
    assert.throws(() => db.update('c', r.id, { a: 2 }), { code: 'EDBCLOSED' })
    assert.throws(() => db.remove('c', r.id), { code: 'EDBCLOSED' })
    assert.throws(() => db.putBlob('blob_b', 'y'), { code: 'EDBCLOSED' })
    assert.throws(() => db.deleteBlob('blob_a'), { code: 'EDBCLOSED' })
    assert.doesNotThrow(() => db.flush())
    assert.ok(!fs.existsSync(path.join(dir, 'LOCK')))
  })

  test('collection count is bounded', () => {
    const db = createDb()
    const base = db.collections().length
    for (let i = 0; i < 10_000 - base; i++) db.insert(`col_${i}`, {})
    assert.throws(() => db.insert('one_too_many', {}), RangeError)
    assert.equal(db.get('one_too_many', 'x'), null)
    assert.deepEqual(db.find('one_too_many'), [], 'reads never create collections')
  })

  test('documents larger than the read buffer round-trip through log and snapshot', () => {
    const dir = tmpdir()
    const db = open(dir)
    const big = 'é'.repeat(1_500_000) + crypto.randomBytes(1_000_000).toString('base64')
    db.insert('c', { n: 0 })
    const b = db.insert('c', { n: 1, big })
    db.insert('c', { n: 2 })
    db.update('c', b.id, { big: big + '!' })
    const copy = crashCopy(dir)
    let d = open(copy)
    assert.equal(d.get('c', b.id).big.length, big.length + 1)
    assert.deepEqual(d.find('c').map((r) => r.n), [0, 1, 2])
    d.compact()
    d.close()
    d = open(copy)
    assert.equal(d.get('c', b.id).big, big + '!')
    d.close()
    db.close()
  })

  test('hard cap: a burst far above the threshold compacts synchronously instead of growing the log without bound', () => {
    const dir = tmpdir()
    const db = open(dir, { compactMinBytes: 2000 })
    for (let i = 0; i < 300; i++) db.insert('c', { i, pad: 'x'.repeat(30) })
    assert.ok(db.stats().compactions.count >= 1, 'compacted inside the burst, without yielding to the event loop')
    const w = db.stats().wal
    assert.ok(w.bytes < w.compactThresholdBytes * 4 + 1000, `log stayed bounded: ${w.bytes} bytes vs threshold ${w.compactThresholdBytes}`)
    const before = dump(db)
    db.close()
    const d = open(dir)
    assert.deepEqual(dump(d), before)
    d.close()
  })

  test('a failing compaction (disk full) leaves the db usable and the log chain valid', () => {
    const dir = tmpdir()
    const db = open(dir)
    for (let i = 0; i < 5; i++) db.insert('c', { i })
    const orig = fs.openSync
    fs.openSync = function (p, ...rest) {
      if (String(p).endsWith('.rds.tmp')) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      return orig.call(fs, p, ...rest)
    }
    try { assert.throws(() => db.compact(), { code: 'ENOSPC' }) } finally { fs.openSync = orig }
    assert.match(db.stats().compactions.lastError, /ENOSPC/)
    assert.equal(db.health().ok, true)
    for (let i = 5; i < 10; i++) db.insert('c', { i })
    const copy = crashCopy(dir)
    const d = open(copy)
    assert.deepEqual(d.find('c').map((r) => r.i), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    d.close()
    db.compact()
    assert.equal(db.stats().compactions.lastError, null)
    const before = dump(db)
    db.close()
    const e = open(dir)
    assert.deepEqual(dump(e), before)
    e.close()
  })

  test('direct mutation of a returned row is NOT logged: it reaches disk only with a snapshot (documented; always use update())', () => {
    const dir = tmpdir()
    const db = open(dir)
    const r = db.insert('c', { v: 1 })
    r.v = 2 // out-of-band edit
    const crashed = crashCopy(dir)
    const d = open(crashed)
    assert.equal(d.get('c', r.id).v, 1, 'lost on crash')
    d.close()
    db.close() // clean shutdown snapshots the live state
    const e = open(dir)
    assert.equal(e.get('c', r.id).v, 2)
    e.close()
  })

  test('batch mode: close() makes pending writes durable and cancels the timer (process can exit)', () => {
    const dir = tmpdir()
    const db = open(dir, { fsync: 'batch', fsyncIntervalMs: 60_000 })
    db.insert('c', { a: 1 })
    assert.equal(db.stats().wal.pendingFsync, true)
    db.close()
    assert.equal(open(dir).count('c'), 1)
  })

  test('ids with a custom prefix and numeric ids survive restart unchanged', () => {
    const dir = tmpdir()
    const db = open(dir)
    db.insert('c', { id: 42, tag: 'num' })
    db.insert('c', { id: '42', tag: 'str' })
    db.close()
    const d = open(dir)
    assert.equal(d.get('c', 42).tag, 'num')
    assert.equal(d.get('c', '42').tag, 'str')
    d.close()
  })
})

describe('scripts/backup.mjs', () => {
  const CLI = path.join(ROOT, 'scripts', 'backup.mjs')
  const run = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env } })
    return { code: r.status, out: r.stdout, err: r.stderr }
  }
  function seeded() {
    const dir = tmpdir()
    const db = open(dir)
    for (let i = 0; i < 20; i++) db.insert('users', { i })
    db.putBlob('blob_cli', crypto.randomBytes(200))
    db.close()
    return dir
  }

  test('backup -> verify -> restore round trip, with the exit codes scripts depend on', () => {
    const dir = seeded()
    const bk = path.join(tmpdir(), 'bk')
    let r = run('backup', dir, bk)
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /backup ok: 20 documents, 1 blobs/)
    r = run('verify', bk)
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /^OK:/)
    const json = JSON.parse(run('verify', bk, '--json').out)
    assert.equal(json.ok, true)
    assert.equal(json.docs, 20)
    const target = path.join(tmpdir(), 'restored')
    r = run('restore', bk, target)
    assert.equal(r.code, 0, r.err)
    const db = open(target)
    assert.equal(db.count('users'), 20)
    assert.equal(db.getBlob('blob_cli').length, 200)
    db.close()
    r = run('restore', bk, target)
    assert.equal(r.code, 1)
    assert.match(r.err, /not empty/)
    r = run('restore', bk, target, '--force')
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /previous data directory kept at/)
  })

  test('verify exits 1 and says what is wrong for a damaged blob or snapshot; --no-blobs skips blob reading', () => {
    const dir = seeded()
    const blob = fs.readdirSync(path.join(dir, 'blobs'), { recursive: true }).find((n) => n.endsWith('blob_cli'))
    flipByte(path.join(dir, 'blobs', blob), 80)
    let r = run('verify', dir)
    assert.equal(r.code, 1)
    assert.match(r.out, /PROBLEMS FOUND/)
    assert.match(r.out, /blob blob_cli: sha256 mismatch/)
    assert.equal(run('verify', dir, '--no-blobs').code, 0)
    flipByte(lastSnap(dir), 120)
    r = run('verify', dir)
    assert.equal(r.code, 1)
    assert.match(r.out, /snapshot-\d+\.rds: checksum mismatch/)
  })

  test('backup refuses a running server unless --live; --live produces a verified copy', async () => {
    const dir = tmpdir()
    const p = child(`
      const db = E.createDb(${JSON.stringify(dir)}, { logger: { info() {}, warn() {}, error() {} } })
      for (let i = 0; i < 30; i++) db.insert('c', { i })
      db.putBlob('blob_live', 'live blob')
      db.flush()
      process.stdout.write('READY\\n')
      setInterval(() => {}, 1000)
    `)
    await p.waitFor(/READY/)
    const cold = run('backup', dir, path.join(tmpdir(), 'cold'))
    assert.equal(cold.code, 1)
    assert.match(cold.err, /in use by pid \d+/)
    assert.match(cold.err, /--live/)
    const bk = path.join(tmpdir(), 'hot')
    const hot = run('backup', dir, bk, '--live')
    assert.equal(hot.code, 0, hot.err)
    assert.equal(run('verify', bk).code, 0)
    p.kill('SIGKILL')
    await p.exited
    const db = open(bk)
    assert.equal(db.count('c'), 30)
    assert.equal(db.getBlob('blob_live').toString(), 'live blob')
    db.close()
  })

  test('usage errors exit 2; the data dir defaults to RD_DATA_DIR', () => {
    for (const args of [[], ['frobnicate'], ['backup'], ['backup', '--bogus', 'x'], ['verify', 'a', 'b'], ['restore'], ['verify', '--force']]) {
      const r = run(...args)
      assert.equal(r.code, 2, args.join(' '))
      assert.match(r.err, /Usage:/)
    }
    const dir = seeded()
    const r = spawnSync(process.execPath, [CLI, 'verify'], { encoding: 'utf8', env: { ...process.env, RD_DATA_DIR: dir } })
    assert.equal(r.status, 0, r.stdout)
    assert.ok(r.stdout.includes(fs.realpathSync(dir)) || r.stdout.includes(dir))
  })
})

describe('server.js configuration', () => {
  // imported lazily: server.js pulls in the whole app, and an unrelated broken module must not take the engine tests down
  let parseConfig, ConfigError
  before(async () => { ({ parseConfig, ConfigError } = await import('../server.js')) })
  const ok = (env) => parseConfig({ RD_DATA_DIR: tmpdir(), ...env })
  const bad = (env, re) => assert.throws(() => ok(env), (e) => e instanceof ConfigError && re.test(e.message), JSON.stringify(env))

  test('defaults and valid values', () => {
    const c = ok({})
    assert.equal(c.port, 3000)
    assert.equal(c.host, undefined)
    assert.equal(c.shutdownTimeoutMs, 10_000)
    assert.equal(c.crashOnUnhandled, false)
    assert.equal(ok({ PORT: '0' }).port, 0)
    assert.equal(ok({ PORT: '65535' }).port, 65535)
    assert.equal(ok({ PORT: '' }).port, 3000)
    assert.equal(ok({ HOST: '127.0.0.1' }).host, '127.0.0.1')
    assert.equal(ok({ HOST: '[::1]' }).host, '::1')
    assert.equal(ok({ HOST: 'localhost' }).host, 'localhost')
    assert.equal(ok({ HOST: 'my-host.example.com' }).host, 'my-host.example.com')
    assert.equal(ok({ RD_SHUTDOWN_TIMEOUT_MS: '0' }).shutdownTimeoutMs, 0)
    assert.equal(ok({ RD_CRASH_ON_UNHANDLED: '1' }).crashOnUnhandled, true)
    const rel = parseConfig({ RD_DATA_DIR: 'some/relative/dir' })
    assert.ok(path.isAbsolute(rel.dataDir))
    assert.equal(path.basename(parseConfig({}).dataDir), 'data')
  })

  test('invalid values are rejected with every problem listed', () => {
    for (const PORT of ['abc', '-1', '65536', '1e3', ' ', '3000x', '99999', '3.5']) bad({ PORT }, /PORT must be an integer/)
    for (const HOST of ['bad host!', 'a_b', '-x', 'x'.repeat(300), 'http://x', 'a b']) bad({ HOST }, /HOST must be/)
    bad({ RD_DATA_DIR: 'a\0b' }, /NUL/)
    bad({ RD_SHUTDOWN_TIMEOUT_MS: '-5' }, /RD_SHUTDOWN_TIMEOUT_MS/)
    bad({ RD_SHUTDOWN_TIMEOUT_MS: '9999999' }, /RD_SHUTDOWN_TIMEOUT_MS/)
    bad({ RD_CRASH_ON_UNHANDLED: 'maybe' }, /RD_CRASH_ON_UNHANDLED/)
    const saved = process.env.RD_FSYNC
    process.env.RD_FSYNC = 'sometimes'
    try { bad({ PORT: 'nope' }, /PORT[\s\S]*RD_FSYNC/) } finally { if (saved === undefined) delete process.env.RD_FSYNC; else process.env.RD_FSYNC = saved }
    const file = path.join(tmpdir(), 'afile')
    fs.writeFileSync(file, 'x')
    bad({ RD_DATA_DIR: file }, /not a directory/)
    bad({ RD_DATA_DIR: path.join(file, 'child') }, /cannot be created/)
  })
})

describe('server.js lifecycle (spawned process)', () => {
  function startServer(env = {}, { script } = {}) {
    const dataDir = env.RD_DATA_DIR ?? tmpdir()
    const full = { ...process.env, PORT: '0', RD_DATA_DIR: dataDir, RD_FSYNC: 'never', ...env }
    delete full.ANTHROPIC_API_KEY
    const args = script ? ['--input-type=module', '-e', script] : [path.join(ROOT, 'server.js')]
    const p = spawn(process.execPath, args, { env: full, stdio: ['ignore', 'pipe', 'pipe'] })
    spawned.push(p)
    p.out = ''
    p.err = ''
    p.dataDir = dataDir
    p.stdout.on('data', (d) => { p.out += d })
    p.stderr.on('data', (d) => { p.err += d })
    p.exited = new Promise((r) => p.on('exit', (code, signal) => r({ code, signal })))
    p.ready = new Promise((resolve, reject) => {
      p.ready?.catch?.(() => {})
      const t = setTimeout(() => reject(new Error(`server did not start: ${p.out} ${p.err}`)), 20_000)
      const check = () => { const m = /running on http:\/\/[^:\s]+:(\d+)/.exec(p.out); if (m) { clearTimeout(t); resolve(Number(m[1])) } }
      p.stdout.on('data', check)
      p.exited.then((e) => { clearTimeout(t); reject(new Error(`server exited early (${e.code}): ${p.out} ${p.err}`)) })
    })
    p.ready.catch(() => {}) // callers that expect an early exit only await p.exited
    return p
  }
  const register = async (port, email) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'password123' }) })
    return { status: res.status, body: await res.json() }
  }
  const within = (promise, ms, what) => Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout (${ms}ms): ${what}`)), ms))])

  test('SIGTERM: stops accepting, flushes the database, releases the lock; data survives a restart', async () => {
    const s = startServer()
    const port = await s.ready
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200)
    const r = await register(port, 'persist@rd.dev')
    assert.equal(r.status, 201, JSON.stringify(r.body))
    s.kill('SIGTERM')
    const { code } = await within(s.exited, 10_000, 'exit after SIGTERM')
    assert.equal(code, 0, s.err)
    assert.match(s.out + s.err, /SIGTERM: shutting down/)
    assert.match(s.out + s.err, /shutdown complete/)
    assert.ok(!fs.existsSync(path.join(s.dataDir, 'LOCK')), 'lock released')
    const db = open(s.dataDir)
    assert.equal(db.find('users').filter((u) => u.email === 'persist@rd.dev').length, 1)
    db.close()
    const s2 = startServer({ RD_DATA_DIR: s.dataDir })
    const port2 = await s2.ready
    const again = await register(port2, 'persist@rd.dev')
    assert.equal(again.status, 409, 'the account created before the restart is still there')
    s2.kill('SIGINT')
    assert.equal((await within(s2.exited, 10_000, 'exit after SIGINT')).code, 0)
  })

  test('shutdown drains an in-flight request before exiting, and refuses new connections meanwhile', async () => {
    const s = startServer()
    const port = await s.ready
    const body = JSON.stringify({ email: 'slow@rd.dev', password: 'password123' })
    const sock = net.connect(port, '127.0.0.1')
    let received = ''
    sock.on('data', (d) => { received += d })
    await new Promise((r) => sock.once('connect', r))
    sock.write(`POST /api/auth/register HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body.slice(0, 10)}`)
    await sleep(400) // the request is now in flight (headers parsed, body incomplete)
    s.kill('SIGTERM')
    await sleep(400)
    assert.equal(s.exitCode, null, 'server is still alive while a request is in flight')
    await assert.rejects(() => fetch(`http://127.0.0.1:${port}/api/health`), 'no new connections once shutdown started')
    sock.write(body.slice(10))
    await within(new Promise((r) => sock.once('close', r)), 5000, 'response + close')
    assert.match(received, /^HTTP\/1\.1 (2|4)\d\d/, received.slice(0, 200))
    assert.match(received, /connection: close/i)
    assert.equal((await within(s.exited, 10_000, 'exit after drain')).code, 0, s.err)
    assert.match(s.out + s.err, /1 request\(s\) in flight/)
  })

  test('drain timeout: a stalled request cannot block shutdown forever', async () => {
    const s = startServer({ RD_SHUTDOWN_TIMEOUT_MS: '300' })
    const port = await s.ready
    const sock = net.connect(port, '127.0.0.1')
    sock.on('error', () => {})
    await new Promise((r) => sock.once('connect', r))
    sock.write('POST /api/auth/register HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{')
    await sleep(400)
    const t0 = Date.now()
    s.kill('SIGTERM')
    const { code } = await within(s.exited, 8000, 'forced drain')
    assert.equal(code, 0)
    assert.ok(Date.now() - t0 < 4000)
    assert.match(s.out + s.err, /drain timeout/)
    sock.destroy()
    assert.ok(!fs.existsSync(path.join(s.dataDir, 'LOCK')))
  })

  test('a second signal during shutdown exits immediately', async () => {
    const s = startServer({ RD_SHUTDOWN_TIMEOUT_MS: '60000' })
    const port = await s.ready
    const sock = net.connect(port, '127.0.0.1')
    sock.on('error', () => {})
    await new Promise((r) => sock.once('connect', r))
    sock.write('POST /api/auth/register HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{')
    await sleep(400)
    s.kill('SIGTERM')
    await sleep(200)
    assert.equal(s.exitCode, null)
    s.kill('SIGTERM')
    const { code } = await within(s.exited, 5000, 'forced exit on second signal')
    assert.equal(code, 143)
    sock.destroy()
  })

  test('a second server on the same data dir refuses to start, a busy port is reported, bad config exits before touching disk', async () => {
    const a = startServer()
    const port = await a.ready
    const b = startServer({ RD_DATA_DIR: a.dataDir })
    const eb = await within(b.exited, 15_000, 'second server exit')
    assert.equal(eb.code, 1)
    assert.match(b.out + b.err, /in use by pid \d+/)
    const c = startServer({ PORT: String(port), RD_DATA_DIR: tmpdir() })
    assert.equal((await within(c.exited, 15_000, 'busy port exit')).code, 1)
    assert.match(c.out + c.err, /port \d+ is already in use/)
    assert.ok(!fs.existsSync(path.join(c.dataDir, 'LOCK')), 'failed start releases its lock')
    const never = path.join(tmpdir(), 'must-not-be-created')
    const d = startServer({ PORT: 'nope', RD_DATA_DIR: never })
    assert.equal((await d.exited.catch(() => ({}))).code, 1)
    assert.match(d.out + d.err, /PORT must be an integer/)
    assert.ok(!fs.existsSync(never))
    a.kill('SIGTERM')
    await within(a.exited, 10_000, 'first server exit')
  })

  test('kill -9 of the server leaves a stale lock and an intact log; the next start recovers silently', async () => {
    const a = startServer()
    const port = await a.ready
    for (let i = 0; i < 5; i++) assert.equal((await register(port, `k${i}@rd.dev`)).status, 201)
    a.kill('SIGKILL')
    await a.exited.catch(() => {})
    assert.ok(fs.existsSync(path.join(a.dataDir, 'LOCK')))
    const b = startServer({ RD_DATA_DIR: a.dataDir })
    const port2 = await b.ready
    assert.equal((await register(port2, 'k3@rd.dev')).status, 409)
    assert.equal((await register(port2, 'k9@rd.dev')).status, 201)
    b.kill('SIGTERM')
    assert.equal((await within(b.exited, 10_000, 'exit')).code, 0)
  })

  const wrapper = (extra) => `process.argv[1] = ${JSON.stringify(path.join(ROOT, 'server.js'))}; await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'server.js')).href)}); ${extra}`

  test('unhandled rejections are logged and survived; uncaught exceptions are logged, then the db is flushed and the process exits 1', async () => {
    const s = startServer({}, { script: wrapper(`setTimeout(() => { Promise.reject(new Error('rejected-on-purpose')) }, 1200); setTimeout(() => { throw new Error('thrown-on-purpose') }, 2200)`) })
    const port = await s.ready
    assert.equal((await register(port, 'before-crash@rd.dev')).status, 201)
    await sleep(1700)
    assert.match(s.err, /unhandled promise rejection #1: Error: rejected-on-purpose/)
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200, 'still serving after an unhandled rejection')
    const { code } = await within(s.exited, 10_000, 'exit after uncaught exception')
    assert.equal(code, 1)
    assert.match(s.err, /uncaught exception: Error: thrown-on-purpose/)
    assert.match(s.err + s.out, /shutdown complete/)
    assert.ok(!fs.existsSync(path.join(s.dataDir, 'LOCK')))
    const db = open(s.dataDir)
    assert.equal(db.find('users').filter((u) => u.email === 'before-crash@rd.dev').length, 1)
    db.close()
  })

  test('RD_CRASH_ON_UNHANDLED=1 makes an unhandled rejection fatal', async () => {
    const s = startServer({ RD_CRASH_ON_UNHANDLED: '1' }, { script: wrapper(`setTimeout(() => { Promise.reject(new Error('fatal-rejection')) }, 800)`) })
    await s.ready
    const { code } = await within(s.exited, 10_000, 'exit')
    assert.equal(code, 1)
    assert.match(s.err, /fatal-rejection/)
  })
})
