# Object storage (`/api/buckets`, `src/modules/storage.js`)

S3-class object storage: buckets with versioning, ACLs, CORS, lifecycle rules and static website hosting; objects with metadata, checksums, conditional requests, ranges and tags; multipart uploads; presigned URLs; quotas and metering. Blobs live in the storage engine (`db.putBlob`); this module owns the metadata. Console: `public/ui/storage.js`.

## Model

* **Bucket** — name `^[a-z0-9][a-z0-9-]{2,62}$`, unique per account. Settings: `versioning` (`disabled|enabled|suspended`), `acl` (`private|public-read`), `region` (one of `RD_STORAGE_REGIONS`, informational), CORS rules, lifecycle rules, website config, tags.
* **Object** — key (UTF-8, up to 1024 bytes, no control characters), content type, size, SHA-256 + MD5 etag, user metadata, tags, optional per-object ACL (`inherit|private|public-read`). With versioning enabled every overwrite creates a version and a delete creates a delete marker; every version and marker counts towards `RD_STORAGE_MAX_OBJECTS`.
* Objects are stored as 4 MiB chunks (`RD_STORAGE_CHUNK_BYTES`) in blobs named `stb_<hex>`; large uploads are streamed, never buffered whole.

## API (all under `Authorization: Bearer …`, scope `storage`)

| Area | Routes |
| --- | --- |
| Service | `GET /api/storage/info` (limits, regions), `GET /api/storage/usage` |
| Buckets | `GET/POST /api/buckets`, `GET/PATCH/DELETE /api/buckets/:bucket` (`DELETE` answers `409` unless the bucket is empty; `?force=true` removes its contents too) |
| Config | `GET/PUT/DELETE /api/buckets/:bucket/{cors,lifecycle,website}`, `GET/PUT …/tags`, `POST …/lifecycle/run` |
| Objects | `GET /api/buckets/:bucket/objects` (prefix, delimiter, pagination), `PUT/GET/DELETE …/objects/*key`, `GET …/meta/*key`, `GET/PUT/DELETE …/tagging/*key`, `GET/PUT …/acl/*key`, `POST …/delete` (batch), `POST …/copy` |
| Versions | `GET …/versions`, `POST …/restore` |
| Multipart | `POST/GET …/uploads`, `PUT …/uploads/:id/parts/:n`, `GET …/uploads/:id/parts`, `POST …/uploads/:id/complete`, `DELETE …/uploads/:id` |
| Presigned | `POST …/presign`, `POST …/presign/revoke`, then `GET/HEAD/PUT/DELETE /presigned/:bucket/*key?…` (no auth header) |
| Website | `GET/HEAD /site/:bucket/*key` for buckets with website hosting enabled (public objects only) |

Reads support `Range`, `If-Match`, `If-None-Match`, `If-Modified-Since`, `If-Unmodified-Since`; writes accept `If-None-Match: *` (create-only) and `If-Match`. Object keys appear in the URL path (`*key`), so they may contain `/`.

### Lifecycle rules

`PUT /api/buckets/:bucket/lifecycle` takes up to 100 rules: `{id, status, prefix, tags, expirationDays, noncurrentExpirationDays, abortIncompleteMultipartDays, expiredObjectDeleteMarker, minSize, maxSize}` (a rule needs at least one action). A sweeper (`RD_STORAGE_SWEEP_INTERVAL_MS`, default 10 min; `0` disables) applies them in batches of 5000 actions; `POST …/lifecycle/run?dryRun=true` reports without changing anything.

## Security decisions

* **Active content is never served inline from our origin.** Public and presigned responses force `Content-Disposition: attachment` for HTML/XML/JS/CSS/SVG and send `Content-Security-Policy: default-src 'none'; sandbox`; website responses may run scripts but still get an opaque (sandboxed) origin, so a hostile page cannot read the console's session.
* **Presigned URLs** are HMAC-SHA256 over method, bucket, key, expiry, version, content type and disposition, compared in constant time. Maximum lifetime 7 days. `presign/revoke` rotates the bucket's signing epoch, invalidating every URL issued so far. The signing key is derived from the master key (`RD_SECRET_KEY`), or from `RD_STORAGE_PRESIGN_SECRET` when that is set to at least 16 characters.
* **Tenant isolation** — every route resolves the bucket through the caller's account; another user's bucket answers `404`, never `403`.
* **Quotas** — account byte quota (`RD_STORAGE_QUOTA_BYTES`, 5 GiB; plans may lower it through `ctx.quotas`), object count, bucket count, open uploads, concurrent uploads, part sizes. Quota and size limits are enforced before bytes are accepted.
* **Orphan sweeper** — blobs named `stb_*` that no object, version or part references and that are older than an hour are removed every 6 hours; it never touches blobs of other modules.
* **Account deletion** purges every row carrying the user's id (buckets, objects, multipart uploads and parts) and every blob they reference; this is the generic walk in `src/modules/security.js`, which also covers collections that do not exist yet.

## Metering and billing

`storage.gb_month` (daily gauge, idempotent per day), `storage.requests` (per 1M) and `storage.egress_gb` are recorded through `src/billing.js`; the console's Storage page shows usage and the Billing page prices it.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `RD_STORAGE_QUOTA_BYTES` | 5 GiB | per-account bytes (all versions) |
| `RD_STORAGE_MAX_OBJECT_BYTES` | 5 GiB | largest single object |
| `RD_STORAGE_CHUNK_BYTES` | 4 MiB | blob chunk size (1 B … 64 MiB) |
| `RD_STORAGE_MIN_PART_BYTES` / `_MAX_PART_BYTES` / `_MAX_PARTS` | 5 MiB / 512 MiB / 1000 | multipart limits (the last part may be smaller than the minimum) |
| `RD_STORAGE_MAX_BUCKETS` | 100 | buckets per account |
| `RD_STORAGE_MAX_OBJECTS` | 100 000 | object versions + markers per account |
| `RD_STORAGE_MAX_UPLOADS` | 1000 | open multipart uploads per account |
| `RD_STORAGE_MAX_CONCURRENT_UPLOADS` | 32 | simultaneous streaming uploads, server-wide |
| `RD_STORAGE_UPLOAD_TTL_HOURS` | 168 | unfinished multipart uploads are aborted after this |
| `RD_STORAGE_SWEEP_INTERVAL_MS` | 600000 | lifecycle sweeper period (`0` = off) |
| `RD_STORAGE_REGIONS` | `rd-local` | comma-separated region labels |
| `RD_STORAGE_PRESIGN_SECRET` | derived | optional dedicated presign signing secret (≥ 16 characters) |

Invalid values fall back to the default with a warning on stderr.

## Limitations

Single node, single copy: "regions" are labels, there is no replication, no server-side encryption key management beyond disk permissions, no object lock/legal hold, no event notifications on object changes,. Everything lives on one node's disk; see `docs/storage-engine.md` for backups and durability.
