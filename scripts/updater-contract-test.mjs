/**
 * The release manifest, read the way the updater reads it.
 *
 * The manifest is the trust root of the in-app upgrade: `PluginUpdater`
 * downloads each file the manifest names and checks its SHA-256, and
 * `installStaged` deletes anything the manifest does not name. So a manifest
 * the *updater* cannot parse is not a cosmetic problem — it turns the whole
 * upgrade path off, and it does so quietly, because the failure only shows up
 * when a user clicks "check for updates".
 *
 * That is exactly how the `bytes`/`size` mismatch got shipped: the builder
 * wrote `bytes`, the parser read `size`, and the only test in the suite
 * compared the manifest against the bytes on disk — a comparison that passes
 * perfectly while the consumer of the same document cannot read a single
 * entry. This suite closes that gap by feeding the committed manifest to the
 * real parser and asserting what the updater would then do with it.
 *
 * @module scripts/updater-contract-test.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { downloadManifest, parseManifest } from '../src/updater.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const API = 'https://api.github.com'
const SLUG = 'jiuge613/dsh-amd-free-model'

let passed = 0
const failures = []
async function check(label, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${label}`)
  } catch (error) {
    failures.push(label)
    console.log(`FAIL  ${label}`)
    console.log(`      ${error?.message ?? error}`)
  }
}

const REPO_SOURCE = `https://raw.githubusercontent.com/${SLUG}/main/feed/manifest.json`

async function main() {
  // The parser is exercised through its public surface, exactly as the updater
  // reaches it: hand it a fetch that serves the committed document.
  const serve = url => {
    if (String(url).startsWith('https://raw.githubusercontent.com/')) {
      return Promise.resolve(fs.readFileSync(path.join(ROOT, 'feed', 'manifest.json'), 'utf8'))
    }
    return Promise.reject(new Error(`unexpected source ${url}`))
  }

  await check('the committed manifest is accepted by the real parser', async () => {
    const { manifest } = await downloadManifest([REPO_SOURCE], { fetchImpl: async url => {
      const body = await serve(url)
      return {
        ok: true,
        status: 200,
        text: async () => body,
        headers: { get: () => null },
      }
    } })
    // parseManifest keeps only what the updater acts on: version, base, files.
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
    assert.ok(manifest.files.some(file => file.path === 'package.json'), 'package.json is mandatory')
    assert.ok(manifest.files.length >= 20, `only ${manifest.files.length} files survived parsing`)
    // The failure this pins: every entry read as out-of-range because the
    // builder's `bytes` was not the parser's `size`.
    for (const file of manifest.files) {
      assert.ok(Number.isInteger(file.size) && file.size > 0, `${file.path} has no usable size`)
    }
  })

  await check('every entry names a file that exists with the recorded size', async () => {
    const { manifest } = await downloadManifest([REPO_SOURCE], { fetchImpl: async url => {
      const body = await serve(url)
      return { ok: true, status: 200, text: async () => body, headers: { get: () => null } }
    } })
    for (const file of manifest.files) {
      const full = path.join(ROOT, file.path)
      assert.ok(fs.existsSync(full), `${file.path} is in the manifest but not on disk`)
      const actual = Buffer.byteLength(fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n'), 'utf8')
      assert.equal(actual, file.size, `${file.path}: manifest says ${file.size} bytes, disk has ${actual}`)
    }
  })

  await check('the shipped manifest is reachable at the URL the updater reads', async () => {
    // Offline suites never touch the network; this one does, but it reads a
    // public document and is the only way to catch a wrong slug, a wrong branch,
    // or a manifest that was never committed. Skipped when unreachable so a
    // flaky network cannot fail a unit suite.
    let reachable = true
    let body
    try {
      const response = await fetch(REPO_SOURCE, { signal: AbortSignal.timeout(20000) })
      reachable = response.ok
      body = response.ok ? await response.json() : undefined
    } catch {
      reachable = false
    }
    if (!reachable) {
      console.log('      (skipped: manifest URL not reachable from this machine)')
      return
    }
    assert.equal(body.name, 'dsh-amd-free-model')
    assert.equal(body.files.length, 28, 'the shipped manifest should list the 28 release files')
    // And the file the updater downloads first is parseable, so the real
    // failure reported by the user cannot recur.
    const license = body.files.find(row => row.path === 'LICENSE')
    assert.ok(license !== undefined)
    assert.ok(Number.isInteger(license.bytes) && license.bytes > 0)
  })

  await check('a manifest whose entries carry neither bytes nor size is refused', () => {
    // The mirror image of the regression: the guard must still reject a
    // genuinely malformed entry rather than accept a missing field.
    assert.throws(
      () => parseManifest({
        name: 'x', version: '1.0.0',
        files: [{ path: 'a.js', sha256: 'a'.repeat(64) }],
      }),
      /out-of-range size/,
    )
    assert.throws(
      () => parseManifest({
        name: 'x', version: '1.0.0',
        files: [{ path: 'a.js', sha256: 'a'.repeat(64), bytes: 0 }],
      }),
      /out-of-range size/,
    )
    assert.throws(
      () => parseManifest({
        name: 'x', version: '1.0.0',
        files: [{ path: 'a.js', sha256: 'a'.repeat(64), bytes: 64 * 1024 * 1024 }],
      }),
      /out-of-range size/,
    )
  })

  await check('the source list still names every source when none answers', async () => {
    // The shape of the message the user reported: a long "no manifest source
    // answered (… -> …)" string. It must survive, because it is the only clue
    // that the repositories are reachable but the documents are unusable.
    await assert.rejects(
      () => downloadManifest(['https://example.invalid/a.json', 'https://example.invalid/b.json'], {
        fetchImpl: async () => { throw new Error('offline') },
      }),
      /no manifest source answered/,
    )
  })

  console.log(`\nupdater-contract-test: ${passed} passed, ${failures.length} failed`)
  if (failures.length > 0) process.exitCode = 1
}

main().catch(error => {
  console.error('updater-contract-test crashed:', error)
  process.exitCode = 1
})
