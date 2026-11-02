import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { startTestApp } from './helpers.js'
import { lex, splitStatements, parseScript, scanExplain, GuardError } from '../src/sql-guard.js'

async function withApp(fn, env = {}) {
  const old = {}
  for (const [k, v] of Object.entries(env)) { old[k] = process.env[k]; process.env[k] = v }
  const app = await startTestApp()
  try { await fn(app) } finally {
    await app.close()
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
}
const mkdb = async (u, name = 'main') => (await u.call('POST', '/api/sql', { body: { name } })).data
const query = (u, id, sql, extra = {}) => u.call('POST', `/api/sql/${id}/query`, { body: { sql, ...extra } })
const rows = (r) => r.data.results.at(-1).rows

/* ------------------------------------------------------------------ guard unit tests (no processes) */
test('guard: lexer understands strings, comments and quoted identifiers', () => {
  const ok = (sql) => parseScript(sql)
  ok("select 'attach database x' as s")
  ok('select "attach" from t')
  ok('select [vacuum] from t')
  ok('select 1 /* attach x as y */')
  ok('select 1 -- vacuum into x')
  ok("select 'it''s; attach ' as s")
  assert.equal(parseScript('select 1; select 2; ;; ').length, 2)
  const bad = (sql, re) => assert.throws(() => parseScript(sql), (e) => e instanceof GuardError && (!re || re.test(e.message)), sql)
  bad("select 'unterminated", /Unterminated/)
  bad('select 1 /* unterminated', /Unterminated/)
  bad('select "x', /Unterminated/)
  bad('select [x', /Unterminated/)
  bad('select 1\u0000; attach', /control/)
  bad('select \u0007', /control/)
  bad('', /No SQL/)
  bad('   -- only a comment', /No SQL/)
  bad('x'.repeat(100 * 1024 + 1), /larger/)
  bad(Array.from({ length: 51 }, () => 'select 1').join(';'), /At most/)
})

test('guard: dangerous statements and functions are refused in every spelling', () => {
  const bad = (sql) => assert.throws(() => parseScript(sql), GuardError, sql)
  for (const sql of [
    "attach 'x' as y", "ATTACH DATABASE 'x' AS y", "aTtAcH 'x' as y", "/**/attach/**/'x'/**/as y", "-- c\nattach 'x' as y", "select 1;attach 'x' as y", "select 1 /* ; */ ; attach 'x' as y",
    "select 1;\n--;\nattach 'x' as y", "detach y", "vacuum", "vacuum into '/tmp/x'", "explain attach 'x' as y", "explain query plan vacuum",
    'select load_extension(\'x\')', "select readfile('/etc/passwd')", "select writefile('/tmp/x','y')", "select fts3_tokenizer('simple')",
    'select * from pragma_database_list', 'select * from pragma_table_info("t")', 'select * from PRAGMA_function_list',
    'select * from sqlite_dbpage', 'select * from dbstat', 'create virtual table v using dbstat', 'create virtual table v using csv(filename=\'/etc/passwd\')', 'create virtual table v using zipfile(\'x\')',
    'pragma writable_schema=1', 'pragma journal_mode=off', 'pragma journal_mode', 'pragma query_only=0', 'pragma temp_store_directory=\'/tmp\'', 'pragma database_list', 'pragma synchronous=0',
    'pragma main.writable_schema = ON', 'pragma trusted_schema=1', 'pragma max_page_count=999999999', 'pragma hard_heap_limit=0', 'pragma wal_checkpoint', 'pragma locking_mode=exclusive',
    'begin', 'begin immediate', 'commit', 'end', 'rollback', 'savepoint a', 'release a', 'explain begin',
    'select 1; begin; select 2', 'with x as (select 1) attach', 'create trigger t after insert on a begin attach \'x\' as y; end',
    'reindex; vacuum', 'drop table t; vacuum',
  ]) bad(sql)
  for (const sql of ['load', 'select 1; foo', 'unknown stmt', 'set x=1', 'call p()', 'copy t to x', 'show tables']) bad(sql)
})

test('guard: the PRAGMA allowlist allows only introspection and a few safe settings', () => {
  for (const sql of ['pragma table_info(t)', 'pragma main.table_xinfo(t)', 'pragma index_list(t)', 'pragma foreign_keys', 'pragma foreign_keys = ON', 'pragma user_version = 5', 'pragma integrity_check', 'pragma page_count', 'pragma foreign_key_list(t)']) parseScript(sql)
  assert.throws(() => parseScript('pragma user_version = 5', { readOnly: true }), GuardError)
  assert.throws(() => parseScript('pragma page_size = 512'), GuardError)
})

test('guard: statement splitting keeps trigger bodies together and each statement keeps its exact text', () => {
  const sql = "select 1; create trigger tr after insert on t begin update t set a = case when new.a > 1 then 1 else 2 end; delete from u; end; insert into t values ('a;b'); -- tail\nselect 3"
  const parsed = parseScript(sql)
  assert.equal(parsed.length, 4)
  assert.match(parsed[1].text, /^create trigger tr[\s\S]*delete from u; end$/)
  assert.equal(parsed[2].text, "insert into t values ('a;b')")
  assert.equal(parsed[3].text, 'select 3')
  assert.equal(parseScript('explain query plan select 1')[0].inner, 'select 1')
  assert.equal(splitStatements(lex('a;b;;c')).length, 3)
})

test('guard layer 2: SQLite bytecode is inspected independently of the lexer', () => {
  const dbh = new DatabaseSync(':memory:')
  const scan = (sql) => scanExplain(dbh.prepare(`EXPLAIN ${sql}`).all())
  assert.throws(() => scan("ATTACH '/tmp/never.db' AS x"), /not allowed/)
  assert.throws(() => scan("ATTACH ('/tm' || 'p/never.db') AS x"), /not allowed/)
  assert.throws(() => scan('DETACH x'), /not allowed/)
  assert.throws(() => scan('VACUUM'), /VACUUM/)
  assert.throws(() => scan("VACUUM INTO '/tmp/never2.db'"), /VACUUM/)
  assert.throws(() => scan('PRAGMA journal_mode=DELETE'), /journal/i)
  assert.throws(() => scan("select load_extension('x')"), /not allowed/)
  dbh.exec('create table t(a)')
  for (const sql of ['select 1', 'insert into t values (1)', 'create table u(a)', 'select * from t where a in (select a from t)', 'pragma table_info(t)', "select json_each.value from json_each('[1,2]')"]) scan(sql)
  assert.equal(fs.existsSync('/tmp/never.db') || fs.existsSync('/tmp/never2.db'), false, 'EXPLAIN never executes')
  dbh.close()
})

/* ------------------------------------------------------------------ service behaviour */
test('databases: create/list/delete, validation, per-user plan quota, isolation', async () => {
  await withApp(async (app) => {
    const u = await app.register(), v = await app.register()
    for (const bad of ['', 'A', '1a', 'a b', 'a/b', '../x', 'x'.repeat(49), null, 5]) assert.equal((await u.call('POST', '/api/sql', { body: { name: bad } })).status, 400, JSON.stringify(bad))
    const a = await mkdb(u, 'alpha')
    assert.match(a.id, /^sqd_[0-9a-f]{16}$/)
    assert.equal((await u.call('POST', '/api/sql', { body: { name: 'alpha' } })).status, 409)
    assert.equal((await mkdb(v, 'alpha')).name, 'alpha', 'names are per user')
    await mkdb(u, 'beta'); await mkdb(u, 'gamma')
    assert.equal((await u.call('POST', '/api/sql', { body: { name: 'delta' } })).status, 402, 'free plan allows 3 databases')
    assert.equal((await u.call('GET', '/api/sql')).data.databases.length, 3)
    assert.equal((await v.call('GET', '/api/sql')).data.databases.length, 1)
    // isolation: every endpoint answers 404 for someone else's database
    for (const [m, p, body] of [['GET', `/api/sql/${a.id}`], ['DELETE', `/api/sql/${a.id}`], ['POST', `/api/sql/${a.id}/query`, { sql: 'select 1' }], ['GET', `/api/sql/${a.id}/select?sql=select%201`], ['GET', `/api/sql/${a.id}/schema`],
      ['GET', `/api/sql/${a.id}/history`], ['GET', `/api/sql/${a.id}/export`], ['POST', `/api/sql/${a.id}/snapshots`, {}], ['GET', `/api/sql/${a.id}/migrations`], ['POST', `/api/sql/${a.id}/explain`, { sql: 'select 1' }]]) {
      assert.equal((await v.call(m, p, body ? { body } : {})).status, 404, `${m} ${p}`)
    }
    for (const bad of ['../../etc/passwd', 'sqd_zzzz', 'sqd_0000000000000000/../x', '..']) assert.equal((await u.call('GET', `/api/sql/${encodeURIComponent(bad)}`)).status, 404)
    const file = path.join(app.ctx.sqlWorkers.dir, `${a.id}.sqlite`)
    await query(u, a.id, 'create table t(a)')
    assert.ok(fs.existsSync(file))
    assert.equal((await u.call('DELETE', `/api/sql/${a.id}`)).status, 200)
    assert.equal(fs.existsSync(file), false, 'the file is removed')
    assert.equal(app.db.find('sql_history', (h) => h.dbId === a.id).length, 0)
    assert.equal((await app.call('GET', '/api/sql')).status, 401)
  })
})

test('queries: parameters, types, multi-statement results, bigints, blobs, truncation', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    const { id } = await mkdb(u)
    const r1 = await query(u, id, 'create table t(id integer primary key, name text, n real, b blob, big integer); insert into t(name, n) values (:name, :n); select * from t where name = :name', { params: { name: 'ann', ':n': 1.5 } })
    assert.equal(r1.status, 400, 'parameters need a single statement')
    await query(u, id, 'create table t(id integer primary key, name text, n real, b blob, big integer)')
    const ins = await query(u, id, 'insert into t(name, n, b, big) values (?, ?, ?, ?) returning id', { params: ['ann', 1.5, { $blob: Buffer.from('hi').toString('base64') }, 1] })
    assert.equal(ins.data.results[0].rows[0][0], 1)
    assert.equal(ins.data.results[0].changes, 1)
    await query(u, id, 'insert into t(name, big) values (?, 9007199254740993)', { params: ["o'brien"] })
    const sel = await query(u, id, 'select id, name, n, b, big, null as z from t order by id')
    const res = sel.data.results[0]
    assert.deepEqual(res.columns, ['id', 'name', 'n', 'b', 'big', 'z'])
    assert.deepEqual(res.rows[0].slice(0, 3), [1, 'ann', 1.5]); assert.deepEqual(res.rows[0][3], { $blob: Buffer.from('hi').toString('base64'), bytes: 2 })
    assert.equal(res.rows[1][4], '9007199254740993', 'integers beyond 2^53 are returned as strings, not corrupted')
    assert.equal(res.rows[1][5], null)
    assert.deepEqual((await query(u, id, 'select name from t where name = :n', { params: { n: "o'brien" } })).data.results[0].rows, [["o'brien"]])
    assert.deepEqual((await query(u, id, 'select ?1 + ?2 as s', { params: [2, 3] })).data.results[0].rows, [[5]])
    assert.deepEqual((await query(u, id, 'select ? as t, ? as f', { params: [true, false] })).data.results[0].rows, [[1, 0]])
    // empty result sets still report columns
    assert.deepEqual((await query(u, id, 'select id, name from t where 0')).data.results[0].columns, ['id', 'name'])
    // multi statement results
    const multi = await query(u, id, 'select 1 as a; select 2 as b; update t set n = 9 where id = 1; select count(*) as c from t')
    assert.equal(multi.data.results.length, 4); assert.equal(multi.data.results[2].changes, 1); assert.equal(multi.data.results[3].rows[0][0], 2)
    // limits
    for (let i = 0; i < 50; i++) await query(u, id, 'insert into t(name) values (?)', { params: [`n${i}`] })
    const lim = (await query(u, id, 'select * from t', { maxRows: 10 })).data.results[0]
    assert.equal(lim.rowCount, 10); assert.equal(lim.truncated, true)
    assert.equal((await query(u, id, 'select 1', { maxRows: 0 })).status, 400)
    assert.equal((await query(u, id, 'select 1', { maxRows: 100000 })).status, 400)
    const big = (await query(u, id, "select replace(hex(zeroblob(100000)), '00', 'ab') as s")).data.results[0]
    assert.ok(big.rows[0][0].endsWith('[truncated]') && big.truncatedCells === 1, 'a single huge cell is cut')
    // parameter validation
    for (const params of [[{}], [[1]], { 'a b': 1 }, 'x', [{ nested: { x: 1 } }], Array.from({ length: 1001 }, () => 1)]) {
      assert.equal((await query(u, id, 'select ?', { params })).status, 400, JSON.stringify(params)?.slice(0, 30))
    }
    assert.equal((await query(u, id, 'select 1', { timeoutMs: 5 })).status, 400)
    assert.equal((await query(u, id, 'select 1', { sql: 5 })).status, 400)
    assert.equal((await u.call('POST', `/api/sql/${id}/query`, { body: {} })).status, 400)
  })
})

test('SQL errors are reported cleanly and never crash the service', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    const { id } = await mkdb(u)
    for (const sql of ['selec 1', 'select * from nope', 'create table t(a, a)', 'insert into nope values (1)', 'select 1 +', 'create table x(a primary key, b references missing(id)); insert into x values (1, 2)']) {
      const r = await query(u, id, sql)
      assert.ok(r.status === 400 && typeof r.data.error === 'string', `${sql} -> ${r.status}`)
    }
    assert.equal((await query(u, id, 'select 1')).status, 200, 'still healthy')
    assert.ok(app.db.find('sql_history', (h) => h.dbId === id && !h.ok).length >= 5)
  })
})

test('transactions: {transaction:true} is atomic; explicit BEGIN/COMMIT are refused; no transaction leaks between requests', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    const { id } = await mkdb(u)
    await query(u, id, 'create table t(a integer primary key)')
    const bad = await query(u, id, 'insert into t values (1); insert into t values (2); insert into t values (1)', { transaction: true })
    assert.equal(bad.status, 400)
    assert.equal(rows(await query(u, id, 'select count(*) from t'))[0][0], 0, 'everything rolled back')
    const ok = await query(u, id, 'insert into t values (1); insert into t values (2)', { transaction: true })
    assert.equal(ok.status, 200)
    assert.equal(rows(await query(u, id, 'select count(*) from t'))[0][0], 2)
    for (const sql of ['begin', 'begin; insert into t values (9)', 'insert into t values (10); commit', 'savepoint a']) assert.equal((await query(u, id, sql)).status, 400, sql)
    assert.equal(rows(await query(u, id, 'select count(*) from t'))[0][0], 2)
    // without the flag, statements are autocommitted one by one
    await query(u, id, 'insert into t values (5); insert into t values (5)')
    assert.equal(rows(await query(u, id, 'select count(*) from t'))[0][0], 3)
  })
})

test('SECURITY: no way to reach other files - attach/vacuum/pragmas/functions never touch the filesystem', async () => {
  await withApp(async (app) => {
    const u = await app.register(), v = await app.register()
    const mine = await mkdb(u, 'mine'), theirs = await mkdb(v, 'theirs')
    await query(v, theirs.id, "create table secret(x); insert into secret values ('top secret')")
    const theirFile = path.join(app.ctx.sqlWorkers.dir, `${theirs.id}.sqlite`)
    const planted = path.join(os.tmpdir(), `rd-attack-${process.pid}-${Date.now()}`)
    const attempts = [
      `attach '${theirFile}' as x; select * from x.secret`, `ATTACH DATABASE '${theirFile}' AS x`, `attach database "${theirFile}" as x`, `select 1; /**/ attach '${theirFile}' as x`,
      `attach '${planted}.db' as x; create table x.t(a)`, `vacuum into '${planted}.vac'`, `vacuum main into '${planted}.vac2'`, `explain attach '${theirFile}' as x`,
      `select load_extension('${planted}.so')`, `select readfile('${theirFile}')`, `select writefile('${planted}.w', 'x')`,
      `pragma journal_mode = wal`, `pragma temp_store_directory = '${os.tmpdir()}'`, `pragma writable_schema = 1; update sqlite_master set sql = 'x'`, `pragma query_only = 0`,
      `select * from pragma_database_list`, `select file from pragma_database_list`, `select * from sqlite_dbpage`, `select * from dbstat`, `create virtual table z using dbstat`,
      `with recursive c(x) as (select 1) select * from c; attach '${planted}.db3' as q`, `select 'x' as a; attach '${planted}.db4' as q;`,
      `create trigger tg after insert on t begin attach '${planted}.db5' as q; end`, ` attach '${planted}.db6' as q`, `att/**/ach '${planted}.db7' as q`,
    ]
    for (const sql of attempts) {
      const r = await query(u, mine.id, sql)
      assert.ok(r.status >= 400 && r.status < 500, `must be refused: ${sql} -> ${r.status} ${JSON.stringify(r.data).slice(0, 120)}`)
      assert.ok(!JSON.stringify(r.data).includes('top secret'))
    }
    for (const f of fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(`rd-attack-${process.pid}`))) assert.fail(`attack created ${f}`)
    assert.equal(rows(await query(v, theirs.id, 'select x from secret'))[0][0], 'top secret', "the victim's database is intact")
    assert.equal((await query(u, mine.id, 'select 1')).status, 200, 'the attacker database still works')
    // the database list of the connection only ever contains main (checked by the worker itself via a safe internal path)
    const schema = (await u.call('GET', `/api/sql/${mine.id}/schema`)).data
    assert.deepEqual(schema.tables, [])
  })
})

test('SECURITY: workers run with a scrubbed environment, limits and (when available) the permission model', async () => {
  await withApp(async (app) => {
    process.env.SUPER_SECRET_FOR_TEST = 'leak-me'
    const u = await app.register()
    const { id } = await mkdb(u)
    await query(u, id, 'select 1')
    assert.equal(app.ctx.sqlWorkers.count(), 1)
    // find the worker process and inspect it (Linux)
    if (process.platform === 'linux') {
      const pids = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))
      const workers = pids.filter((p) => { try { return fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').includes('sql-worker.js') && fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').includes(id) } catch { return false } })
      assert.ok(workers.length >= 1, 'worker process found')
      for (const p of workers) {
        const env = fs.readFileSync(`/proc/${p}/environ`, 'utf8')
        assert.ok(!env.includes('SUPER_SECRET_FOR_TEST') && !env.includes('ANTHROPIC') && !env.includes('RD_'), 'environment is scrubbed')
        const limits = fs.readFileSync(`/proc/${p}/limits`, 'utf8')
        assert.match(limits, /Max address space\s+\d+/, 'address space limit applied')
        assert.match(limits, /Max file size\s+\d+/, 'file size limit applied')
        const cmd = fs.readFileSync(`/proc/${p}/cmdline`, 'utf8')
        if (app.ctx.sqlWorkers.permissionModel) assert.ok(cmd.includes('--permission'), 'permission model flags')
      }
    }
    delete process.env.SUPER_SECRET_FOR_TEST
  })
})

test('RESOURCES: runaway queries are killed on timeout and the database keeps working', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    const { id } = await mkdb(u)
    await query(u, id, 'create table t(a); insert into t values (1),(2),(3)')
    await query(u, id, "insert into t select a from t; insert into t select a from t; insert into t select a from t; insert into t select a from t; insert into t select a from t; insert into t select a from t; insert into t select a from t; insert into t select a from t; insert into t select a from t; insert into t select a from t")
    const t0 = Date.now()
    const inf = await query(u, id, 'with recursive c(x) as (select 1 union all select x + 1 from c) select count(*) from c', { timeoutMs: 600 })
    assert.equal(inf.status, 408); assert.match(inf.data.error, /cancelled/)
    assert.ok(Date.now() - t0 < 5000)
    const cart = await query(u, id, 'select count(*) from t a, t b, t c, t d, t e', { timeoutMs: 600 })
    assert.equal(cart.status, 408, 'cartesian product bomb')
    assert.equal(rows(await query(u, id, 'select count(*) from t'))[0][0], 3072, 'data intact, worker restarted transparently')
    // a timed-out write does not leave a half-applied transaction
    const w = await query(u, id, "insert into t select a from t; with recursive c(x) as (select 1 union all select x + 1 from c) select count(*) from c", { timeoutMs: 600, transaction: true })
    assert.equal(w.status, 408)
    assert.equal(rows(await query(u, id, 'select count(*) from t'))[0][0], 3072, 'transaction rolled back by the crash')
  }, { RD_SQL_MAX_TIMEOUT_MS: '2000' })
})

test('RESOURCES: memory bombs fail inside the worker, not the platform', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    const { id } = await mkdb(u)
    const rss0 = process.memoryUsage().rss
    for (const sql of ['select length(hex(randomblob(900000000)))', "select length(replace(hex(randomblob(400000000)), '0', '00'))", "select length(printf('%.*c', 900000000, 'x'))", 'select length(zeroblob(2000000000))']) {
      const r = await query(u, id, sql, { timeoutMs: 10_000 })
      assert.ok(r.status === 400 || r.status === 500 || r.status === 200, `${sql} -> ${r.status}`)
    }
    assert.ok(process.memoryUsage().rss - rss0 < 400 * 1024 * 1024, 'the platform process did not balloon')
    assert.equal((await query(u, id, 'select 1')).status, 200, 'service still healthy afterwards')
  }, { RD_SQL_MEM_MB: '1024' })
})

test('RESOURCES: result size caps, database size cap, concurrency and worker-count limits', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    const { id } = await mkdb(u)
    await query(u, id, 'create table t(a text)')
    const fill = await query(u, id, "with recursive c(x) as (select 1 union all select x + 1 from c where x < 5000) insert into t select hex(randomblob(50)) from c")
    assert.equal(fill.status, 200)
    const r = (await query(u, id, 'select * from t', { maxRows: 10_000 })).data.results[0]
    assert.equal(r.rowCount, 5000)
    // database size cap: RD_SQL_MAX_DB_BYTES is 1 MiB for this app
    let full = null
    for (let i = 0; i < 40 && !full; i++) {
      const w = await query(u, id, 'insert into t select hex(randomblob(500)) from t limit 2000')
      if (w.status !== 200) full = w
    }
    assert.ok(full, 'the size cap kicked in')
    assert.equal(full.status, 413); assert.match(full.data.error, /full/)
    assert.equal(rows(await query(u, id, 'select count(*) from t'))[0][0] >= 5000, true, 'reads and earlier data are unaffected')
    const size = (await u.call('GET', `/api/sql/${id}`)).data.sizeBytes
    assert.ok(size <= 1024 * 1024 + 8192, `database stayed within its cap (${size})`)
    // concurrency: more than 3 simultaneous queries per user are refused
    const slow = 'with recursive c(x) as (select 1 union all select x + 1 from c where x < 3000000) select count(*) from c'
    const dbs = [id]
    for (const n of ['b', 'c', 'd']) { const d = await mkdb(u, n); if (d.id) dbs.push(d.id) }
    const results = await Promise.all(dbs.map((d) => query(u, d, slow, { timeoutMs: 8000 })))
    assert.ok(results.some((x) => x.status === 429) || dbs.length < 4, `statuses: ${results.map((x) => x.status)}`)
  }, { RD_SQL_MAX_DB_BYTES: String(1024 * 1024), RD_QUOTAS_DISABLED: '1' })
})

test('RESOURCES: the worker pool evicts idle workers when over the cap', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    const ids = []
    for (const n of ['a', 'b', 'c', 'd']) ids.push((await mkdb(u, n)).id)
    for (let round = 0; round < 2; round++) for (const id of ids) assert.equal((await query(u, id, 'select 1')).status, 200)
    assert.ok(app.ctx.sqlWorkers.count() <= 2, `workers: ${app.ctx.sqlWorkers.count()}`)
  }, { RD_SQL_MAX_PROCS: '2', RD_QUOTAS_DISABLED: '1' })
})

test('read-only access: GET /select, readOnly flag and read-only API keys cannot modify data', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    const { id } = await mkdb(u)
    await query(u, id, 'create table t(a); insert into t values (1)')
    const get = (sql, extra = '') => u.call('GET', `/api/sql/${id}/select?sql=${encodeURIComponent(sql)}${extra}`)
    assert.equal((await get('select a from t')).data.results[0].rows[0][0], 1)
    assert.equal((await get('select ?+1', `&params=${encodeURIComponent('[41]')}`)).data.results[0].rows[0][0], 42)
    for (const sql of ['insert into t values (2)', 'delete from t', 'drop table t', 'create table x(a)', 'update t set a = 5', 'with x as (select 1) insert into t select * from x', 'pragma user_version = 3']) {
      assert.equal((await get(sql)).status, 400, sql)
      assert.equal((await query(u, id, sql, { readOnly: true })).status, 400, `readOnly: ${sql}`)
    }
    assert.equal(rows(await query(u, id, 'select count(*) from t'))[0][0], 1)
    assert.equal((await query(u, id, 'explain query plan insert into t values (1)', { readOnly: true })).status, 200, 'EXPLAIN of a write is allowed but writes nothing')
    assert.equal(rows(await query(u, id, 'select count(*) from t'))[0][0], 1)
    // API key with read-only db scope
    const key = (await u.call('POST', '/api/keys', { body: { name: 'ro', scopes: ['db:read'] } })).data.secret
    const kcall = (m, p, body) => app.call(m, p, { token: key, ...(body ? { body } : {}) })
    assert.equal((await kcall('GET', `/api/sql/${id}/select?sql=select%20count(*)%20from%20t`)).status, 200)
    assert.equal((await kcall('POST', `/api/sql/${id}/query`, { sql: 'insert into t values (3)' })).status, 403, 'the key cannot POST')
    assert.equal((await kcall('GET', `/api/sql/${id}/select?sql=${encodeURIComponent('insert into t values (3)')}`)).status, 400)
    assert.equal(rows(await query(u, id, 'select count(*) from t'))[0][0], 1)
  })
})

test('schema introspection, table viewer, explain, history and saved queries', async () => {
  await withApp(async (app) => {
    const u = await app.register(), v = await app.register()
    const { id } = await mkdb(u)
    await query(u, id, 'create table author(id integer primary key, name text not null); create table book(id integer primary key, author_id integer references author(id), title text default \'x\'); create index idx_b on book(author_id); create view v1 as select * from book')
    await query(u, id, "insert into author(name) values ('a'),('b'),('c'); insert into book(author_id, title) values (1,'t1'),(1,'t2')")
    const schema = (await u.call('GET', `/api/sql/${id}/schema`)).data
    assert.deepEqual(schema.tables.map((t) => t.name), ['author', 'book', 'v1'])
    const book = schema.tables.find((t) => t.name === 'book')
    assert.equal(book.rowCount, 2); assert.deepEqual(book.foreignKeys, [{ from: 'author_id', table: 'author', to: 'id' }])
    assert.equal(book.columns.find((c) => c.name === 'id').primaryKey, true)
    assert.deepEqual(schema.indexes.map((i) => i.name), ['idx_b'])
    const tv = (await u.call('GET', `/api/sql/${id}/tables/author?limit=2`)).data
    assert.equal(tv.rows.length, 2); assert.equal(tv.total, 3); assert.deepEqual(tv.columns, ['id', 'name'])
    assert.equal((await u.call('GET', `/api/sql/${id}/tables/sqlite_master`)).status, 400)
    assert.equal((await u.call('GET', `/api/sql/${id}/tables/${encodeURIComponent('author"; drop table book; --')}`)).status, 400)
    assert.equal(rows(await query(u, id, 'select count(*) from book'))[0][0], 2)
    const ex = await u.call('POST', `/api/sql/${id}/explain`, { body: { sql: 'select * from book where author_id = 1' } })
    assert.equal(ex.status, 200); assert.match(JSON.stringify(ex.data.results[0].rows), /idx_b|SEARCH|SCAN/)
    assert.equal((await u.call('POST', `/api/sql/${id}/explain`, { body: { sql: 'select 1; select 2' } })).status, 400)
    const hist = (await u.call('GET', `/api/sql/${id}/history`)).data.history
    assert.ok(hist.length >= 3 && hist[0].ms >= 0)
    assert.equal((await v.call('GET', `/api/sql/${id}/history`)).status, 404)
    assert.equal((await u.call('DELETE', `/api/sql/${id}/history`)).status, 200)
    assert.equal((await u.call('GET', `/api/sql/${id}/history`)).data.history.length, 0)
    const s = (await u.call('POST', `/api/sql/${id}/saved`, { body: { name: 'books', sql: 'select * from book' } })).data
    assert.equal((await u.call('GET', `/api/sql/${id}/saved`)).data.saved.length, 1)
    assert.equal((await u.call('POST', `/api/sql/${id}/saved`, { body: { name: '', sql: 'x' } })).status, 400)
    assert.equal((await v.call('DELETE', `/api/sql/${id}/saved/${s.id}`)).status, 404)
    assert.equal((await u.call('DELETE', `/api/sql/${id}/saved/${s.id}`)).status, 200)
    for (let i = 0; i < 105; i++) await query(u, id, 'select 1')
    assert.ok(app.db.find('sql_history', (h) => h.dbId === id).length <= 100, 'history is bounded')
  })
})

test('import/export: CSV and JSON import with type inference, CSV export, SQL dump round trip', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    const { id } = await mkdb(u)
    const csv = 'Name,Age,Score,Notes\r\n"Smith, Ann",31,1.5,"line1\nline2"\r\nBob,25,2,\r\n"=cmd|\' /c calc\'!A1",40,3.25,x\r\n'
    const imp = await u.call('POST', `/api/sql/${id}/import?table=people&format=csv`, { raw: csv, headers: { 'content-type': 'text/csv' } })
    assert.equal(imp.status, 201); assert.equal(imp.data.inserted, 3)
    assert.deepEqual(imp.data.columns.map((c) => [c.name, c.type]), [['name', 'TEXT'], ['age', 'INTEGER'], ['score', 'REAL'], ['notes', 'TEXT']])
    const got = rows(await query(u, id, 'select name, age, notes from people order by age'))
    assert.deepEqual(got[1], ['Smith, Ann', 31, 'line1\nline2'])
    assert.equal(got[0][2], null)
    const j = await u.call('POST', `/api/sql/${id}/import?table=items&format=json`, { raw: JSON.stringify([{ a: 1, b: 'x' }, { a: 2, c: true, d: { n: 1 } }]), headers: { 'content-type': 'application/json' } })
    assert.equal(j.status, 201); assert.equal(j.data.inserted, 2)
    for (const [qs, body] of [['table=bad-name', 'a\n1'], ['table=sqlite_x', 'a\n1'], ['table=%22%3B', 'a\n1'], ['table=t', ''], ['table=t&format=xml', 'x'], ['table=t&format=csv', 'a\n']]) {
      assert.equal((await u.call('POST', `/api/sql/${id}/import?${qs}`, { raw: body })).status === 201, false, qs)
    }
    assert.equal((await u.call('POST', `/api/sql/${id}/import?table=t&format=json`, { raw: '{"not":"an array"}' })).status, 400)
    assert.equal((await u.call('POST', `/api/sql/${id}/import?table=t&format=csv`, { raw: 'a\n"unterminated' })).status, 400)
    const big = 'x'.repeat(6 * 1024 * 1024)
    assert.equal((await u.call('POST', `/api/sql/${id}/import?table=t&format=csv`, { raw: big })).status, 413)
    // exports
    const exp = await u.call('GET', `/api/sql/${id}/export?format=csv&table=people`)
    assert.match(exp.headers.get('content-type'), /text\/csv/); assert.match(exp.headers.get('content-disposition'), /people\.csv/)
    assert.match(exp.data, /^name,age,score,notes\r\n/)
    assert.ok(exp.data.includes("'=cmd|"), 'formula injection is neutralised in CSV exports')
    assert.ok(!/^=/m.test(exp.data))
    const jexp = await u.call('GET', `/api/sql/${id}/export?format=json&sql=${encodeURIComponent('select name, age from people where age < 40 order by age')}`)
    assert.deepEqual(jexp.data, [{ name: 'Bob', age: 25 }, { name: 'Smith, Ann', age: 31 }])
    assert.equal((await u.call('GET', `/api/sql/${id}/export?format=csv`)).status, 400)
    assert.equal((await u.call('GET', `/api/sql/${id}/export?format=csv&sql=${encodeURIComponent('delete from people')}`)).status, 400)
    assert.equal((await u.call('GET', `/api/sql/${id}/export?format=pdf`)).status, 400)
    // SQL dump round trip into a second database
    await query(u, id, "create table blobs(b blob, t text); insert into blobs values (x'00ff10', 'it''s'); create index ib on blobs(t)")
    const dump = (await u.call('GET', `/api/sql/${id}/export?format=sql`)).data.toString()
    assert.match(dump, /CREATE TABLE/i)
    const two = await mkdb(u, 'copy')
    const restore = await query(u, two.id, dump, { transaction: true })
    assert.equal(restore.status, 200, JSON.stringify(restore.data).slice(0, 200))
    assert.deepEqual(rows(await query(u, two.id, 'select hex(b), t from blobs'))[0], ['00FF10', "it's"])
    assert.equal(rows(await query(u, two.id, 'select count(*) from people'))[0][0], 3)
  }, { RD_QUOTAS_DISABLED: '1' })
})

test('snapshots: create, restore (with a safety snapshot), delete, limits, confirmation, isolation', async () => {
  await withApp(async (app) => {
    const u = await app.register(), v = await app.register()
    const { id } = await mkdb(u)
    await query(u, id, 'create table t(a); insert into t values (1),(2)')
    const snap = (await u.call('POST', `/api/sql/${id}/snapshots`, { body: { label: 'two rows' } })).data
    assert.ok(snap.sizeBytes > 0)
    await query(u, id, 'insert into t values (3); drop table t; create table other(x)')
    assert.equal((await v.call('POST', `/api/sql/${id}/snapshots/${snap.id}/restore`, { body: { confirm: true } })).status, 404)
    assert.equal((await u.call('POST', `/api/sql/${id}/snapshots/${snap.id}/restore`, { body: {} })).status, 400, 'needs confirm')
    const restored = await u.call('POST', `/api/sql/${id}/snapshots/${snap.id}/restore`, { body: { confirm: true } })
    assert.equal(restored.status, 200)
    assert.equal(rows(await query(u, id, 'select count(*) from t'))[0][0], 2, 'back to the snapshot state')
    assert.equal((await query(u, id, 'select * from other')).status, 400, 'later changes are gone')
    const list = (await u.call('GET', `/api/sql/${id}/snapshots`)).data.snapshots
    assert.ok(list.some((s) => /before restore/.test(s.label)), 'the pre-restore state was kept')
    // the safety snapshot can bring the later state back
    const safety = list.find((s) => /before restore/.test(s.label))
    await u.call('POST', `/api/sql/${id}/snapshots/${safety.id}/restore`, { body: { confirm: true } })
    assert.equal((await query(u, id, 'select * from other')).status, 200)
    assert.equal((await u.call('DELETE', `/api/sql/${id}/snapshots/${snap.id}`)).status, 200)
    assert.equal((await u.call('DELETE', `/api/sql/${id}/snapshots/${snap.id}`)).status, 404)
    assert.equal((await u.call('POST', `/api/sql/${id}/snapshots/sns_000000000000/restore`, { body: { confirm: true } })).status, 404)
    for (let i = 0; i < 12; i++) { const r = await u.call('POST', `/api/sql/${id}/snapshots`, { body: {} }); if (r.status === 409) { assert.ok(i >= 5); return } }
    assert.fail('snapshot cap not enforced')
  })
})

test('migrations: ordered, atomic, idempotent, drift detected', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    const { id } = await mkdb(u)
    const mig = (version, sql, name = `m${version}`) => u.call('POST', `/api/sql/${id}/migrations`, { body: { version, name, sql } })
    assert.equal((await mig(1, 'create table a(id integer primary key)')).status, 201)
    assert.equal((await mig(1, 'create table a(id integer primary key)')).data.alreadyApplied, true)
    assert.equal((await mig(1, 'create table a(other)')).status, 409, 'checksum drift')
    assert.equal((await mig(3, 'create table c(id)')).status, 201)
    assert.equal((await mig(2, 'create table b(id)')).status, 409, 'out of order')
    const failing = await mig(4, 'create table d(id); insert into nope values (1)')
    assert.equal(failing.status, 400)
    assert.equal((await query(u, id, 'select * from d')).status, 400, 'a failed migration is rolled back entirely')
    assert.equal((await u.call('GET', `/api/sql/${id}/migrations`)).data.migrations.map((m) => m.version).join(), '1,3', 'and not recorded')
    assert.equal((await mig(4, 'create table d(id)')).status, 201, 'can be fixed and re-applied')
    assert.equal((await mig(5, 'attach \'x\' as y')).status, 400, 'migrations go through the same guard')
    for (const body of [{ version: 0, name: 'x', sql: 'select 1' }, { version: 1.5, name: 'x', sql: 'select 1' }, { version: 9, name: '', sql: 'select 1' }, { version: 9, name: 'x', sql: '' }]) assert.equal((await u.call('POST', `/api/sql/${id}/migrations`, { body })).status, 400, JSON.stringify(body))
  })
})

test('metering and account deletion', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    const { id } = await mkdb(u)
    await query(u, id, 'select 1'); await query(u, id, 'select 2')
    const usage = (await u.call('GET', '/api/billing/usage')).data.lines.find((l) => l.kind === 'sql.query')
    assert.equal(usage.qty, 2)
    const file = path.join(app.ctx.sqlWorkers.dir, `${id}.sqlite`)
    assert.ok(fs.existsSync(file))
    app.ctx.events.emit('account.deleted', { userId: u.user.id })
    assert.equal(fs.existsSync(file), false)
    assert.equal(app.db.find('sql_databases', (d) => d.userId === u.user.id).length, 0)
    assert.equal(app.ctx.sqlWorkers.count(), 0)
  })
})
