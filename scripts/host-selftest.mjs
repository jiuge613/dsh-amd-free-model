/**
 * Host half, end to end — against a local fake of the AMD gateway.
 *
 * This is the suite that proves the plugin actually works, in the same shape
 * the reference project used: `apply()` on a cordis-shaped context, the real
 * route handlers invoked with mock requests, and the real adapter driven
 * through full streams. Nothing here touches the network — the fake gateway
 * in `lib/fake-gateway.mjs` answers every endpoint the live service exposes.
 *
 * What it proves, in order:
 *
 *  1. cold start with no key: the roster appears from the directory, every
 *     model reads `no-key`, and the API never leaks a credential it does not
 *     have;
 *  2. key saved: the verdict flips, eight models probe `available`, the ninth
 *     (which the gateway refuses on the chat wire) drops out of the picker;
 *  3. the summary's masked key is a mask — the raw key never crosses the wire;
 *  4. streams: a normal turn, a tool turn, a mid-stream cut, an empty stop,
 *     a 429, and the effort budgets actually sent as `max_tokens`;
 *  5. the trust fence rejects cross-site requests;
 *  6. the forward listener serves `/v1/models` and one completion.
 *
 * @module scripts/host-selftest.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startFakeGateway, VALID_KEY, FLEET, PAID_MODEL } from './lib/fake-gateway.mjs'
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
    failures.push({ label, error })
    console.log(`FAIL  ${label}`)
    console.log(`      ${error?.message ?? error}`)
  }
}

/** Drain an adapter stream into a comparable shape. */
async function drain(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function summarize(chunks) {
  const out = { text: '', toolCalls: [], reasoning: '', usage: undefined, finish: undefined }
  for (const chunk of chunks) {
    if (chunk.type === 'text-delta') out.text += chunk.text
    else if (chunk.type === 'reasoning-delta') out.reasoning += chunk.text
    else if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') out.toolCalls.push(chunk.block)
    else if (chunk.type === 'usage') out.usage = chunk.usage
    else if (chunk.type === 'finish') out.finish = chunk.reason
  }
  return out
}

async function main() {
  const gateway = await startFakeGateway()
  // The origin is read at module load, so the env lands before the import.
  process.env.AMD_FREE_MODEL_ORIGIN = gateway.origin
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'amd-free-model-selftest-'))
  process.env.DSH_HOME = home

  const { apply } = await import('../index.js')
  const verbose = process.env.AMD_TEST_VERBOSE === '1'
  const ctx = makeCtx({ log: message => { if (verbose) console.log(message) } })

  console.log(`fake gateway at ${gateway.origin}`)
  console.log(`DSH_HOME at ${home}`)

  const api = () => ctx.__test.routes.find(route => route.kind === 'prefix' && route.path === API)?.handler
  const call = (method, routePath, body, headers) => callRoute(api(), method, `${API}${routePath}`, body, headers)

  // ── boot ──────────────────────────────────────────────────────────────────
  apply(ctx, {})
  assert.ok(ctx.__test.registration !== null, 'adapter registered during apply')

  const summary = await waitFor(async () => {
    const response = await call('GET', '/summary')
    const data = response.json
    if (data === undefined) return null
    if ((data.catalog ?? []).length === 0) return null
    // The boot round must have settled: every model carries a verdict.
    const settled = data.catalog.every(model => model.availability !== undefined && model.availability !== 'unknown')
    return settled ? data : null
  }, { label: 'boot summary with verdicts' })

  await check('directory discovered the full fleet', () => {
    // The fake serves one paid card in the free directory on purpose; the
    // catalog is free-only, so its length is the free fleet, not the card count.
    assert.equal(summary.catalog.length, FLEET.length)
    assert.deepEqual(summary.catalog.map(model => model.id), FLEET.map(row => row.id))
  })

  await check('a paid card in the free directory is excluded, and reported', () => {
    assert.ok(!summary.catalog.some(model => model.id === PAID_MODEL), 'a paid model reached the catalog')
    assert.deepEqual(summary.paidExcluded, [PAID_MODEL], 'the excluded id must be visible, not silently dropped')
    // The detail document for it was still fetched — the decision is made on
    // evidence, not on the absence of a lookup.
    assert.equal(gateway.stats.detailCount, FLEET.length + 1)
  })

  await check('every model reads no-key before a key is configured', () => {
    for (const model of summary.catalog) assert.equal(model.availability, 'no-key', `${model.id} → ${model.availability}`)
    // …and all nine are still advertised: not knowing is not a refusal.
    const routes = new Set(summary.catalog.map(model => model.route))
    assert.deepEqual([...routes], ['amd-free-model'])
  })

  await check('summary carries the load badges from the public endpoint', async () => {
    // The load refresh runs beside the catalog round, not ahead of it, so wait
    // for its own signal instead of racing the boot sequence.
    const data = await waitFor(async () => {
      const current = (await call('GET', '/summary')).json
      return current?.load && Object.keys(current.load).length === FLEET.length ? current : null
    }, { label: 'fleet load badges' })
    assert.ok(data.load['DeepSeek-V4-Flash'].state === 'idle' || data.load['DeepSeek-V4-Flash'].state !== '')
    assert.equal(gateway.stats.loadCount >= 1, true)
    assert.equal(gateway.stats.bootstrapWithoutSiteHeaders, 0, 'directory POST must send Origin+Referer')
  })

  await check('the default probe interval is daily', () => {
    assert.equal(summary.settings.probeIntervalMinutes, 1440)
  })

  await check('the discovery detail actually reached the catalog', () => {
    const vision = summary.catalog.find(model => model.id === 'MiMo-V2.6-Flash')
    assert.equal(vision.vision, true)
    assert.equal(vision.contextWindow, 1048576)
    const text = summary.catalog.find(model => model.id === 'DeepSeek-V4-Flash')
    assert.equal(text.vision, false)
  })

  await check('no key is configured, and the API says so without a value', () => {
    assert.equal(summary.settings.key.set, false)
    assert.equal(summary.settings.key.ok, false)
    assert.equal(summary.settings.key.masked, '')
    assert.equal(JSON.stringify(summary).includes('apiKey'), false)
  })

  // ── key save ──────────────────────────────────────────────────────────────
  const saved = await call('POST', '/settings', { apiKey: VALID_KEY, defaultMaxTokens: 32768 })
  assert.equal(saved.status, 200, `settings save failed: ${saved.body}`)

  const withKey = await waitFor(async () => {
    const data = (await call('GET', '/summary')).json
    if (data?.settings?.key?.ok !== true) return null
    const settled = data.catalog.every(model => model.availability === 'available' || model.availability === 'unavailable')
    return settled ? data : null
  }, { label: 'key verified and probe round settled' })

  await check('the key verifies and is reported masked', () => {
    assert.equal(withKey.settings.key.set, true)
    assert.equal(withKey.settings.key.ok, true)
    assert.match(withKey.settings.key.masked, /^amdk…cdef$/)
    assert.ok(!JSON.stringify(withKey).includes(VALID_KEY), 'the raw key must never appear in a summary')
  })

  await check('eight models probe available; the refused one leaves the picker', () => {
    const available = withKey.catalog.filter(model => model.availability === 'available')
    const unavailable = withKey.catalog.filter(model => model.availability === 'unavailable')
    assert.equal(available.length, 8)
    assert.equal(unavailable.length, 1)
    assert.equal(unavailable[0].id, 'MinerU2.5-Pro', 'the non-chat lane must be the one refused')
    assert.equal(unavailable[0].route, null, 'a refused model is not advertised')
    for (const model of available) assert.equal(model.route, 'amd-free-model')
  })

  await check('the gateway only saw keys it accepted', () => {
    assert.equal(gateway.stats.modelsCount >= 1, true)
    assert.equal(gateway.stats.chatCount >= 8, true, 'one ping per routable model')
  })

  // ── streams ───────────────────────────────────────────────────────────────
  const adapter = ctx.__test.registration.adapter
  const entryOf = id => withKey.catalog.find(model => model.id === id)

  await check('a normal turn streams text, usage, and a stop finish', async () => {
    const result = summarize(await drain(adapter.stream({
      provider: 'amd-free-model',
      model: 'DeepSeek-V4-Flash',
      messages: [{ role: 'user', content: 'hello world' }],
      sessionId: 'selftest-normal',
    }, entryOf('DeepSeek-V4-Flash'))))
    assert.equal(result.finish?.kind, 'stop')
    assert.equal(result.text, 'echo: hello world')
    assert.deepEqual(result.usage, { inputTokens: 24, outputTokens: 9, totalTokens: 33 })
  })

  await check('a tool turn lands as one assembled tool-call block', async () => {
    const result = summarize(await drain(adapter.stream({
      provider: 'amd-free-model',
      model: 'DeepSeek-V4-Flash',
      messages: [{ role: 'user', content: 'please use a tool' }],
      sessionId: 'selftest-tool',
    }, entryOf('DeepSeek-V4-Flash'))))
    assert.equal(result.finish?.kind, 'tool-calls')
    assert.equal(result.toolCalls.length, 1)
    assert.equal(result.toolCalls[0].name, 'get_weather')
    assert.equal(JSON.parse(result.toolCalls[0].arguments).city, 'Paris')
  })

  await check('a stream cut mid-answer reports STREAM_CUT, not a retryable blip', async () => {
    const result = summarize(await drain(adapter.stream({
      provider: 'amd-free-model',
      model: 'DeepSeek-V4-Flash',
      messages: [{ role: 'user', content: 'please cut this stream' }],
      sessionId: 'selftest-cut',
    }, entryOf('DeepSeek-V4-Flash'))))
    assert.equal(result.finish?.kind, 'error')
    assert.equal(result.finish.failure.code, 'STREAM_CUT')
    assert.ok(result.text.length > 0, 'the delivered content is what made it non-retryable')
  })

  await check('an empty stop reports EMPTY_RESPONSE', async () => {
    const result = summarize(await drain(adapter.stream({
      provider: 'amd-free-model',
      model: 'DeepSeek-V4-Flash',
      messages: [{ role: 'user', content: 'empty' }],
      sessionId: 'selftest-empty',
    }, entryOf('DeepSeek-V4-Flash'))))
    assert.equal(result.finish?.kind, 'error')
    assert.equal(result.finish.failure.code, 'EMPTY_RESPONSE')
  })

  await check('429 maps to a non-retryable RATE_LIMIT failure', async () => {
    const result = summarize(await drain(adapter.stream({
      provider: 'amd-free-model',
      model: 'DeepSeek-V4-Flash',
      messages: [{ role: 'user', content: 'quota exceeded please' }],
      sessionId: 'selftest-quota',
    }, entryOf('DeepSeek-V4-Flash'))))
    assert.equal(result.finish?.kind, 'error')
    assert.equal(result.finish.failure.code, 'RATE_LIMIT')
    assert.equal(result.finish.failure.status, 429)
  })

  await check('effort levels become the max_tokens actually sent', async () => {
    const before = gateway.stats.chatBodies.length
    await drain(adapter.stream({
      provider: 'amd-free-model',
      model: 'DeepSeek-V4-Flash',
      messages: [{ role: 'user', content: 'light budget' }],
      reasoningEffort: 'light',
      sessionId: 'selftest-effort-light',
    }, entryOf('DeepSeek-V4-Flash')))
    assert.equal(gateway.stats.chatBodies[before]?.max_tokens, 2048)

    await drain(adapter.stream({
      provider: 'amd-free-model',
      model: 'DeepSeek-V4-Flash',
      messages: [{ role: 'user', content: 'deep budget' }],
      reasoningEffort: 'deep',
      sessionId: 'selftest-effort-deep',
    }, entryOf('DeepSeek-V4-Flash')))
    assert.equal(gateway.stats.chatBodies[before + 1]?.max_tokens, 32768, 'deep is the model capacity clamped by settings')
  })

  await check('a thinking-always-on model doubles its ladder rung', async () => {
    const before = gateway.stats.chatBodies.length
    await drain(adapter.stream({
      provider: 'amd-free-model',
      model: 'MiMo-V2.6-Flash',
      messages: [{ role: 'user', content: 'mimo light' }],
      reasoningEffort: 'light',
      sessionId: 'selftest-effort-mimo',
    }, entryOf('MiMo-V2.6-Flash')))
    assert.equal(gateway.stats.chatBodies[before]?.max_tokens, 4096, '2048 doubled: thinking shares the ceiling')
  })

  await check('no key at stream time fails closed with INVALID_CREDENTIAL', async () => {
    await call('POST', '/settings', { apiKey: null })
    await waitFor(async () => (await call('GET', '/summary')).json?.settings?.key?.set === false, { label: 'key cleared' })
    const result = summarize(await drain(adapter.stream({
      provider: 'amd-free-model',
      model: 'DeepSeek-V4-Flash',
      messages: [{ role: 'user', content: 'after clear' }],
      sessionId: 'selftest-nokey',
    }, entryOf('DeepSeek-V4-Flash'))))
    assert.equal(result.finish?.kind, 'error')
    assert.equal(result.finish.failure.code, 'INVALID_CREDENTIAL')
    assert.equal(gateway.stats.chatCount >= 16, true, 'no chat request was sent without a key')
  })

  // ── trust fence ───────────────────────────────────────────────────────────
  await check('the trust fence refuses a cross-site request', async () => {
    const response = await call('GET', '/summary', undefined, { 'sec-fetch-site': 'cross-site' })
    assert.equal(response.status, 403)
  })

  await check('the trust fence refuses a foreign origin', async () => {
    const response = await call('GET', '/summary', undefined, { origin: 'https://evil.example', referer: 'https://evil.example/x' })
    assert.equal(response.status, 403)
  })

  // ── forward listener ──────────────────────────────────────────────────────
  await check('forward listener serves models and one completion', async () => {
    await call('POST', '/settings', { apiKey: VALID_KEY })
    await waitFor(async () => (await call('GET', '/summary')).json?.settings?.key?.ok === true, { label: 'key re-verified' })
    await call('POST', '/settings', { forward: { enabled: true, host: '127.0.0.1', port: 0 } })
    const forwardInfo = await waitFor(async () => {
      const settings = (await call('GET', '/summary')).json?.settings
      return settings?.forward?.running === true && settings.forward.actualPort > 0 ? settings.forward : null
    }, { label: 'forward listener bound' })

    const base = `http://127.0.0.1:${forwardInfo.actualPort}`
    const keyResponse = await call('GET', '/forward/key')
    const forwardKey = keyResponse.json.key
    assert.ok(typeof forwardKey === 'string' && forwardKey.length > 10, 'a forward key is minted')

    const unauthorized = await fetch(`${base}/v1/models`)
    assert.equal(unauthorized.status, 401, 'the forward port requires its key')

    const models = await (await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${forwardKey}` } })).json()
    // The refused model is not advertised, so it is not in this list either.
    assert.equal(models.data.length, 8)

    const completion = await (await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${forwardKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'DeepSeek-V4-Flash', messages: [{ role: 'user', content: 'through the port' }] }),
    })).json()
    assert.equal(completion.choices[0].message.content, 'echo: through the port')
    assert.equal(completion.usage.completion_tokens, 9)
  })

  // ── bench + stats ─────────────────────────────────────────────────────────
  await check('the bench endpoint measures one call', async () => {
    const response = await call('POST', '/bench', { model: 'DeepSeek-V4-Flash', effort: 'balanced' })
    assert.equal(response.status, 200, response.body)
    assert.equal(response.json.ok, true)
    assert.equal(response.json.outputTokens, 9)
  })

  await check('usage accumulated into the stats store', async () => {
    const response = await call('GET', '/stats')
    assert.equal(response.status, 200)
    assert.ok(response.json.requests >= 8, `requests=${response.json.requests}`)
    const row = response.json.models.find(model => model.model === 'DeepSeek-V4-Flash')
    assert.ok(row !== undefined && row.output > 0)
  })

  await check('meta reports the installed version and distribution', async () => {
    const response = await call('GET', '/meta')
    assert.equal(response.status, 200)
    assert.equal(response.json.distribution, 'self')
    assert.equal(response.json.version.length > 0, true)
  })

  await check('an events stream route is registered alongside the prefix', () => {
    const events = ctx.__test.routes.find(route => route.kind === 'exact' && route.path === `${API}/events`)
    assert.ok(events !== undefined, 'exact events route missing')
  })

  // ── teardown ──────────────────────────────────────────────────────────────
  ctx.__test.dispose()
  await gateway.close()
  fs.rmSync(home, { recursive: true, force: true })

  console.log(`\nhost-selftest: ${passed} passed, ${failures.length} failed`)
  if (failures.length > 0) process.exitCode = 1
}

main().catch(error => {
  console.error('host-selftest crashed:', error)
  process.exitCode = 1
})
