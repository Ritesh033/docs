# Drive

`src/drive.js` (API), `public/ui/drive.js` + `drive.css` (explorer). Original endpoints are unchanged (`PUT /api/drive/files?name=`, versions, `/api/drive/files/:id/share`, public `/s/:token`).

## Model
`files` rows: `{userId, name, contentType, folderId, versions:[{n, blobId | chunks:[{blobId,size}], size, sha256, label?, at}], nextVersion, starred, tags, trashedAt?}`;
`drive_folders`, `drive_uploads`, `drive_acl`, `drive_activity`, `drive_share_log`, `shares`. Names are unique per folder; names may not contain slashes/backslashes/control characters.
Uploading the same name into the same folder creates a new version, unless the bytes are identical to the latest version (`unchanged: true`). Version numbers never repeat; at most `RD_DRIVE_MAX_VERSIONS` (50) are kept — the oldest *unlabelled* versions are pruned and their blobs deleted.

## API (all `/api/drive/…` need auth; `/s/…` and `/api/drive/public/…` are public)
| | |
|---|---|
| `GET files[?folder=root\|id&starred=1&tag=&sort=]`, `GET browse?folder=`, `GET folders`, `GET usage`, `GET search?q=`, `GET duplicates`, `GET shared`, `GET trash` | listing |
| `PUT files?name=&folder=` (raw body ≤ 25 MB), `PUT files/:id/content` | upload / replace (editor+) |
| `POST uploads {name,size,folderId,contentType}` → `PUT uploads/:id/parts/:n` (≤ 16 MB) → `POST uploads/:id/complete`; `GET/DELETE uploads/:id` | resumable chunked upload up to 50 GB (parts are stored as a manifest and streamed back; never concatenated in memory) |
| `GET files/:id[?version=n&inline=1]` | streaming download with `Range`, `ETag`/304, RFC 5987 filenames |
| `PATCH files/:id {name,folderId,starred,tags}`, `POST files/:id/copy`, `DELETE files/:id[?permanent=1]`, `POST files/:id/restore` | metadata, trash |
| `GET files/:id/versions`, `PATCH files/:id/versions/:n {label}`, `POST files/:id/versions/:n/restore` | version history |
| `POST/PATCH/DELETE folders[/:id]`, `POST folders/:id/restore` | folders (depth ≤ 20, cycle checks, trash cascades) |
| `POST files/:id/share {permission,expiresInHours,maxDownloads,password}`, `GET files/:id/shares`, `DELETE shares/:token` | link sharing with access log |
| `GET/POST/DELETE files/:id/acl` | people sharing (viewer/editor); folder ACLs are inherited; `orgId` principals use `ctx.access.orgRole` |
| `POST zip {fileIds,folderIds,name}` | streaming ZIP (deflate, data descriptors, ≤ 5000 files, < 4 GB, no zip64) |
| `GET files/:id/activity` | per-file activity feed |

## Security notes
* Downloads are `attachment` by default with `nosniff` and `Content-Security-Policy: sandbox`. `?inline=1` / `view` shares only render a whitelist (png/jpeg/gif/webp/avif/bmp, pdf, audio/video, text/plain); **HTML, SVG and scripts are never rendered inline**.
* Share passwords are scrypt-hashed, accepted only in the `x-share-password` header or a POST body (never the URL), and failed guesses are throttled (10 / 10 min per link+IP, 429).
* Sharing by email gives the same answer whether or not an account exists (no enumeration); recipients are notified in-app.
* Trashed files are invisible to every API and link; purged after `RD_DRIVE_TRASH_DAYS` (30) by an hourly sweeper. Missing blobs answer 410, checksum failures 500 (logged).
* Quotas: `RD_DRIVE_QUOTA_BYTES` (5 GiB, counts all versions + unfinished uploads) and the plan's `storage.bytes` quota (`ctx.quotas`).
* Search tokens come from names and extracted text of text-like files ≤ 1 MB (≤ 2000 tokens per file; script/style bodies stripped from HTML); binary content is not indexed.

## Limitations
No server-side thumbnails or PDF preview, copy duplicates bytes (no refcounting), ZIP has no zip64, org-wide folder ownership is not modelled (org principals are per file/folder ACL entries), the search index is rebuilt lazily in memory per user after a restart.
