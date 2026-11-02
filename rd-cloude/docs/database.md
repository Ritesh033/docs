# Document database

`src/modules/database.js`, UI in `public/ui/database.js`. Per-user collections of JSON documents. Rows live in the shared `docs` collection
(`{userId, collection, data, version, xid?}`); `db_meta` holds per-collection indexes, schema, TTL and public-read settings. Per-user in-memory state is built lazily from rows
(100k documents: ~70 ms to load, indexed lookup ~2 ms, filtered full scan ~25 ms on the dev VM — see the benchmark test).

## Documents and ids
Documents are JSON objects: depth ≤ 20, ≤ 100k values, ≤ 256 KB (`RD_DB_MAX_DOC_BYTES`), arrays ≤ 10 000, finite numbers; field names may not start with `$`, contain `.`, or be `__proto__`/`constructor`/`prototype`.
Collection names: `[A-Za-z][A-Za-z0-9_-]{0,63}`. Limits per user: 200 collections, `RD_DB_MAX_DOCS` (500 000) documents.
The public document id is either the random internal id or a client-chosen id (`/^[A-Za-z0-9_.:@-]{1,128}$/`, unique **per collection and user**; never collides with or reveals other tenants' ids).
`version` starts at 1 and increments on every write.

## API (all need auth unless noted)
| | |
|---|---|
| `GET /api/db` | collections with counts, indexes, schema/TTL/public flags |
| `POST /api/db/:c` | insert (body = document) → 201 |
| `GET/PUT/PATCH/DELETE /api/db/:c/:id` | read / replace / update operators / delete. Optimistic concurrency: `If-Match: <version>` or `?ifVersion=` → **412** on mismatch |
| `GET /api/db/:c[?limit&sort&cursor]`, `POST /api/db/:c/query {where,sort,limit,offset,cursor,project}` | query (returns `documents,count,total,nextCursor,plan`) |
| `POST /api/db/:c/explain {where}` | `{plan:{type:'scan'\|'index', index?, scanned}}` |
| `POST /api/db/:c/aggregate {where,groupBy,metrics,sort,limit}` | count/sum/avg/min/max with grouping |
| `POST /api/db/_batch {ops:[…]}` | **atomic** batch (≤ 500 ops, across collections): `insert`, `set` (upsert by id), `patch`, `delete`, `check` (`ifVersion`, `exists:false`) — all-or-nothing with rollback of rows *and* indexes; failures report `ops[i]: …` |
| `GET/POST/DELETE /api/db/:c/indexes[/:field]` | secondary indexes (≤ 10 per collection; `unique:true` supported; arrays are indexed per element) |
| `GET/PUT/DELETE /api/db/:c/schema` | JSON-schema subset validation (422 + `errors:[{path,message}]`) |
| `PATCH /api/db/:c/settings {ttlField, publicRead}` | TTL field (ISO string or epoch ms) and opt-in public reads |
| `GET /api/db/:c/watch[?where=&since=]` | **SSE** change stream: `ready`, `insert`, `update`, `delete`, `reset`; resumes with `Last-Event-ID` from a bounded (2000) in-memory log; ≤ 10 open watches per user |
| `GET /api/db/:c/export`, `POST /api/db/:c/import` | NDJSON (`{id,data}` envelopes or bare documents), import is all-or-nothing (≤ 50k lines) |
| `POST /api/db/:c/rename {name}`, `DELETE /api/db/:c` | collection management |
| `GET /api/public/db/:ownerId/:c[/:id]` | **no auth**, read-only, only for collections with `publicRead` (≤ 100 per page); everything else is 404 |

## Query language
`where` is an object; keys are field paths (`"addr.city"`, arrays are traversed) or `$and`/`$or`/`$nor`/`$not`. Values are literals (equality; an array field matches if it contains the value) or operator objects:
`$eq $ne $gt $gte $lt $lte $in $nin $exists $regex($options "i") $contains $icontains $startsWith $size $all $not`.
Comparisons are **type-strict** (a string never compares with a number). `sort`: `"-age,name"` / `["age", {field,dir}]` / `{age:-1}` (≤ 3 keys); default order is creation time. Cursors are keyset-based (stable across ties); `limit` ≤ 1000.
PATCH operators: `$set $unset $inc $push $pull $addToSet` (paths may not traverse non-objects; `__proto__` paths are rejected).
The planner uses an index for top-level equality / `$in` constraints (smallest candidate set wins); everything else filters the candidates.

## Safety
`$regex` is restricted (≤ 64 chars, no backreferences/lookarounds, no nested/repeated quantifiers, ≤ 2 `.*`) so patterns cannot cause catastrophic backtracking; where-clauses are limited (depth 8, 100 clauses, 20 branches); schema size ≤ 64 KB and `pattern`s go through the same checks.
Unique indexes are per user (no cross-tenant uniqueness oracle). Expired (TTL) documents are invisible immediately and deleted by a 30 s sweeper.

## Limitations
No joins, no full-text search, no range index (only equality/`$in` use indexes), no per-field security rules, no org-shared collections. State is rebuilt in memory per user (bounded LRU of 200 users, pinned while watched); a very large collection costs memory proportional to its size.
