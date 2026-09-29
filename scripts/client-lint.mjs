/**
 * Browser-half lint: the dictionaries must agree with each other and with the
 * code that reads them.
 *
 * A settings page that falls back to raw keys on one language is a defect the
 * eye catches only when someone switches locale, so all three directions are
 * checked here:
 *
 *   1. zh and en declare exactly the same key set;
 *   2. every `t('…')` the bundle calls exists in both;
 *   3. every declared key is actually referenced (a stale key is dead weight
 *      that will drift);
 *   plus: the bundle parses, and its `window.__ModuleLoader__.load` id matches
 *   the package name the patch row mounts.
 *
 * @module scripts/client-lint.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const source = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8')

let failed = 0
function fail(message) {
  failed += 1
  console.log(`FAIL  ${message}`)
}
function ok(message) {
  console.log(`  ok  ${message}`)
}

// ── 1. dictionary extraction ────────────────────────────────────────────────
// The dictionaries are object literals inside `DICT = { zh: {…}, en: {…} }`.
// Each slice ends at the first close at its own indent level, so the slice
// cannot run past the dictionary into component code (an earlier version used
// `const LEVEL_KEY` as the stop marker and swallowed a Switch component's
// `'aria-checked'` prop as an English key).
function dictKeys(marker) {
  const start = source.indexOf(marker)
  if (start === -1) throw new Error(`dictionary marker not found: ${marker}`)
  const stop = source.indexOf('\n      }', start)
  if (stop === -1) throw new Error(`dictionary close not found after: ${marker}`)
  // Begin *after* the marker line: the slice used to start at `zh: {` itself,
  // and the line-anchored bare-key regex then read the marker (`zh:`) as a key.
  const bodyStart = source.indexOf('\n', start) + 1
  const slice = source.slice(bodyStart, stop)
  const keys = new Set()
  // Quoted keys: 'pref.enabled': '…'
  for (const match of slice.matchAll(/^\s*'([^']+)':/gm)) keys.add(match[1])
  // Bare keys: nav: '…', title: '…' — line-anchored so a colon inside a value
  // (a URL, a time) never reads as a key.
  for (const match of slice.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)) keys.add(match[1])
  return keys
}

const zh = dictKeys('zh: {')
const en = dictKeys('en: {')

/** The byte ranges of both dictionary bodies, so uses *inside* them don't count. */
function dictRanges() {
  const ranges = []
  for (const marker of ['zh: {', 'en: {']) {
    const start = source.indexOf(marker)
    const stop = source.indexOf('\n      }', start)
    ranges.push([source.indexOf('\n', start) + 1, stop])
  }
  return ranges
}
const DICT_RANGES = dictRanges()
function outsideDicts(text, from = 0, to = text.length) {
  let out = ''
  for (let i = from; i < to; i += 1) {
    if (DICT_RANGES.some(([a, b]) => i >= a && i < b)) continue
    out += text[i]
  }
  return out
}
const OUTSIDE = outsideDicts(source)

// ── 2. key set parity ───────────────────────────────────────────────────────
const onlyZh = [...zh].filter(key => !en.has(key))
const onlyEn = [...en].filter(key => !zh.has(key))
if (onlyZh.length > 0) fail(`keys only in zh: ${onlyZh.join(', ')}`)
if (onlyEn.length > 0) fail(`keys only in en: ${onlyEn.join(', ')}`)
if (onlyZh.length === 0 && onlyEn.length === 0) ok(`zh/en declare the same ${zh.size} keys`)

// ── 3. every t('…') resolves ───────────────────────────────────────────────
const used = new Set()
for (const match of source.matchAll(/\bt\('([^']+)'\)/g)) used.add(match[1])
// Template keys are built at the call site (`state.${m.availability}`): their
// expansions are known, and the `state.` prefix is exempt wholesale below.
const missing = [...used].filter(key => !zh.has(key) && !key.startsWith('state.'))
if (missing.length > 0) fail(`t() keys missing from the dictionaries: ${missing.join(', ')}`)
else ok(`all ${used.size} t() keys resolve`)

// ── 4. no stale keys ────────────────────────────────────────────────────────
// A key counts as read only when it is referenced *outside* both dictionary
// bodies. Counting declarations was the hole: every quoted key exists twice
// (zh + en), so the second dictionary's own declaration satisfied the check and
// a genuinely dead key passed. The outside-body view also covers the indirect
// forms the announcement pages use (`list(t, ['ann.p1', …])`, `LEVEL_KEY`,
// `PAGES`) and keys the shell reads through the registered locale namespace
// (`meta.*`), which never appear as a `t()` call in this file.
const stale = []
for (const key of zh) {
  // `state.` keys are produced dynamically; `meta.` keys are consumed by the
  // shell through `ctx.locale`; both are legitimate without a local call site.
  if (key.startsWith('state.') || key.startsWith('meta.')) continue
  const quoted = `'${key}'`
  const occurrences = OUTSIDE.split(quoted).length - 1
  const declaredBare = !key.includes('.')
  const bareRead = new RegExp(`\\bt\\('${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\)`).test(OUTSIDE)
  const read = declaredBare ? bareRead : occurrences > 0
  if (!read) stale.push(key)
}
if (stale.length > 0) fail(`declared but never read: ${stale.join(', ')}`)
else ok('no declared key is unread')

// ── 5. bundle identity ──────────────────────────────────────────────────────
const idMatch = source.match(/window\.__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/)
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
if (idMatch === null) fail('bundle id not found in client.js')
else if (idMatch[1] !== pkg.name) fail(`bundle id "${idMatch[1]}" ≠ package name "${pkg.name}"`)
else ok(`bundle id matches the package name (${idMatch[1]})`)

const patch = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8')
if (!patch.includes(`name: '${pkg.name}'`)) fail('cordis.patch.yml does not mount the package by name')
else ok('cordis.patch.yml mounts the package')

// ── 6. the key panel exists ─────────────────────────────────────────────────
for (const needle of ["type: 'password'", "'section.key'", 'KEY_URL']) {
  if (!source.includes(needle)) fail(`the API-key panel is missing ${needle}`)
}
if (failed === 0) ok('the API-key panel renders a password field, a section and a minting link')

console.log(`\nclient-lint: ${failed === 0 ? 'PASS' : `${failed} failure(s)`}`)
if (failed > 0) process.exitCode = 1
