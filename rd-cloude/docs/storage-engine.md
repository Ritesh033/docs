# Storage engine (`src/db.js`, `server.js`, `scripts/backup.mjs`)

A synchronous in-memory document store with a **write-ahead log (WAL)**, **periodic checksummed snapshots** and a
**checksummed blob store**. Zero dependencies. The public API that every module uses is unchanged; the persistence
underneath it is crash-safe. Without a `dataDir` it is a pure in-memory store (tests, `startTestApp()`).

## What you get

| Property | How |
|---|---|
| Every acknowledged write survives a process crash / `kill -9` | each mutation is `write(2)`n to the WAL before `insert()`/`update()`/... returns |
| Survives power loss (configurable) | `RD_FSYNC=always` fsyncs per write, `batch` (default) group-commits every 100 ms, `never` leaves it to the OS |
| Torn writes are repaired | a damaged record with nothing valid after it is a torn tail: it is dropped and the log truncated |
| Corruption is never papered over | a bad record *followed by valid records*, a sequence gap, a duplicated/missing record or a bad snapshot refuses to start with a `DbCorruptionError` that names file and byte offset |
| One process per data dir | `LOCK` file (pid, host, nonce) with stale detection, heartbeat lease and fencing |
| Bounded recovery time | snapshot + log compaction (threshold clamped to `RD_WAL_COMPACT_MAX_BYTES`, default 256 MiB) |
| Silent bit rot is detected | CRC32 per log/snapshot line, SHA-256 per snapshot and per blob (verified on **every** read) |
| Fast lookups | optional secondary indexes: `findBy` is O(1) and always equals `find(r => r[f] === v)` |

## Document API

All synchronous. Collections are created on first write; **prefix yours with your module name** (`fn_functions`).

```js
db.insert(col, doc)                // -> row {id, createdAt, ...doc}. Explicit id allowed; a duplicate id throws (code EDBDUPLICATE)
db.get(col, id)                    // -> row | null            (the live object, not a copy)
db.find(col, pred = all)           // -> rows in insertion order; pred(row, index)
db.findOne(col, pred)              // -> row | null
db.count(col, pred?)               // O(1) without pred
db.update(col, id, patch)          // -> row | null. Sets updatedAt. `id` in the patch is ignored; a value of `undefined` unsets the field
db.remove(col, id)                 // -> boolean
db.removeWhere(col, pred)          // -> number removed (pred is required: a missing one throws instead of wiping the collection)
db.id(prefix)                      // -> `${prefix}_${16 hex}`
db.collections()                   // -> names
```

**Rules for module authors**

* **Mutate only through `update()`/`insert()`/`remove()`.** The log records API calls. If you edit a returned row in place
  (`row.x = 1`), the change is *not* logged: it is lost on a crash and only reaches disk with the next snapshot
  (clean shutdown or compaction). Indexed fields edited in place also leave the index stale (`findBy` filters stale hits;
  `db.reindex(col)` repairs).
* **Store JSON-safe values.** Rows are persisted as JSON: `Date`, `Map`, `Buffer`, `NaN` and `undefined` do not round-trip
  (use ISO strings and `putBlob`). `BigInt` and circular structures throw before any state changes.
* One record (an insert, a patch, a transaction) is limited to **64 MiB** of JSON; larger throws `RangeError`.
* Collection names match `/^[A-Za-z0-9_][A-Za-z0-9_.:@-]{0,127}$/`, at most 10 000 collections. Document ids are
  non-empty strings (<= 512 chars) or finite numbers. Reads never create collections.

### Indexes

```js
db.index('files', 'userId')                 // optional, idempotent; builds from existing rows
db.findBy('files', 'userId', user.id)       // rows with row.userId === value, insertion order (same as find)
db.findOneBy('users', 'email', email)       // first match | null
db.dropIndex(col, field); db.reindex(col, field?)
```

* `findBy` creates the index on first use, so calling `index()` is optional. `findBy(col, 'id', x)` hits the primary map.
* Semantics are exactly `===`: `NaN` never matches, `0` and `-0` are the same, `undefined` finds rows that lack the field.
* Kept consistent across insert/update/remove/removeWhere/transaction rollback (property-tested against `find()` including order).
* At most 16 indexes per collection; beyond that `findBy` silently falls back to a linear scan (`index()` throws).
* Indexes live in memory and are rebuilt on demand after a restart (cost: one pass over the collection).

### Transactions

```js
db.transaction(() => {                      // synchronous callback only (async throws TypeError)
  const order = db.insert('orders', {...})
  db.update('stock', id, { qty: q - 1 })
})                                           // one log record: all-or-nothing across a crash
```

An exception rolls back every in-memory change (order of rows and indexes included). Nested calls behave as savepoints:
if the inner callback throws and the outer one catches it, only the inner writes are undone. Reads inside see uncommitted
state (there is a single thread, so nobody else can). `compact()`/`backup()`/`close()` inside a transaction throw.

### Blobs

```js
db.putBlob(id, bufferOrStringOrUint8Array)  // atomic; returns { id, size, sha256 }
db.getBlob(id)                              // Buffer | null; throws BlobCorruptError (code EBLOBCORRUPT) if the checksum fails
db.deleteBlob(id)                           // boolean
db.hasBlob(id); db.statBlob(id)             // statBlob reads only the 44-byte header
db.listBlobs(); db.verifyBlobs()            // verifyBlobs -> { checked, bytes, corrupt: [{id, reason}] }
db.gcBlobs(isReferenced, { graceMs = 300000, dryRun = false })
```

* Blob ids must match `/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/` (no `/`, `..`, leading dots): `putBlob` throws `TypeError`,
  `getBlob`/`deleteBlob` treat invalid ids as absent. Size cap `RD_BLOB_MAX_BYTES` (default 256 MiB).
* File layout `blobs/<xx>/<id>` (256 shards), mode 0600: `RDB1` magic, u64 length, SHA-256, payload. Written to a temp file,
  fsynced (unless `never`), renamed. A crash leaves either the old blob or the new one, plus at most a `.tmp` file.
* **GC is never automatic**, because only modules know where they store blob ids. `gcBlobs(fn)` calls `fn(blobId)`, which
  **must return a boolean** (`true` = referenced); a non-boolean or a throw aborts before anything is deleted (a callback
  that forgets `return` must not delete everything). Unreferenced blobs younger than `graceMs` are kept (an upload whose row
  is not inserted yet). Stale `.tmp` files (> 1 h) are removed. Example:

  ```js
  const refs = new Set()
  for (const f of db.find('files')) for (const v of f.versions) refs.add(v.blobId)
  for (const o of db.find('objects')) refs.add(o.blobId)
  db.gcBlobs((id) => refs.has(id), { dryRun: true })   // inspect `candidates` first
  ```

### Lifecycle and operations

```js
db.flush()        // fsync everything acknowledged so far (a barrier even in `never` mode)
db.compact()      // snapshot + start a fresh log (automatic; call it manually only for tests/maintenance)
db.close()        // flush, final snapshot (only if there were writes), stop timers, release the lock. Idempotent.
db.stats()        // collections, wal, snapshot, compactions, blobs, recovery report, lock, writes, health
db.health()       // { ok, closed, failed }
db.backup(dest, { link }) // consistent copy: snapshot + blobs + non-engine files + MANIFEST.json. Synchronous (blocks while it runs)
```

`stats()` is cheap except the first call, which counts blobs once (a directory scan); afterwards counts are maintained incrementally.
After `close()` reads keep working but writes throw `EDBCLOSED`.

### Errors

| `err.code` | class | meaning |
|---|---|---|
| `EDBLOCKED` | `DbLockedError` | another live process (or handle) has the data dir; `err.details` = `{pid, host, startedAt}` |
| `EDBCORRUPT` | `DbCorruptionError` | unrecoverable damage found at startup (or a bad legacy `db.json`); the data dir is left untouched |
| `EBLOBCORRUPT` | `BlobCorruptError` | a blob failed its checksum on read (`err.blobId`); surfaces as a 500 from a route, never as wrong bytes |
| `EDBFAILED` | `DbError` | the engine hit an unrecoverable I/O error or lost its lock and now refuses writes; restart |
| `EDBCLOSED` | `DbError` | write after `close()` |
| `EDBDUPLICATE` | `DbError` | `insert` with an id that already exists in the collection |

Argument errors are plain `TypeError` / `RangeError` (bad collection name, non-object document, oversized record, ...).

## On-disk format

```
<dataDir>/                    mode 0700, files 0600
  LOCK                        {"pid","host","nonce","startedAt"}
  snapshot-0000000007.rds     state as of log sequence S: header line, row chunks, end marker {lines, rows, sha256}
  snapshot-0000000006.rds     previous generation (RD_KEEP_GENERATIONS, default 2)
  wal-0000000006.log          header {baseSeq, empty}, then records {s: seq, o: i|u|r|R|t, ...}
  wal-0000000007.log
  blobs/ab/blob_xxx
  secret.key, ...             files of other modules: untouched by the engine, included in backups
```

Every line is `<8 hex CRC32> <json>\n`, so the files are greppable. Sequence numbers are gapless across files.
Records: `i` insert (full row), `u` update (`p` = set, `d` = unset keys), `r` remove, `R` bulk remove, `t` transaction (list of ops).

### Compaction (snapshot + log rotation)

Triggered when the log exceeds `max(RD_WAL_COMPACT_MIN_BYTES = 8 MiB, snapshot size)`, clamped to `RD_WAL_COMPACT_MAX_BYTES` (256 MiB, bounds
replay time); it is scheduled right after the current request, and a log more than 4x over the threshold compacts immediately. Order of operations (each step is crash-safe):

1. fsync the current log, create `wal-N+1` (header carries the current sequence) and switch writes to it;
2. write `snapshot-N+1.rds.tmp`, fsync, rename, fsync the directory (this is the commit point);
3. prune: keep the newest `RD_KEEP_GENERATIONS` snapshots and every log needed to reach the oldest of them.

A crash between any two steps recovers to the same state (tested). If the newest snapshot is later found corrupt, startup falls
back to the previous generation + the log chain **without losing data**, quarantines the bad file (`*.corrupt-<ts>`) and
immediately writes a fresh snapshot. A failing compaction (disk full) is logged, retried after 30 s, and never endangers data.

### Recovery on start

1. take the lock; remove engine temp files; migrate a legacy `db.json` if present;
2. load the newest valid snapshot, replay the logs after it, verifying the sequence is gapless;
3. torn tail on the newest log -> truncate; anything else wrong -> refuse (see below);
4. open the log for appending. `stats().recovery` reports what happened.

**When it refuses** (`DbCorruptionError`, process exits 1 under `server.js`): the message gives the file, the byte offset and why.
Options: restore a backup (`node scripts/backup.mjs restore`), or start once with `RD_RECOVER=truncate` to discard everything from
the damaged record on. The discarded bytes are preserved as `wal-*.log.corrupt-<ts>`. Nothing is ever repaired silently.

### Legacy migration

A `db.json` from the previous engine is imported on first open (rows keep their order; id-less rows get ids; duplicate ids and
non-object rows are skipped and counted in the log line). The original is kept as `db.json.migrated` (delete it when satisfied).
Flat `blobs/<id>` files are wrapped into the checksummed layout; their pre-migration integrity cannot be verified.
A corrupt `db.json` stops startup without touching the file.

## Durability modes (`RD_FSYNC`)

| mode | write path | process crash (`kill -9`) | power loss / kernel panic |
|---|---|---|---|
| `always` | write + `fsync` per mutation (and per blob/dir) | nothing lost | nothing lost |
| `batch` (default) | write; async group `fsync` at most every `RD_FSYNC_INTERVAL_MS` (100) | nothing lost | up to ~100 ms of acknowledged writes |
| `never` | write only (no automatic fsync, snapshots included) | nothing lost | whatever the OS had not flushed |

`flush()` and `close()` always fsync. If an `fsync` (or a write that cannot be rolled back) fails, the engine **poisons itself**:
every later write throws `EDBFAILED`, `onFatal` fires, `health().ok` is false, and a restart replays what is really on disk
(an fsync error means the kernel may have dropped pages, so continuing would be lying about durability).

## Locking

`LOCK` is created with `O_EXCL`. An existing lock is **live** if its owner is this process, or the owner pid is alive on this
host with a fresh heartbeat, or (other host) the heartbeat is younger than `RD_LOCK_LEASE_MS` (30 s). It is **stale** (taken over,
logged) if the pid is dead, the same pid is reused by a different incarnation (containers: pid 1), or the heartbeat expired.
Takeover goes through a `LOCK.claim` mutex so two starters cannot both win. The holder refreshes the lock's mtime every
lease/3 and checks its nonce; if another process took it over (event loop frozen > lease), the engine stops writing
(`EDBFAILED`) instead of corrupting the data. `RD_FORCE_UNLOCK=1` overrides a live lock (operator decision, logged loudly).
Symlinked paths to the same directory resolve to one lock. The lock is released by `close()` and, as a best effort, on process exit.

## `server.js`

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | integer 0-65535 (0 = pick a free port; the real one is printed) |
| `HOST` | all interfaces | IP literal or hostname; set `127.0.0.1` to listen locally only |
| `RD_DATA_DIR` | `./data` | must be (or be creatable as) a writable directory |
| `RD_SHUTDOWN_TIMEOUT_MS` | 10000 | drain time on SIGTERM/SIGINT (0-600000) |
| `RD_CRASH_ON_UNHANDLED` | 0 | 1 = an unhandled promise rejection is fatal |

All problems are reported together and the process exits 1 *before touching the data dir*.
`RD_FSYNC`, `RD_FSYNC_INTERVAL_MS`, `RD_WAL_COMPACT_MIN_BYTES`, `RD_WAL_COMPACT_MAX_BYTES`, `RD_KEEP_GENERATIONS` (1-10),
`RD_LOCK_LEASE_MS`, `RD_BLOB_MAX_BYTES`, `RD_SNAPSHOT_ON_CLOSE` (default 1), `RD_RECOVER`, `RD_FORCE_UNLOCK` are validated too.

**Shutdown (SIGTERM / SIGINT):** stop accepting connections, mark in-flight responses `Connection: close`, close idle keep-alive
connections, wait for in-flight requests up to the timeout (then close the stragglers), emit `shutdown` (via the server `close`
event), `db.close()` (flush, final snapshot, release lock), exit 0. A second signal exits immediately (130/143) after a best-effort
flush. **`uncaughtException`:** logged with stack, same shutdown path, exit 1 (a supervisor should restart; recovery is automatic).
**`unhandledRejection`:** logged with stack and counted; the process keeps serving unless `RD_CRASH_ON_UNHANDLED=1`.
Startup failures (bad config, data dir locked by another process, corruption, port in use) print one clear line and exit 1.

## Backup, verify, restore

```
node scripts/backup.mjs backup  [<dataDir>] <destDir> [--live]
node scripts/backup.mjs verify  [<dir>] [--no-blobs] [--json]
node scripts/backup.mjs restore <backupDir> [<dataDir>] [--force]
```

* `backup` (default) takes the data dir lock, so it refuses while a server runs (exit 1, tells you to stop it or use `--live`).
  `--live` copies a running data dir: snapshots are immutable, the log tolerates a torn tail (trimmed in the copy only), blobs are
  copied before and after the log, then the copy is **verified**; it retries if a compaction pruned files mid-copy. It is a
  best-effort hot copy: a blob uploaded during the copy can in theory be missing; stop the server (or use `db.backup()`) when you
  need a guaranteed-consistent copy.
* `db.backup(dest)` (in-process) is exactly consistent but blocks the event loop for its duration. It is intended for an admin
  route or a scheduled job owned by another module; **never pass a client-supplied path**.
* A backup is an ordinary data directory (snapshot + empty log + blobs + non-engine files such as `secret.key` + `MANIFEST.json`):
  you can point `RD_DATA_DIR` at it. Back up the whole directory, not just `blobs/`: `secret.key` is needed to read encrypted fields.
* `verify` is read-only: checks every snapshot (all generations), the log chain, every blob checksum and the manifest. Exit 0 ok,
  1 problems. A torn tail is a warning (normal after a crash), anything else an error.
* `restore` verifies first, copies into a staging directory, verifies again, then renames into place. A non-empty target needs
  `--force`, which moves it to `<dir>.pre-restore-<ts>` (never deletes) and refuses while a server holds the lock.
* Exit codes: 0 ok, 1 failed/problems, 2 usage.

## Limits

* The whole dataset lives in memory (as before). Rows are plain JS objects; budget roughly 2-3x the snapshot size in RAM.
* Everything is synchronous: compaction, `backup()` and `verifyBlobs()` block the event loop (compaction of 100k rows ~150 ms).
* 64 MiB per record/transaction, 256 MiB per blob (default), 10 000 collections, 16 indexes per collection.
* Blobs are read and written whole (no streaming API); `getBlob` buffers the file, which is fine for the 25 MB request-body limit.
  Do not mutate a Buffer returned by `getBlob` in memory mode (it is the stored copy).
* Indexes cover top-level fields only (no `a.b` paths).
* Measured on the dev VM (`batch` mode, small ~150-byte rows): ~80k inserts/s, ~1.5M indexed lookups/s, log replay ~180k records/s (200k records / 37 MB in 1.1 s), a 100k-row snapshot (16 MB) is written in ~150 ms.

## Security notes

* Data dir `0700`, files `0600`. Blob ids and collection names are validated; nothing user-controlled is ever joined into a path unvalidated.
* No blob or document is ever executed or interpreted by the engine. `secret.key` and other module files are copied by backups with their modes.
* Tenant isolation is the callers' job (`userId` checks); the engine adds nothing that crosses tenants and `findBy` returns what `find` would.
* Checksums (CRC32/SHA-256) detect accidental corruption, **not tampering**: someone who can write the data dir can rewrite a
  consistent log. Protect the directory with filesystem permissions; encrypt backups before they leave the host (not done here).

## Honest limitations

* Single process, single node: no replication, no point-in-time recovery beyond what retained generations give, no online resize.
* No automatic blob GC, no automatic scheduled backups, no admin HTTP endpoints for stats/backup (the primitives exist: see integration notes).
* `--live` backups are best-effort for uploads racing the copy (see above); nothing is encrypted at rest.
* Heartbeat fencing narrows but cannot fully close the split-brain window of a process frozen for longer than the lease on a shared network disk;
  do not run two instances against one directory on NFS and rely on this.
* In-place row mutation (without `update()`) is not durable until the next snapshot; this cannot be detected cheaply, so it is documented, not prevented.
* Long-lived responses (SSE) are cut when the drain timeout expires: there is no earlier "draining" signal to modules yet.
* Windows is untested (directory fsync is skipped where unsupported).

## Tests

`node --test test/db.test.js`: document semantics, torn tails at every byte offset, random log/snapshot/blob damage (always a prefix
of history or a loud refusal), `kill -9` of a writer, lock contention across processes and stale-lock cases, fenced lock loss,
compaction and crash-during-compaction, generation fallback, index consistency under 4000 random ops with rollbacks, transactions,
legacy migration, blob corruption/GC, backup/verify/restore (library and CLI), server config validation and lifecycle
(SIGTERM drain, drain timeout, second signal, double start, kill -9 restart, uncaught/unhandled errors), and a 100k insert + 100k lookup perf check.
