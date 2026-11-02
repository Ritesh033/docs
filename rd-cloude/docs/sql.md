# Managed SQL databases

`src/modules/sql.js` (API + worker pool), `src/sql-guard.js` (lexer, allowlists, EXPLAIN scan), `src/sql-worker.js` (the child process), UI in `public/ui/sql.js`.
Each database is a real SQLite file (`<dataDir>/sql/<id>.sqlite`) on Node's built-in `node:sqlite` (SQLite 3.50).

## Threat model and defences
Users send arbitrary SQL, so the service assumes it is hostile. `node:sqlite` in Node 22 has **no authorizer callback**, `ATTACH` and `VACUUM INTO` really read/write arbitrary paths, `worker.terminate()` cannot interrupt a native SQLite call,
and SQLite's heap limit is not compiled in. The design therefore layers independent controls:

1. **Lexer + allowlist** (`sql-guard.js`): a real SQL lexer (comments, strings, `"quoted"`, `` `quoted` ``, `[quoted]`, `x'..'` blobs) so keywords inside strings/comments are harmless and obfuscation (`/**/`, case, `;` tricks) does not work. Only SELECT/WITH/VALUES/INSERT/REPLACE/UPDATE/DELETE/CREATE/DROP/ALTER/ANALYZE/REINDEX and a PRAGMA allowlist are accepted.
   Denied anywhere: `attach detach vacuum load_extension readfile writefile fts3_tokenizer sqlite_dbpage dbstat zipfile …` and every `pragma_*` table function (it would leak the server's file paths). Transaction statements are refused (use `{"transaction": true}`); virtual tables are limited to `fts5`/`rtree`; control characters, > 100 KB, > 50 statements are rejected.
2. **SQLite's own bytecode** (`scanExplain`): right before each statement runs, `EXPLAIN <statement>` is inspected for `sqlite_attach`/`sqlite_detach`/`load_extension` function calls, `Vacuum` and `JournalMode` opcodes — independent of the lexer. (EXPLAIN compiles but never executes.)
3. **Single-statement execution**: user text never goes through `db.exec()` (which would run trailing statements); each statement is `prepare()`d alone.
4. **Process isolation**: one child process per active database, spawned with an empty environment, an empty cwd, `ulimit -v` (`RD_SQL_MEM_MB`, default 1536) and `ulimit -f` file-size limits, `--max-old-space-size=96`, and the Node permission model (`--permission`, fs access limited to the worker source and the SQL directory) when the runtime supports it.
   `PRAGMA trusted_schema=OFF`, `temp_store=MEMORY`, `max_page_count` (size cap `RD_SQL_MAX_DB_BYTES`, default 64 MB), foreign keys on.
5. **Timeouts by SIGKILL**: queries are cancelled after `RD_SQL_TIMEOUT_MS` (5 s; per-request `timeoutMs` up to `RD_SQL_MAX_TIMEOUT_MS`, 30 s) by killing the worker; SQLite's journal makes this safe (uncommitted work is rolled back), and the next request transparently starts a new worker.
6. **Quotas**: ≤ 3 concurrent queries per user, ≤ `RD_SQL_MAX_PROCS` (8) live workers (idle ones are evicted, idle timeout 30 s), plan quota `sql.databases`, ≤ 20 databases (`RD_SQL_MAX_DBS`), results capped at 10 000 rows / 4 MB / 64 KB per cell, import ≤ 5 MB.

## API (all `/api/sql…`, auth required; databases are strictly per user, foreign ids answer 404)
| | |
|---|---|
| `GET/POST /api/sql`, `GET/DELETE /api/sql/:id` | list / create `{name}` / inspect / delete |
| `POST /api/sql/:id/query {sql, params, transaction, readOnly, maxRows, timeoutMs}` | run one or several statements. `params` (positional array or named object, `{"$blob": base64}` for blobs) only with a single statement. Returns `results[{kind, columns, rows, rowCount, truncated, changes, lastInsertRowid, ms}]`. Integers beyond 2^53 come back as strings. |
| `GET /api/sql/:id/select?sql=&params=` | **read-only** (enforced by the guard *and* `PRAGMA query_only`); usable with read-only API keys (`db:read`) |
| `POST /api/sql/:id/explain {sql}` | `EXPLAIN QUERY PLAN` |
| `GET /api/sql/:id/schema`, `GET /api/sql/:id/tables/:name?limit&offset` | introspection and table viewer |
| `POST /api/sql/:id/import?table=&format=csv\|json` (raw body) | create-if-needed + bulk insert with type inference |
| `GET /api/sql/:id/export?format=sql\|csv\|json[&table=\|&sql=]` | dump / CSV (formula-injection neutralised) / JSON |
| `GET/POST /api/sql/:id/snapshots`, `POST …/snapshots/:sid/restore {confirm:true}`, `DELETE …/snapshots/:sid` | `VACUUM INTO` copies (≤ 10), restore keeps a safety snapshot and verifies integrity |
| `GET/POST /api/sql/:id/migrations {version,name,sql}` | ordered, atomic, idempotent, checksum drift → 409 |
| `GET/DELETE /api/sql/:id/history`, `GET/POST/DELETE /api/sql/:id/saved[/:sid]` | last 100 statements, ≤ 100 saved queries |

Metering: `sql.query` per request and `sql.gb_month` (daily accrual from file sizes). Error mapping: guard/SQL errors 400, timeout 408, database full 413, concurrency 429, worker crash 500.

## Limitations (honest)
Isolation is process-level, not a container: a kernel or SQLite memory-corruption bug in a worker would still run with the platform user's privileges (the permission model and empty environment limit what JS-level compromise could do, but native SQLite file access is not restricted by it; a hardened deployment should add a container/seccomp/user namespace per worker).
Column names collapse for duplicate aliases, `WITH … INSERT` counts as a write in read-only mode, no extensions, no `ATTACH` (so no cross-database joins), no user-defined functions. The engine's dataset limits (whole-state-in-memory) do not apply to SQLite files.
