/**
 * The shipped announcement feed, read the way the announcement center reads it.
 *
 * `parseFeed` is a validator with a fixed vocabulary: `announcements` for the
 * list, `html` for the body, `createdAt` for the stamp, `level` from a known set.
 * A feed document that uses anything else is not "mostly working" — the
 * validator throws, `fetchFeed` moves to the next source, and the panel renders
 * empty with the cached copy or nothing at all. That is exactly how this
 * package's first feed shipped: it used `items`/`body`/`published`, so every
 * announcement was silently discarded and the announcement center looked
 * permanently dead.
 *
 * So the committed document is parsed here through the real validator, and the
 * rows are checked for the fields the renderer actually reads. The other suites
 * never touched this file.
 *
 * @module scripts/feed-contract-test.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseFeed, fetchFeed, LEVELS, DEFAULT_FEED_SOURCES } from '../src/feed.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
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

const committed = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'feed', 'announcements.json'), 'utf8'))

async function main() {
  await check('the committed feed parses as a feed', () => {
    // The exact call the announcement center makes. A vocabulary mismatch lands
    // here as a thrown error rather than an empty panel.
    const parsed = parseFeed(committed())
    assert.ok(Array.isArray(parsed.announcements))
    assert.ok(parsed.announcements.length > 0, 'the feed carries no announcements')
  })

  await check('every announcement carries the fields the renderer reads', () => {
    for (const item of parseFeed(committed()).announcements) {
      assert.equal(typeof item.id, 'string')
      assert.ok(item.id !== '', 'an announcement has no id')
      assert.ok(item.title.trim() !== '', `${item.id} has no title`)
      // The body is rendered as sanitized HTML, so an announcement without one
      // renders as a title and nothing else.
      assert.equal(typeof item.html, 'string')
      assert.ok(item.html.trim() !== '', `${item.id} has no body`)
      assert.ok(LEVELS.has(item.level), `${item.id} has an unknown level "${item.level}"`)
      assert.equal(typeof item.createdAt, 'number')
      assert.ok(item.createdAt > 0, `${item.id} has no usable timestamp`)
    }
  })

  await check('the feed uses the validator vocabulary, not a lookalike', () => {
    // Guards the exact class of bug this suite exists for: renaming a field to
    // something plausible (`body`, `items`) keeps the JSON valid and the panel
    // empty. Each of these spellings is *absent* from the schema on purpose.
    const raw = committed()
    assert.ok(Array.isArray(raw.announcements), 'the list must be `announcements`')
    assert.equal(raw.items, undefined, '`items` is not a field the parser reads')
    for (const item of raw.announcements) {
      assert.equal(item.body, undefined, '`body` is not a field the parser reads')
      assert.equal(item.published, undefined, '`published` is not a field the parser reads')
      assert.equal(typeof item.html, 'string')
      assert.equal(typeof item.createdAt, 'string')
    }
  })

  await check('a document in the wrong vocabulary is rejected, not half-read', () => {
    // The original shipped shape must fail loudly, so nobody reintroduces it
    // believing it works.
    assert.throws(() => parseFeed({ items: [{ id: 'a', title: 'b', body: 'c' }] }), /announcements array/)
    assert.throws(() => parseFeed(null), /JSON object/)
  })

  await check('the default sources point at this repository', () => {
    assert.ok(DEFAULT_FEED_SOURCES.length >= 2, 'a single source leaves no fallback')
    for (const source of DEFAULT_FEED_SOURCES) {
      assert.ok(source.includes(SLUG), `source points elsewhere: ${source}`)
      assert.ok(source.includes('feed/announcements.json'), `source is not the feed: ${source}`)
    }
  })

  await check('the committed feed is fetchable at the URL the panel reads', async () => {
    // The one network-touching check, and it is skipped rather than failed when
    // unreachable, so an offline machine cannot turn a unit suite red.
    let payload
    try {
      const response = await fetch(DEFAULT_FEED_SOURCES[0], { signal: AbortSignal.timeout(20000) })
      if (!response.ok) {
        console.log(`      (skipped: feed URL answered HTTP ${response.status})`)
        return
      }
      payload = await response.json()
    } catch {
      console.log('      (skipped: feed URL not reachable from this machine)')
      return
    }
    const parsed = parseFeed(payload)
    assert.ok(parsed.announcements.length > 0, 'the published feed parses to zero announcements')
    // The body must survive the round trip, since the whole panel is that HTML.
    assert.ok(parsed.announcements.some(item => item.html.includes('<')), 'no announcement body survived')
  })

  console.log(`\nfeed-contract-test: ${passed} passed, ${failures.length} failed`)
  if (failures.length > 0) process.exitCode = 1
}

main().catch(error => {
  console.error('feed-contract-test crashed:', error)
  process.exitCode = 1
})
