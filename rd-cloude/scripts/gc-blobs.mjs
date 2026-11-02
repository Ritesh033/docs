#!/usr/bin/env node
// Offline blob garbage collection for a data directory. Zero dependencies. The server must be stopped (the data dir is locked).
//
//   node scripts/gc-blobs.mjs [<dataDir>] [--apply] [--grace-ms <n>]
//
// Default is a dry run that lists what would be deleted. A blob is kept when any module (drive, storage, ai) references it, and
// blobs younger than the grace period (default 5 minutes) are always kept. The collector refuses to run if a module failed to load,
// because it could then mistake that module's blobs for garbage. Exit codes: 0 ok, 1 refused/failed, 2 usage error.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from '../src/app.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true }
const apply = flag('--apply')
let graceMs
{
  const i = args.indexOf('--grace-ms')
  if (i >= 0) {
    graceMs = Number(args[i + 1])
    if (!Number.isFinite(graceMs) || graceMs < 0) { console.error('error: --grace-ms needs a non-negative number'); process.exit(2) }
    args.splice(i, 2)
  }
}
if (args.some((a) => a.startsWith('-')) || args.length > 1) { console.error('Usage: node scripts/gc-blobs.mjs [<dataDir>] [--apply] [--grace-ms <n>]'); process.exit(2) }
const dataDir = path.resolve(args[0] || process.env.RD_DATA_DIR || path.join(ROOT, 'data'))

let app
try {
  app = await createApp({ dataDir })
  const r = app.ctx.gcBlobs({ dryRun: !apply, graceMs })
  console.log(JSON.stringify({ dataDir, mode: apply ? 'apply' : 'dry-run', scanned: r.scanned, referenced: r.referenced, skippedRecent: r.skippedRecent, [apply ? 'removed' : 'wouldRemove']: r.removed, bytes: r.removedBytes, staleTmpRemoved: r.staleTmpRemoved }, null, 2))
  if (!apply && r.removed) console.log('Re-run with --apply to delete.')
  app.db.close?.()
  process.exit(0)
} catch (e) {
  console.error(`error: ${e.message}`)
  try { app?.db.close?.() } catch { /* ignore */ }
  process.exit(1)
}
