/**
 * Section-gate test, in its own process.
 *
 * The AMD directory declares which section it is serving in the response body
 * (`public_free` versus the paid `dedicated` section). The plugin refuses any
 * section it does not own, and that refusal has to be exercised against a
 * gateway that actually answers a paid section — which means the plugin's
 * `AMD_ORIGIN` must point at it.
 *
 * That constant is read at module load, and `index.js` shares its `src/*`
 * dependencies with every other import in this process, so this cannot be a
 * second `apply()` inside `host-selftest.mjs`: the origin is already bound by
 * the time the free-section gateway is running, and a cache-busting query on
 * the entry module would still reuse the cached `src/upstream.js`. A separate
 * process is the only honest way to test the other section.
 *
 * What it proves:
 *   1. a bootstrap document declaring `dedicated` is refused before any card is
 *      read, so the paid fleet never enters the catalog;
 *   2. the plugin still mounts and still serves a roster — the curated
 *      free-only baseline — rather than failing to start or emptying the
 *      picker;
 *   3. no paid model id appears anywhere in the summary, and the paid-section
 *      cards are not reported as "excluded paid" either (they were never read).
 *
 * @module scripts/section-gate-test.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startFakeGateway, FLEET, PAID_MODEL } from './lib/fake-gateway.mjs'
import { makeCtx, callRoute, waitFor } from './lib/fake-kernel.mjs'

const API = '/api/amd-free-model'

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

async function main() {
  const gateway = await startFakeGateway({ directorySection: 'dedicated' })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'amd-free-model-section-'))
  process.env.AMD_FREE_MODEL_ORIGIN = gateway.origin
  process.env.DSH_HOME = home

  const { apply } = await import('../index.js')
  const verbose = process.env.AMD_TEST_VERBOSE === '1'
  const logs = []
  const ctx = makeCtx({ log: message => { logs.push(message); if (verbose) console.log(message) } })

  console.log(`paid-section gateway at ${gateway.origin}`)

  apply(ctx, {})
  assert.ok(ctx.__test.registration !== null, 'adapter registered during apply')

  const call = (method, routePath, body) => callRoute(
    ctx.__test.routes.find(route => route.kind === 'prefix' && route.path === API)?.handler,
    method, `${API}${routePath}`, body,
  )

  const data = await waitFor(async () => {
    const json = (await call('GET', '/summary')).json
    return json && (json.catalog ?? []).length > 0 ? json : null
  }, { label: 'a roster on a paid-section gateway' })

  await check('the paid section is refused in the log', async () => {
    // The boot refresh runs asynchronously inside `apply()`, so its refusal
    // lands a tick or two after the routes are registered. Wait for the log
    // line rather than sampling the instant the roster appears — the roster is
    // the fallback baseline and exists before any request is answered.
    const refusal = await waitFor(
      () => logs.find(line => line.includes('dedicated') && line.includes('refusing')),
      { label: 'the section-refusal log line' },
    )
    assert.ok(refusal.includes('public_free'), 'the refusal must name the section it wanted')
  })

  await check('no paid card is read, so none is counted as "excluded paid"', async () => {
    // The refusal happens before the per-card fan-out, so the gateway saw
    // exactly one bootstrap call and zero detail calls. Give the round that
    // did the refusing time to land before counting.
    await waitFor(() => gateway.stats.bootstrapCount >= 1, { label: 'the bootstrap request' })
    assert.equal(gateway.stats.bootstrapCount, 1)
    assert.equal(gateway.stats.detailCount, 0, 'a card was fetched despite the refusal')
    assert.deepEqual(data.paidExcluded, [])
  })

  await check('the roster is the curated free baseline, not the paid fleet', () => {
    assert.deepEqual(data.catalog.map(entry => entry.id), FLEET.map(row => row.id))
    assert.ok(!data.catalog.some(entry => entry.id === PAID_MODEL))
  })

  await check('the plugin still works as a plugin on a paid-section gateway', async () => {
    // Mounted, serving, and describable — the free-only promise is enforced by
    // refusing the section, not by refusing to run.
    const response = await call('GET', '/summary')
    assert.equal(response.status, 200)
    const meta = await call('GET', '/meta')
    assert.equal(meta.status, 200)
    assert.equal(meta.json.distribution, 'self')
  })

  ctx.__test.dispose()
  await gateway.close()
  fs.rmSync(home, { recursive: true, force: true })

  console.log(`\nsection-gate-test: ${passed} passed, ${failures.length} failed`)
  if (failures.length > 0) process.exitCode = 1
}

main().catch(error => {
  console.error('section-gate-test crashed:', error)
  process.exitCode = 1
})
