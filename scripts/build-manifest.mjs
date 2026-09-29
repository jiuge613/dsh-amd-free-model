/**
 * Release manifest builder.
 *
 * The in-app updater installs a release by downloading every file the manifest
 * names and checking its SHA-256 against the recorded digest, so this script is
 * the trust root of that chain: `feed/manifest.json` is regenerated here from
 * the actual bytes on disk at release time, and `--check` re-derives it in CI
 * to prove the committed manifest still describes the committed files.
 *
 * Rules that exist because they were once broken elsewhere (see the reference
 * project's issue #1):
 *
 * - hashes are computed over **LF-normalized** bytes, so a Windows checkout
 *   that quietly holds CRLF cannot make the manifest drift from what npm ships;
 * - the directory walk is **recursive**, so a nested file npm will install can
 *   never be missing from the manifest — `installStaged` deletes anything the
 *   manifest does not name;
 * - `--check` exits non-zero on any mismatch instead of rewriting, so CI fails
 *   rather than silently fixing.
 *
 * Usage:
 *   node scripts/build-manifest.mjs           # write feed/manifest.json
 *   node scripts/build-manifest.mjs --check   # verify without writing
 *
 * @module scripts/build-manifest.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT = path.join(ROOT, 'feed', 'manifest.json')
const check = process.argv.includes('--check')

/**
 * The files a release ships — exactly `package.json`'s `files`, expanded.
 *
 * The two must agree. `files` decides what npm installs; this list decides what
 * the in-app updater downloads *and what it deletes*: `installStaged` removes
 * any file the manifest does not name. A manifest wider than `files` therefore
 * leaves the test suite installed on a user's machine for no reason, and one
 * narrower than `files` deletes shipped code. The `--check` suite compares the
 * committed manifest against the bytes on disk, and this list against the two
 * directories `files` names as whole trees (`adapter`, `src`, `locale`).
 *
 * `scripts/` is deliberately absent: the suites are development tools, and
 * `files` does not ship them.
 */
const RELEASE_FILES = [
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'icon.svg',
  'package.json',
  'LICENSE',
  'README.md',
  'README_EN.md',
  // Named as whole directories in package.json `files`.
  ...walk(path.join(ROOT, 'adapter')).map(relative),
  ...walk(path.join(ROOT, 'src')).map(relative),
  ...walk(path.join(ROOT, 'locale')).map(relative),
]

function walk(dir) {
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

function relative(full) {
  return path.relative(ROOT, full).split(path.sep).join('/')
}

/** LF-normalized bytes: the hash must not depend on the checkout's EOL. */
function normalizedBytes(full) {
  return fs.readFileSync(full).toString('utf8').replace(/\r\n/g, '\n')
}

function build() {
  const seen = new Set()
  const files = []
  for (const rel of [...RELEASE_FILES].sort()) {
    if (seen.has(rel)) continue
    seen.add(rel)
    const full = path.join(ROOT, rel)
    if (!fs.existsSync(full)) {
      throw new Error(`release file missing on disk: ${rel}`)
    }
    const text = normalizedBytes(full)
    files.push({
      path: rel,
      bytes: Buffer.byteLength(text, 'utf8'),
      sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
    })
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assertMatchesPackageFiles(pkg, files)
  return {
    name: pkg.name,
    version: pkg.version,
    generatedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    files,
  }
}

/**
 * The manifest and `package.json` `files` must describe the same set.
 *
 * `files` is what npm installs; the manifest is what the in-app updater
 * downloads *and what it deletes* — anything it does not name is removed on
 * install. The two drifting apart is silent in both directions: a manifest
 * wider than `files` leaves development files sitting in a user's install
 * forever, and a manifest narrower than `files` deletes shipped code on the
 * first upgrade. Checking it here means the failure lands in CI, on the commit
 * that introduced it, instead of on someone's machine.
 *
 * @param {object} pkg - the parsed package.json
 * @param {Array<{path: string}>} files - the manifest rows just built
 */
function assertMatchesPackageFiles(pkg, files) {
  const declared = pkg.files
  if (!Array.isArray(declared)) throw new Error('package.json has no `files` array')
  const listed = new Set()
  for (const entry of declared) {
    const rel = String(entry).replace(/^\.\//, '').replace(/\/$/, '')
    if (fs.existsSync(path.join(ROOT, rel)) && fs.statSync(path.join(ROOT, rel)).isDirectory()) {
      for (const file of walk(path.join(ROOT, rel))) listed.add(relative(file))
    } else {
      listed.add(rel)
    }
  }
  const manifested = new Set(files.map(row => row.path))
  const unlisted = [...manifested].filter(file => !listed.has(file))
  const unshipped = [...listed].filter(file => !manifested.has(file))
  if (unlisted.length > 0) {
    throw new Error(`the manifest ships files package.json \`files\` does not list: ${unlisted.join(', ')}`)
  }
  if (unshipped.length > 0) {
    throw new Error(`package.json \`files\` lists files the manifest does not ship: ${unshipped.join(', ')} — the in-app updater deletes anything the manifest does not name`)
  }
}

const manifest = build()

if (check) {
  let ok = true
  if (!fs.existsSync(OUT)) {
    console.error('feed/manifest.json is missing — run `npm run manifest`')
    ok = false
  } else {
    const committed = JSON.parse(fs.readFileSync(OUT, 'utf8'))
    const byPath = new Map(committed.files?.map(row => [row.path, row]) ?? [])
    for (const row of manifest.files) {
      const other = byPath.get(row.path)
      if (other === undefined) {
        console.error(`manifest is missing ${row.path}`)
        ok = false
      } else if (other.sha256 !== row.sha256 || other.bytes !== row.bytes) {
        console.error(`manifest drifted for ${row.path}: committed ${other.sha256?.slice(0, 12)} ≠ on-disk ${row.sha256.slice(0, 12)}`)
        ok = false
      }
    }
    for (const row of committed.files ?? []) {
      if (!manifest.files.some(file => file.path === row.path)) {
        console.error(`manifest names a file that is no longer released: ${row.path}`)
        ok = false
      }
    }
    if (committed.version !== manifest.version) {
      console.error(`manifest version ${committed.version} ≠ package.json ${manifest.version}`)
      ok = false
    }
  }
  console.log(ok ? `manifest check: OK (${manifest.files.length} files, ${manifest.version})` : 'manifest check: FAILED')
  process.exitCode = ok ? 0 : 1
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`wrote feed/manifest.json — ${manifest.files.length} files, ${manifest.version}`)
}
