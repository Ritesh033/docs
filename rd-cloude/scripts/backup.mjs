#!/usr/bin/env node
// Backup, verify and restore RD Cloude data directories (storage engine). Zero dependencies.
//
//   node scripts/backup.mjs backup  [<dataDir>] <destDir> [--live]
//   node scripts/backup.mjs verify  [<dir>] [--no-blobs] [--json]
//   node scripts/backup.mjs restore <backupDir> [<dataDir>] [--force]
//
// <dataDir> defaults to $RD_DATA_DIR or ./data. Exit codes: 0 ok, 1 problems found / operation failed, 2 usage error.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { backupDataDir, restoreBackup, verifyDataDir, DbError, DbLockedError } from '../src/db.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const defaultDataDir = () => path.resolve(process.env.RD_DATA_DIR || path.join(ROOT, 'data'))

const USAGE = `Usage:
  node scripts/backup.mjs backup  [<dataDir>] <destDir> [--live]   copy a data dir (needs the server stopped, or --live for a hot copy)
  node scripts/backup.mjs verify  [<dir>] [--no-blobs] [--json]    check snapshots, logs and blob checksums without modifying anything
  node scripts/backup.mjs restore <backupDir> [<dataDir>] [--force] verify a backup, then install it as the data dir

<dataDir> defaults to $RD_DATA_DIR or ./data.
  --live      back up while the server is running (verified afterwards; stop the server for a guaranteed-consistent copy)
  --force     restore over a non-empty data dir (the old one is moved aside, never deleted)
  --json      machine-readable verify report
  --no-blobs  skip reading every blob during verify`

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`)
  console.error(USAGE)
  process.exit(2)
}

const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--')))
const pos = args.filter((a) => !a.startsWith('--'))
const cmd = pos.shift()
const known = { backup: ['--live'], verify: ['--json', '--no-blobs'], restore: ['--force'] }
if (cmd === 'help' || flags.has('--help')) { console.log(USAGE); process.exit(0) }
if (!cmd) usage()
if (!known[cmd]) usage(`unknown command "${cmd}"`)
for (const f of flags) if (!known[cmd].includes(f)) usage(`unknown option ${f} for "${cmd}"`)

const kb = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1048576).toFixed(1)} MiB`)

try {
  if (cmd === 'backup') {
    if (pos.length < 1 || pos.length > 2) usage('backup needs a destination directory')
    const [src, dest] = pos.length === 2 ? [path.resolve(pos[0]), path.resolve(pos[1])] : [defaultDataDir(), path.resolve(pos[0])]
    const live = flags.has('--live')
    let res
    try {
      res = backupDataDir(src, dest, { lock: !live })
    } catch (e) {
      if (e instanceof DbLockedError) {
        console.error(`${e.message}\n\nThe server is running. Stop it for a consistent offline backup, or re-run with --live for a hot copy.`)
        process.exit(1)
      }
      throw e
    }
    console.log(`backup ok${live ? ' (live copy, verified)' : ''}: ${res.docs} documents, ${res.blobs} blobs (${kb(res.blobBytes)}) -> ${dest} in ${res.durationMs} ms`)
  } else if (cmd === 'verify') {
    if (pos.length > 1) usage('verify takes at most one directory')
    const dir = path.resolve(pos[0] ?? defaultDataDir())
    const rep = verifyDataDir(dir, { blobs: !flags.has('--no-blobs') })
    if (flags.has('--json')) console.log(JSON.stringify(rep, null, 2))
    else {
      console.log(`${rep.ok ? 'OK' : 'PROBLEMS FOUND'}: ${dir}`)
      console.log(`  ${rep.docs} documents in ${Object.keys(rep.collections).length} collections, sequence ${rep.seq}`)
      for (const s of rep.snapshots) console.log(`  snapshot ${s.file}: ${s.ok ? `ok (${s.rows} rows, seq ${s.seq}, ${kb(s.bytes)})` : 'CORRUPT'}`)
      for (const w of rep.wals) console.log(`  log ${w.file}: ${w.records} records${w.action ? ` (${w.action})` : ''}`)
      if (rep.blobs) console.log(`  blobs: ${rep.blobs.checked} checked (${kb(rep.blobs.bytes)}), ${rep.blobs.corrupt.length} corrupt`)
      for (const w of rep.warnings) console.log(`  warning: ${w}`)
      for (const e of rep.errors) console.log(`  ERROR: ${e}`)
    }
    process.exit(rep.ok ? 0 : 1)
  } else if (cmd === 'restore') {
    if (pos.length < 1 || pos.length > 2) usage('restore needs a backup directory')
    const src = path.resolve(pos[0])
    const dest = pos[1] ? path.resolve(pos[1]) : defaultDataDir()
    const res = restoreBackup(src, dest, { force: flags.has('--force') })
    console.log(`restore ok: ${res.docs} documents, ${res.blobs} blobs -> ${dest}`)
    if (res.previousMovedTo) console.log(`previous data directory kept at ${res.previousMovedTo}`)
  }
} catch (e) {
  if (e instanceof DbError) { console.error(`${cmd} failed: ${e.message}`); process.exit(1) }
  console.error(e)
  process.exit(1)
}
