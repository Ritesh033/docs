import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { startTestApp } from './helpers.js'

async function withApp(fn) {
  const app = await startTestApp()
  try { await fn(app) } finally { await app.close() }
}
const ins = async (u, c, data) => (await u.call('POST', `/api/db/${c}`, { body: data })).data
const q = async (u, c, body) => (await u.call('POST', `/api/db/${c}/query`, { body })).data
const names = (r) => r.documents.map((d) => d.data.n)

async function seed(u) {
  await ins(u, 'people', { n: 'ann', age: 31, tags: ['a', 'b'], addr: { city: 'Oslo' }, email: 'ann@x.io' })
  await ins(u, 'people', { n: 'bob', age: 25, tags: ['b'], addr: { city: 'Rome' } })
  await ins(u, 'people', { n: 'cy', age: 40, tags: [], addr: { city: 'Oslo' }, active: true })
  await ins(u, 'people', { n: 'di', age: '41', tags: ['a', 'b', 'c'], addr: { city: 'Paris' }, active: false })
}

test('compat: CRUD and equality queries keep working', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    const d = (await u.call('POST', '/api/db/todos', { body: { title: 't', done: false } }))
    assert.equal(d.status, 201); assert.equal(d.data.version, 1)
    assert.equal((await q(u, 'todos', { where: { done: false } })).documents.length, 1)
    const put = (await u.call('PUT', `/api/db/todos/${d.data.id}`, { body: { title: 't', done: true } })).data
    assert.equal(put.version, 2)
    assert.equal((await u.call('GET', `/api/db/todos/${d.data.id}`)).data.data.done, true)
    assert.equal((await u.call('GET', '/api/db/todos')).data.documents.length, 1)
    assert.equal((await u.call('DELETE', `/api/db/todos/${d.data.id}`)).status, 200)
    assert.equal((await u.call('GET', `/api/db/todos/${d.data.id}`)).status, 404)
    assert.equal((await u.call('GET', '/api/db/never-created')).data.documents.length, 0)
  })
})

test('query operators, nested paths, arrays and type strictness', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    await seed(u)
    assert.deepEqual(names(await q(u, 'people', { where: { age: { $gt: 25 } }, sort: 'age' })), ['ann', 'cy'], 'numbers never compare with strings')
    assert.deepEqual(names(await q(u, 'people', { where: { age: { $gte: 25, $lt: 40 } }, sort: '-age' })), ['ann', 'bob'])
    assert.deepEqual(names(await q(u, 'people', { where: { 'addr.city': 'Oslo' }, sort: 'n' })), ['ann', 'cy'])
    assert.deepEqual(names(await q(u, 'people', { where: { tags: 'a' }, sort: 'n' })), ['ann', 'di'], 'array membership')
    assert.deepEqual(names(await q(u, 'people', { where: { tags: { $all: ['a', 'b'] } }, sort: 'n' })), ['ann', 'di'])
    assert.deepEqual(names(await q(u, 'people', { where: { tags: { $size: 3 } } })), ['di'])
    assert.deepEqual(names(await q(u, 'people', { where: { n: { $in: ['bob', 'cy', 'zed'] } }, sort: 'n' })), ['bob', 'cy'])
    assert.deepEqual(names(await q(u, 'people', { where: { n: { $nin: ['bob', 'cy'] }, active: { $exists: true } } })), ['di'])
    assert.deepEqual(names(await q(u, 'people', { where: { $or: [{ n: 'bob' }, { age: { $gt: 39 } }] }, sort: 'n' })), ['bob', 'cy'], "di's age is the string '41' and never compares with a number")
    assert.deepEqual(names(await q(u, 'people', { where: { $not: { 'addr.city': 'Oslo' } }, sort: 'n' })), ['bob', 'di'])
    assert.deepEqual(names(await q(u, 'people', { where: { n: { $ne: 'ann' } }, sort: 'n' })), ['bob', 'cy', 'di'])
    assert.deepEqual(names(await q(u, 'people', { where: { email: { $contains: '@x.' } } })), ['ann'])
    assert.deepEqual(names(await q(u, 'people', { where: { n: { $startsWith: 'b' } } })), ['bob'])
    assert.deepEqual(names(await q(u, 'people', { where: { n: { $regex: '^(a|c)', $options: 'i' } }, sort: 'n' })), ['ann', 'cy'])
    assert.deepEqual(names(await q(u, 'people', { where: { $nor: [{ n: 'ann' }, { n: 'bob' }], tags: { $size: 0 } } })), ['cy'])
  })
})

test('query abuse: unknown operators, ReDoS patterns, prototype paths, oversized where', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    await seed(u)
    const bad = async (where, why) => assert.equal((await u.call('POST', '/api/db/people/query', { body: { where } })).status, 400, why)
    await bad({ n: { $where: 'sleep(1000)' } }, 'unknown operator')
    await bad({ $function: {} }, 'unknown top-level operator')
    await bad({ n: { $regex: '(a+)+$' } }, 'nested quantifier')
    await bad({ n: { $regex: '(.*)*x' } }, 'nested quantifier')
    await bad({ n: { $regex: '(a|aa)+$' } }, 'alternation in a repeated group')
    await bad({ n: { $regex: 'x'.repeat(65) } }, 'too long')
    await bad({ n: { $regex: '(a)\\1' } }, 'backreference')
    await bad({ n: { $regex: '(?=a)' } }, 'lookahead')
    await bad({ n: { $regex: 'a', $options: 'gms' } }, 'flags')
    await bad({ '__proto__.x': 1 }, 'prototype path')
    await bad({ 'constructor.prototype': 1 }, 'constructor path')
    await bad({ a: { $gt: { x: 1 } } }, 'non-scalar comparison')
    await bad({ a: { $in: 'x' } }, 'in needs array')
    await bad([], 'where must be an object')
    let deep = { n: 1 }
    for (let i = 0; i < 12; i++) deep = { $and: [deep] }
    await bad(deep, 'nesting depth')
    await bad({ $or: Array.from({ length: 21 }, () => ({ n: 1 })) }, 'too many branches')
    await bad(Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`f${i}`, 1])), 'too many clauses')
    assert.equal(Object.prototype.polluted, undefined)
    const t0 = Date.now()
    const evil = (await u.call('POST', '/api/db/people/query', { body: { where: { n: { $regex: '^(a.*)(b.*)(c.*)' } } } }))
    assert.equal(evil.status, 400, 'three .* sequences refused')
    assert.ok(Date.now() - t0 < 1000)
  })
})

test('documents are validated: shape, keys, depth, size, collection names', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    const post = (c, b) => u.call('POST', `/api/db/${c}`, { body: b })
    assert.equal((await post('c', [1, 2])).status, 400)
    assert.equal((await post('c', { '$set': 1 })).status, 400)
    assert.equal((await post('c', { 'a.b': 1 })).status, 400)
    assert.equal((await post('c', JSON.parse('{"__proto__": {"x":1}}'))).status, 400)
    assert.equal((await post('c', { nested: { constructor: 1 } })).status, 400)
    let deep = {}
    let cur = deep
    for (let i = 0; i < 25; i++) { cur.a = {}; cur = cur.a }
    assert.equal((await post('c', deep)).status, 400, 'depth')
    assert.equal((await post('c', { big: 'x'.repeat(300_000) })).status, 413)
    assert.equal((await post('c', { arr: new Array(10_001).fill(1) })).status, 413)
    for (const name of ['1abc', '_x', 'a b', 'a/b', 'x'.repeat(65), 'a.b']) assert.equal((await post(name, { a: 1 })).status === 201, false, name)
    assert.equal((await post('ok_name-1', { a: 1 })).status, 201)
    assert.equal(Object.prototype.x, undefined)
  })
})

test('pagination: offset, cursors across ties, projection, limits', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    for (let i = 0; i < 25; i++) await ins(u, 'p', { n: i, grp: i % 3, big: 'payload', nested: { a: i, b: 'x' } })
    const seen = []
    let cursor = null
    for (let guard = 0; guard < 10; guard++) {
      const r = await q(u, 'p', { sort: ['grp', '-n'], limit: 7, cursor })
      seen.push(...r.documents.map((d) => d.data.n))
      if (!r.nextCursor) break
      cursor = r.nextCursor
    }
    assert.equal(seen.length, 25); assert.equal(new Set(seen).size, 25, 'no duplicates or gaps across pages with tied sort keys')
    const expected = [...Array(25).keys()].sort((a, b) => (a % 3) - (b % 3) || b - a)
    assert.deepEqual(seen, expected)
    const off = await q(u, 'p', { sort: 'n', offset: 20, limit: 10 })
    assert.deepEqual(names2(off), [20, 21, 22, 23, 24]); assert.equal(off.total, 25)
    const pr = (await q(u, 'p', { where: { n: 3 }, project: ['nested.a', 'n'] })).documents[0]
    assert.deepEqual(pr.data, { n: 3, nested: { a: 3 } })
    for (const bad of [{ limit: 0 }, { limit: 5000 }, { limit: 'x' }, { offset: -1 }, { cursor: 'garbage' }, { sort: 'a,b,c,d' }, { project: 5 }]) assert.equal((await u.call('POST', '/api/db/p/query', { body: bad })).status, 400, JSON.stringify(bad))
    assert.equal((await u.call('GET', '/api/db/p?limit=3&sort=-n')).data.documents.map((d) => d.data.n).join(), '24,23,22')
  })
})
const names2 = (r) => r.documents.map((d) => d.data.n)

test('patch operators and optimistic concurrency', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    const d = await ins(u, 'c', { n: 1, tags: ['a'], o: { x: 1 } })
    const patch = (body, h) => u.call('PATCH', `/api/db/c/${d.id}`, { body, headers: h })
    let r = (await patch({ $set: { 'o.y': 2, name: 'z' }, $inc: { n: 4 }, $push: { tags: 'b' }, $unset: { 'o.x': 1 } })).data
    assert.deepEqual(r.data, { n: 5, tags: ['a', 'b'], o: { y: 2 }, name: 'z' }); assert.equal(r.version, 2)
    r = (await patch({ $pull: { tags: 'a' }, $addToSet: { tags: 'b' } })).data
    assert.deepEqual(r.data.tags, ['b'])
    assert.equal((await patch({ $set: { x: 1 } }, { 'if-match': '"1"' })).status, 412, 'stale version')
    assert.equal((await patch({ $set: { x: 1 } }, { 'if-match': '"3"' })).status, 200)
    assert.equal((await u.call('PUT', `/api/db/c/${d.id}`, { body: { a: 1 }, headers: { 'if-match': '3' } })).status, 412)
    assert.equal((await u.call('PUT', `/api/db/c/${d.id}?ifVersion=4`, { body: { a: 1 } })).status, 200)
    assert.equal((await u.call('DELETE', `/api/db/c/${d.id}`, { headers: { 'if-match': '1' } })).status, 412)
    assert.equal((await u.call('PUT', `/api/db/c/${d.id}`, { body: { a: 1 }, headers: { 'if-match': 'abc' } })).status, 400)
    for (const bad of [{}, { n: 1 }, { $rename: { a: 'b' } }, { $set: {} }, { $inc: { n: 'x' } }, { $inc: { 'a.b': 1 } }, { $push: { a: 1 } }, { $set: { '__proto__.x': 1 } }, { $set: { '$bad': 1 } }]) {
      const s = (await patch(bad)).status
      assert.ok(s === 400, `${JSON.stringify(bad)} -> ${s}`)
    }
    assert.equal(Object.prototype.x, undefined)
    assert.equal((await u.call('PATCH', '/api/db/c/doc_missing', { body: { $set: { a: 1 } } })).status, 404)
  })
})

test('batch: atomic with rollback of rows and indexes, cross-collection, compare-and-set', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    await u.call('POST', '/api/db/acct/indexes', { body: { field: 'owner', unique: true } })
    const a = await ins(u, 'acct', { owner: 'a', bal: 100 })
    const b = await ins(u, 'acct', { owner: 'b', bal: 50 })
    const ok = await u.call('POST', '/api/db/_batch', { body: { ops: [
      { op: 'check', collection: 'acct', id: a.id, ifVersion: 1 },
      { op: 'patch', collection: 'acct', id: a.id, patch: { $inc: { bal: -30 } }, ifVersion: 1 },
      { op: 'patch', collection: 'acct', id: b.id, patch: { $inc: { bal: 30 } } },
      { op: 'insert', collection: 'ledger', data: { from: 'a', to: 'b', amt: 30 } },
    ] } })
    assert.equal(ok.status, 200); assert.equal(ok.data.results.length, 4)
    assert.equal((await u.call('GET', `/api/db/acct/${a.id}`)).data.data.bal, 70)
    // failure on the last op rolls everything back
    const bad = await u.call('POST', '/api/db/_batch', { body: { ops: [
      { op: 'patch', collection: 'acct', id: a.id, patch: { $inc: { bal: -70 } } },
      { op: 'insert', collection: 'ledger', data: { amt: 70 } },
      { op: 'insert', collection: 'acct', data: { owner: 'b', bal: 1 } }, // unique violation
    ] } })
    assert.equal(bad.status, 409); assert.match(bad.data.error, /ops\[2\]/)
    assert.equal((await u.call('GET', `/api/db/acct/${a.id}`)).data.data.bal, 70, 'first op undone')
    assert.equal((await u.call('GET', '/api/db/ledger')).data.documents.length, 1, 'second op undone')
    assert.equal((await q(u, 'acct', { where: { owner: 'b' } })).documents.length, 1, 'index still consistent after rollback')
    assert.equal((await u.call('POST', '/api/db/acct', { body: { owner: 'a', bal: 0 } })).status, 409, 'unique index still enforced')
    // compare-and-set conflicts
    assert.equal((await u.call('POST', '/api/db/_batch', { body: { ops: [{ op: 'patch', collection: 'acct', id: a.id, patch: { $inc: { bal: 1 } }, ifVersion: 1 }] } })).status, 412)
    assert.equal((await u.call('POST', '/api/db/_batch', { body: { ops: [{ op: 'check', collection: 'acct', id: 'doc_nope' }] } })).status, 412)
    assert.equal((await u.call('POST', '/api/db/_batch', { body: { ops: [{ op: 'check', collection: 'acct', id: 'doc_nope', exists: false }] } })).status, 200)
    for (const ops of [[], 'x', Array.from({ length: 501 }, () => ({ op: 'insert', collection: 'z', data: {} })), [{ op: 'explode', collection: 'z' }], [{ op: 'insert', collection: '9bad', data: {} }], [5]]) {
      assert.equal((await u.call('POST', '/api/db/_batch', { body: { ops } })).status, 400, JSON.stringify(ops).slice(0, 40))
    }
    // set creates or replaces
    const s1 = await u.call('POST', '/api/db/_batch', { body: { ops: [{ op: 'set', collection: 'kv', id: 'cfg', data: { v: 1 } }, { op: 'set', collection: 'kv', id: 'cfg', data: { v: 2 } }] } })
    assert.equal(s1.status, 200)
    assert.equal((await u.call('GET', '/api/db/kv/cfg')).data.data.v, 2)
  })
})

test('indexes: planner uses them, results match a scan, unique constraints, maintenance', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    await seed(u)
    const scan = names((await q(u, 'people', { where: { 'addr.city': 'Oslo' }, sort: 'n' })))
    assert.equal((await u.call('POST', '/api/db/people/explain', { body: { where: { 'addr.city': 'Oslo' } } })).data.plan.type, 'scan')
    assert.equal((await u.call('POST', '/api/db/people/indexes', { body: { field: 'addr.city' } })).status, 201)
    assert.equal((await u.call('POST', '/api/db/people/indexes', { body: { field: 'addr.city' } })).status, 409)
    assert.equal((await u.call('POST', '/api/db/people/indexes', { body: { field: '__proto__' } })).status, 400)
    const plan = (await u.call('POST', '/api/db/people/explain', { body: { where: { 'addr.city': { $in: ['Oslo', 'Rome'] }, age: { $gt: 0 } } } })).data.plan
    assert.equal(plan.type, 'index'); assert.equal(plan.index, 'addr.city')
    assert.deepEqual(names((await q(u, 'people', { where: { 'addr.city': 'Oslo' }, sort: 'n' }))), scan)
    // maintained across update/delete
    const cy = (await q(u, 'people', { where: { n: 'cy' } })).documents[0]
    await u.call('PATCH', `/api/db/people/${cy.id}`, { body: { $set: { 'addr.city': 'Rome' } } })
    assert.deepEqual(names(await q(u, 'people', { where: { 'addr.city': 'Oslo' } })), ['ann'])
    assert.deepEqual(names(await q(u, 'people', { where: { 'addr.city': 'Rome' }, sort: 'n' })), ['bob', 'cy'])
    await u.call('DELETE', `/api/db/people/${cy.id}`)
    assert.deepEqual(names(await q(u, 'people', { where: { 'addr.city': 'Rome' } })), ['bob'])
    // multikey over arrays
    await u.call('POST', '/api/db/people/indexes', { body: { field: 'tags' } })
    assert.deepEqual(names(await q(u, 'people', { where: { tags: 'c' } })), ['di'])
    // unique
    assert.equal((await u.call('POST', '/api/db/people/indexes', { body: { field: 'age', unique: true } })).status, 201)
    assert.equal((await u.call('POST', '/api/db/people', { body: { n: 'dup', age: 31 } })).status, 409)
    const bob = (await q(u, 'people', { where: { n: 'bob' } })).documents[0]
    assert.equal((await u.call('PUT', `/api/db/people/${bob.id}`, { body: { n: 'bob', age: 31 } })).status, 409)
    assert.equal((await u.call('PUT', `/api/db/people/${bob.id}`, { body: { n: 'bob', age: 25 } })).status, 200, 'same value on the same doc is fine')
    await ins(u, 'dups', { x: 1 }); await ins(u, 'dups', { x: 1 })
    assert.equal((await u.call('POST', '/api/db/dups/indexes', { body: { field: 'x', unique: true } })).status, 409, 'cannot create unique index over duplicates')
    assert.equal((await u.call('GET', '/api/db/people/indexes')).data.indexes.length, 3)
    assert.equal((await u.call('DELETE', '/api/db/people/indexes/tags')).status, 200)
    assert.equal((await u.call('DELETE', '/api/db/people/indexes/tags')).status, 404)
    for (let i = 0; i < 10; i++) await u.call('POST', '/api/db/many/indexes', { body: { field: `f${i}` } })
    assert.equal((await u.call('POST', '/api/db/many/indexes', { body: { field: 'f10' } })).status, 409, 'index cap')
  })
})

test('schema validation: types, required, nested, errors list, bad schemas, existing docs', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    await ins(u, 'users', { legacy: true })
    const schema = { type: 'object', required: ['email', 'age'], additionalProperties: false, properties: {
      email: { type: 'string', pattern: '^[^@]+@[^@]+$', maxLength: 50 }, age: { type: 'integer', minimum: 0, maximum: 150 },
      role: { enum: ['admin', 'user'] }, tags: { type: 'array', items: { type: 'string' }, maxItems: 3, uniqueItems: true }, addr: { type: 'object', properties: { zip: { type: 'string', minLength: 3 } } },
    } }
    const put = await u.call('PUT', '/api/db/users/schema', { body: { schema } })
    assert.equal(put.status, 200); assert.equal(put.data.invalidExisting, 1)
    assert.equal((await u.call('GET', '/api/db/users/schema')).data.schema.required.length, 2)
    const bad = await u.call('POST', '/api/db/users', { body: { email: 'nope', age: 1.5, role: 'root', tags: ['a', 'a', 'b', 'c'], addr: { zip: '1' }, extra: 1 } })
    assert.equal(bad.status, 422)
    const paths = bad.data.errors.map((e) => e.path)
    for (const p of ['email', 'age', 'role', 'tags', 'addr.zip', '(root)']) assert.ok(paths.includes(p), `error for ${p}: ${paths}`)
    assert.equal((await u.call('POST', '/api/db/users', { body: { email: 'a@b.c', age: 30 } })).status, 201)
    assert.equal((await u.call('POST', '/api/db/users', { body: { age: 30 } })).status, 422)
    const doc = (await q(u, 'users', { where: { email: 'a@b.c' } })).documents[0]
    assert.equal((await u.call('PATCH', `/api/db/users/${doc.id}`, { body: { $set: { age: -1 } } })).status, 422, 'patches are validated too')
    assert.equal((await u.call('PATCH', `/api/db/users/${doc.id}`, { body: { $set: { age: 31 } } })).status, 200)
    for (const s of [{ schema: { type: 'wat' } }, { schema: { $ref: '#/x' } }, { schema: { pattern: '(a+)+' } }, { schema: { minLength: -1 } }, { schema: 'x' }, { schema: { properties: { a: { required: 5 } } } }]) {
      assert.equal((await u.call('PUT', '/api/db/users/schema', { body: s })).status, 400, JSON.stringify(s))
    }
    let deep = { type: 'object' }
    for (let i = 0; i < 12; i++) deep = { type: 'object', properties: { a: deep } }
    assert.equal((await u.call('PUT', '/api/db/users/schema', { body: { schema: deep } })).status, 400)
    assert.equal((await u.call('DELETE', '/api/db/users/schema')).status, 200)
    assert.equal((await u.call('POST', '/api/db/users', { body: { anything: 'goes' } })).status, 201)
  })
})

test('TTL: expired documents vanish immediately and are swept', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    assert.equal((await u.call('PATCH', '/api/db/sessions/settings', { body: { ttlField: 'expiresAt' } })).data.ttlField, 'expiresAt')
    assert.equal((await u.call('PATCH', '/api/db/sessions/settings', { body: { ttlField: '__proto__' } })).status, 400)
    const live = await ins(u, 'sessions', { n: 'live', expiresAt: new Date(Date.now() + 60_000).toISOString() })
    const dead = await ins(u, 'sessions', { n: 'dead', expiresAt: Date.now() - 1000 })
    await ins(u, 'sessions', { n: 'forever' })
    assert.deepEqual(names(await q(u, 'sessions', { sort: 'n' })), ['forever', 'live'])
    assert.equal((await u.call('GET', `/api/db/sessions/${dead.id}`)).status, 404)
    assert.equal((await u.call('GET', `/api/db/sessions/${live.id}`)).status, 200)
    assert.equal(app.ctx.dbSweep(), 1)
    assert.equal(app.db.get('docs', dead.id), null)
    assert.equal(app.ctx.dbSweep(Date.now() + 120_000), 1, 'the live one expires later')
  })
})

test('aggregation: count/sum/avg/min/max with grouping', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    for (const [r, v] of [['eu', 10], ['eu', 20], ['us', 5], ['us', 7], ['us', 'n/a'], ['ap', 1]]) await ins(u, 'sales', { region: r, v })
    const agg = (await u.call('POST', '/api/db/sales/aggregate', { body: { groupBy: 'region', metrics: { n: { op: 'count' }, total: { op: 'sum', field: 'v' }, mean: { op: 'avg', field: 'v' }, lo: { op: 'min', field: 'v' }, hi: { op: 'max', field: 'v' } }, sort: { region: 1 } } })).data
    assert.deepEqual(agg.groups.map((g) => g.region), ['ap', 'eu', 'us'])
    const us = agg.groups.find((g) => g.region === 'us')
    assert.equal(us.n, 3); assert.equal(us.total, 12); assert.equal(us.mean, 6); assert.equal(us.lo, 5)
    const all = (await u.call('POST', '/api/db/sales/aggregate', { body: {} })).data
    assert.deepEqual(all.groups, [{ count: 6 }])
    const filtered = (await u.call('POST', '/api/db/sales/aggregate', { body: { where: { region: 'eu' }, metrics: { s: { op: 'sum', field: 'v' } } } })).data
    assert.equal(filtered.groups[0].s, 30)
    for (const body of [{ metrics: { x: { op: 'median', field: 'v' } } }, { metrics: { 'bad alias': { op: 'count' } } }, { groupBy: [1] }, { groupBy: ['a', 'b', 'c', 'd'] }, { limit: 0 }]) assert.equal((await u.call('POST', '/api/db/sales/aggregate', { body })).status, 400, JSON.stringify(body))
  })
})

test('collections: list, rename, drop, import/export round trip and atomic import', async () => {
  await withApp(async (app) => {
    const u = await app.register(), v = await app.register()
    await seed(u)
    await ins(u, 'other', { a: 1 })
    const list = (await u.call('GET', '/api/db')).data
    assert.deepEqual(list.collections.map((c) => [c.name, c.count]), [['other', 1], ['people', 4]])
    assert.equal((await v.call('GET', '/api/db')).data.collections.length, 0)
    const ex = await u.call('GET', '/api/db/people/export')
    assert.match(ex.headers.get('content-type'), /ndjson/)
    assert.equal(ex.data.trim().split('\n').length, 4)
    const imp = await u.call('POST', '/api/db/copy/import', { raw: ex.data, headers: { 'content-type': 'application/x-ndjson' } })
    assert.equal(imp.status, 201); assert.equal(imp.data.imported, 4)
    assert.equal((await q(u, 'copy', { where: { n: 'ann' } })).documents.length, 1)
    const badImp = await u.call('POST', '/api/db/atomic/import', { raw: '{"a":1}\n{"b":2}\nnot json\n' })
    assert.equal(badImp.status, 400)
    assert.equal((await u.call('GET', '/api/db/atomic')).data.documents.length, 0)
    await u.call('POST', '/api/db/atomic2/indexes', { body: { field: 'k', unique: true } })
    assert.equal((await u.call('POST', '/api/db/atomic2/import', { raw: '{"k":1}\n{"k":2}\n{"k":1}\n' })).status, 409)
    assert.equal((await u.call('GET', '/api/db/atomic2')).data.documents.length, 0, 'import is all-or-nothing')
    assert.equal((await u.call('POST', '/api/db/copy/rename', { body: { name: 'people' } })).status, 409)
    assert.equal((await u.call('POST', '/api/db/copy/rename', { body: { name: 'dupe' } })).status, 200)
    assert.equal((await u.call('GET', '/api/db/dupe')).data.documents.length, 4)
    assert.equal((await u.call('GET', '/api/db/copy')).data.documents.length, 0)
    assert.equal((await u.call('DELETE', '/api/db/dupe')).data.deleted, 4)
    assert.equal((await v.call('DELETE', '/api/db/people')).status, 404, "cannot drop someone else's collection")
    assert.equal((await u.call('GET', '/api/db/people/export')).status, 200)
    assert.equal((await v.call('GET', '/api/db/people/export')).status, 404)
  })
})

function openWatch(app, token, path, headers = {}) {
  return new Promise((resolve) => {
    const req = http.request(`${app.base}${path}`, { headers: { authorization: `Bearer ${token}`, ...headers } }, (res) => {
      const events = []
      let buf = ''
      res.setEncoding('utf8')
      res.on('data', (c) => {
        buf += c
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2)
          const ev = {}
          for (const line of block.split('\n')) { const m = /^(\w+): ?(.*)$/.exec(line); if (m) ev[m[1]] = m[2] }
          if (ev.event) events.push({ ...ev, json: ev.data ? JSON.parse(ev.data) : null })
        }
      })
      resolve({ status: res.statusCode, events, close: () => req.destroy(), headers: res.headers })
    })
    req.on('error', () => {})
    req.end()
  })
}
const until = async (fn, ms = 2000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 15)) } return false }

test('change streams: live events, filters, resume with Last-Event-ID, isolation, limits', async () => {
  await withApp(async (app) => {
    const u = await app.register(), v = await app.register()
    const w = await openWatch(app, u.token, '/api/db/chat/watch')
    assert.equal(w.status, 200); assert.match(w.headers['content-type'], /text\/event-stream/)
    await until(() => w.events.length >= 1)
    assert.equal(w.events[0].event, 'ready')
    const d = await ins(u, 'chat', { text: 'hi', room: 'a' })
    await ins(u, 'other', { text: 'not this collection' })
    await u.call('PATCH', `/api/db/chat/${d.id}`, { body: { $set: { text: 'edited' } } })
    await u.call('DELETE', `/api/db/chat/${d.id}`)
    await until(() => w.events.filter((e) => e.event !== 'ready').length >= 3)
    assert.deepEqual(w.events.filter((e) => e.event !== 'ready').map((e) => e.event), ['insert', 'update', 'delete'])
    assert.equal(w.events[2].json.data.text, 'hi'.replace('hi', 'edited'))
    const lastId = w.events.at(-1).id
    w.close()
    // a foreign watcher sees nothing of ours
    const foreign = await openWatch(app, v.token, '/api/db/chat/watch')
    await ins(u, 'chat', { text: 'secret' })
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(foreign.events.filter((e) => e.event === 'insert').length, 0, 'tenant isolation on streams')
    foreign.close()
    // resume after a disconnect
    const r2 = await openWatch(app, u.token, '/api/db/chat/watch', { 'last-event-id': String(Number(lastId) - 2) })
    await until(() => r2.events.length >= 2)
    assert.deepEqual(r2.events.map((e) => e.event).slice(0, 2), ['update', 'delete'], 'missed events are replayed')
    r2.close()
    // where filter
    const f = await openWatch(app, u.token, `/api/db/chat/watch?where=${encodeURIComponent(JSON.stringify({ room: 'b' }))}`)
    await ins(u, 'chat', { text: 'x', room: 'a' }); await ins(u, 'chat', { text: 'y', room: 'b' })
    await until(() => f.events.some((e) => e.event === 'insert'))
    assert.deepEqual(f.events.filter((e) => e.event === 'insert').map((e) => e.json.data.text), ['y'])
    f.close()
    // validation + auth
    assert.equal((await openWatch(app, u.token, '/api/db/chat/watch?where=%7Bbad')).status, 400)
    assert.equal((await openWatch(app, u.token, '/api/db/9bad/watch')).status, 400)
    const anon = await new Promise((resolve) => http.get(`${app.base}/api/db/chat/watch`, (res) => { resolve(res.statusCode); res.destroy() }))
    assert.equal(anon, 401)
    // concurrent watcher cap
    const many = []
    for (let i = 0; i < 10; i++) many.push(await openWatch(app, u.token, '/api/db/cap/watch'))
    assert.equal((await openWatch(app, u.token, '/api/db/cap/watch')).status, 429)
    many.forEach((m) => m.close())
  })
})

test('batch events are delivered only after commit', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    const w = await openWatch(app, u.token, '/api/db/ev/watch')
    await until(() => w.events.length >= 1)
    await u.call('POST', '/api/db/ev/indexes', { body: { field: 'k', unique: true } })
    await u.call('POST', '/api/db/_batch', { body: { ops: [{ op: 'insert', collection: 'ev', data: { k: 1 } }, { op: 'insert', collection: 'ev', data: { k: 1 } }] } })
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(w.events.filter((e) => e.event === 'insert').length, 0, 'rolled back batch emits nothing')
    await u.call('POST', '/api/db/_batch', { body: { ops: [{ op: 'insert', collection: 'ev', data: { k: 1 } }, { op: 'insert', collection: 'ev', data: { k: 2 } }] } })
    await until(() => w.events.filter((e) => e.event === 'insert').length >= 2)
    assert.equal(w.events.filter((e) => e.event === 'insert').length, 2)
    w.close()
  })
})

test('public read access is opt-in, read-only and per collection', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    const d = await ins(u, 'blog', { title: 'hello', draft: false })
    const base = `/api/public/db/${u.user.id}/blog`
    assert.equal((await app.call('GET', base)).status, 404)
    assert.equal((await u.call('PATCH', '/api/db/blog/settings', { body: { publicRead: true } })).data.publicRead, true)
    const list = await app.call('GET', base)
    assert.equal(list.status, 200); assert.equal(list.data.documents[0].data.title, 'hello')
    assert.equal(list.data.documents[0].userId, undefined)
    assert.equal((await app.call('GET', `${base}/${d.id}`)).data.data.title, 'hello')
    assert.ok((await app.call('POST', base, { body: { x: 1 } })).status >= 400, 'there is no public write route')
    assert.equal((await app.call('GET', `/api/public/db/${u.user.id}/people`)).status, 404, 'other collections stay private')
    assert.equal((await app.call('GET', `/api/public/db/nobody/blog`)).status, 404)
    assert.equal((await app.call('GET', `${base}?limit=1000`)).data.documents.length, 1)
    await u.call('PATCH', '/api/db/blog/settings', { body: { publicRead: false } })
    assert.equal((await app.call('GET', base)).status, 404)
  })
})

test('tenant isolation and auth', async () => {
  await withApp(async (app) => {
    const u = await app.register(), v = await app.register()
    const d = await ins(u, 'secret', { n: 'mine' })
    await u.call('POST', '/api/db/secret/indexes', { body: { field: 'n', unique: true } })
    assert.equal((await v.call('GET', `/api/db/secret/${d.id}`)).status, 404)
    assert.equal((await v.call('PUT', `/api/db/secret/${d.id}`, { body: { n: 'x' } })).status, 404)
    assert.equal((await v.call('PATCH', `/api/db/secret/${d.id}`, { body: { $set: { n: 'x' } } })).status, 404)
    assert.equal((await v.call('DELETE', `/api/db/secret/${d.id}`)).status, 404)
    assert.equal((await q(v, 'secret', {})).documents.length, 0)
    assert.equal((await v.call('POST', '/api/db/secret', { body: { n: 'mine' } })).status, 201, "unique indexes are per user: no cross-tenant uniqueness oracle")
    assert.equal((await v.call('POST', '/api/db/_batch', { body: { ops: [{ op: 'patch', collection: 'secret', id: d.id, patch: { $set: { n: 'x' } } }] } })).status, 404)
    assert.equal((await u.call('GET', `/api/db/secret/${d.id}`)).data.data.n, 'mine')
    for (const [m, p] of [['GET', '/api/db'], ['GET', '/api/db/x'], ['POST', '/api/db/x'], ['POST', '/api/db/_batch'], ['POST', '/api/db/x/query'], ['GET', '/api/db/x/export']]) assert.equal((await app.call(m, p)).status, 401, `${m} ${p}`)
  })
})

test('limits: per-user document cap and collection cap', async () => {
  process.env.RD_DB_MAX_DOCS = '5'
  try {
    await withApp(async (app) => {
      const u = await app.register()
      for (let i = 0; i < 5; i++) assert.equal((await u.call('POST', '/api/db/c', { body: { i } })).status, 201)
      assert.equal((await u.call('POST', '/api/db/c', { body: { i: 6 } })).status, 413)
    })
  } finally { delete process.env.RD_DB_MAX_DOCS }
  await withApp(async (app) => {
    const u = await app.register()
    for (let i = 0; i < 200; i++) await u.call('POST', `/api/db/c${i}`, { body: { i } })
    assert.equal((await u.call('POST', '/api/db/one-too-many', { body: { i: 1 } })).status, 409)
  })
})

test('state survives a cold reload (new in-memory state is rebuilt from rows, indexes and schema included)', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    await u.call('POST', '/api/db/persist/indexes', { body: { field: 'k', unique: true } })
    await u.call('PUT', '/api/db/persist/schema', { body: { schema: { type: 'object', required: ['k'] } } })
    await ins(u, 'persist', { k: 1 })
    app.ctx.events.emit('account.deleted', { userId: 'someone-else' })
    // simulate eviction of the cached state by loading through a rename round trip
    await u.call('POST', '/api/db/persist/rename', { body: { name: 'persist2' } })
    await u.call('POST', '/api/db/persist2/rename', { body: { name: 'persist' } })
    assert.equal((await u.call('POST', '/api/db/persist', { body: { k: 1 } })).status, 409, 'unique index rebuilt from stored metadata')
    assert.equal((await u.call('POST', '/api/db/persist', { body: { nope: 1 } })).status, 422, 'schema reloaded')
  })
})

test('performance: 100k documents - indexed lookup is fast, filtered scan is bounded', async () => {
  await withApp(async (app) => {
    const u = await app.register()
    // seed through the engine so the HTTP layer is not the bottleneck
    for (let i = 0; i < 100_000; i++) app.db.insert('docs', { userId: u.user.id, collection: 'big', version: 1, data: { n: i, bucket: i % 1000, name: `user${i}`, flag: i % 7 === 0 } })
    const t0 = Date.now()
    assert.equal((await u.call('GET', '/api/db')).data.collections[0].count, 100_000)
    const load = Date.now() - t0
    await u.call('POST', '/api/db/big/indexes', { body: { field: 'bucket' } })
    const t1 = performance.now()
    const idx = await q(u, 'big', { where: { bucket: 77 }, limit: 5 })
    const tIdx = performance.now() - t1
    assert.equal(idx.total, 100); assert.equal(idx.plan.type, 'index'); assert.equal(idx.plan.scanned, 100)
    const t2 = performance.now()
    const scan = await q(u, 'big', { where: { flag: true, n: { $gte: 50_000 } }, limit: 5 })
    const tScan = performance.now() - t2
    assert.equal(scan.plan.type, 'scan'); assert.ok(scan.total > 7000)
    console.log(`# perf: load ${load} ms, indexed ${tIdx.toFixed(1)} ms, scan ${tScan.toFixed(1)} ms`)
    assert.ok(tIdx < 100, `indexed lookup took ${tIdx} ms`)
    assert.ok(tScan < 1500, `scan took ${tScan} ms`)
  })
})

test('client-chosen ids are collection-scoped: no cross-tenant or cross-collection collisions or oracles', async () => {
  await withApp(async (app) => {
    const u = await app.register(), v = await app.register()
    const set = (c, id, data) => c.call('POST', '/api/db/_batch', { body: { ops: [{ op: 'set', collection: 'kv', id, data }] } })
    assert.equal((await set(u, 'config', { v: 1 })).status, 200)
    assert.equal((await set(v, 'config', { v: 99 })).status, 200, "another user's id of the same name is independent (and reveals nothing)")
    assert.equal((await u.call('GET', '/api/db/kv/config')).data.data.v, 1)
    assert.equal((await v.call('GET', '/api/db/kv/config')).data.data.v, 99)
    assert.equal((await u.call('POST', '/api/db/_batch', { body: { ops: [{ op: 'insert', collection: 'other', id: 'config', data: {} }] } })).status, 200, 'same id in a different collection')
    assert.equal((await u.call('POST', '/api/db/_batch', { body: { ops: [{ op: 'insert', collection: 'kv', id: 'config', data: {} }] } })).status, 409)
    for (const bad of ['a b', 'x/y', '', 'é', 'x'.repeat(129)]) assert.equal((await u.call('POST', '/api/db/_batch', { body: { ops: [{ op: 'insert', collection: 'kv', id: bad, data: {} }] } })).status, 400, JSON.stringify(bad))
    // an id that equals another tenant's internal row id still cannot touch it
    const mine = await ins(u, 'kv', { secret: 1 })
    assert.equal((await set(v, mine.id, { stolen: true })).status, 200)
    assert.equal((await u.call('GET', `/api/db/kv/${mine.id}`)).data.data.secret, 1)
    // ids survive export/import into another collection
    const ex = await u.call('GET', '/api/db/kv/export')
    assert.equal((await u.call('POST', '/api/db/kv2/import', { raw: ex.data })).status, 201)
    assert.equal((await u.call('GET', '/api/db/kv2/config')).data.data.v, 1)
  })
})
