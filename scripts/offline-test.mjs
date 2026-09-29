/**
 * Offline unit suite — no network, no gateway, no keys.
 *
 * Covers the pure logic the host selftest exercises only through the wire:
 * catalog projection and the free-only filter, message projection and
 * tool-pairing repair, SSE decoding, effort budgets, probe verdict
 * classification, the settings sanitizers, and the trust fence's structural
 * layer.
 *
 * @module scripts/offline-test.mjs
 */

import assert from 'node:assert/strict'
import { buildCatalog, parseDirectory, parseLoad, parseDetailCaps, displayModelName, capabilitiesFor, isFreeDetail, assertFreeSection, directorySection, FREE_SECTION } from '../src/catalog.js'
import { toChatMessages, repairToolPairing, toToolDefs } from '../src/messages.js'
import { readStream, finishReason, mapUsage } from '../src/stream.js'
import { budgetFor, resolveLevel, LEVELS, DEFAULT_LEVEL } from '../src/effort.js'
import { sniffBody, classifyFailure, CODE } from '../src/http.js'
import { siteHeaders, apiHeaders, baseModelId, wireFor, endpointFor, shapeChatTools } from '../src/upstream.js'
import { STATE, isSaturated } from '../src/probe.js'
import { rejectionFor, structuralRejection, isLoopbackHost } from '../src/trust.js'

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
  // ── upstream headers ──────────────────────────────────────────────────────
  await check('discovery headers name both the origin and the referer', () => {
    const headers = siteHeaders()
    assert.ok(headers.origin.startsWith('https://'))
    assert.ok(headers.referer.endsWith('/tokenfactory'))
  })

  await check('api headers carry the Bearer key only when one exists', () => {
    assert.equal(apiHeaders('').authorization, undefined)
    assert.equal(apiHeaders('k1').authorization, 'Bearer k1')
    assert.equal(apiHeaders('k1', { stream: true }).accept, 'text/event-stream')
  })

  await check('the lane speaks one wire: chat, at the OpenAI path', () => {
    assert.equal(wireFor('anything'), 'chat')
    assert.ok(endpointFor().endsWith('/chat/completions'))
    assert.ok(endpointFor().startsWith('https://'))
  })

  await check('baseModelId strips an effort suffix, not a real name', () => {
    assert.equal(baseModelId('DeepSeek-V4-Flash (deep)'), 'DeepSeek-V4-Flash')
    assert.equal(baseModelId('MiniCPM5-2B'), 'MiniCPM5-2B')
    assert.equal(baseModelId('GLM-5.3-Flash (balanced) extra'), 'GLM-5.3-Flash (balanced) extra')
  })

  // ── catalog ───────────────────────────────────────────────────────────────
  await check('the directory parser extracts card ids in order', () => {
    const cards = parseDirectory({ cards: [{ id: 'model_gateway:A' }, { id: 'model_gateway:B' }, {}] })
    assert.deepEqual(cards, ['model_gateway:A', 'model_gateway:B'])
  })

  await check('buildCatalog merges detail over the baseline without dropping rows', () => {
    const details = {
      A: { provider_pricing: [{ vision: true, reasoning: true, tools: true }], context_length: 262144, display_status: 'free_endpoint', enabled: true, supported_parameters: ['stream'] },
      // B has no detail at all — its baseline row must still ship.
    }
    const catalog = buildCatalog(['A', 'B'], details)
    assert.equal(catalog.length, 2)
    assert.equal(catalog[0].vision, true)
    assert.equal(catalog[0].contextWindow, 262144)
    assert.equal(catalog[0].status, 'free_endpoint')
    assert.deepEqual(catalog[0].supports, ['stream'])
    assert.equal(catalog[1].vision, false)
    assert.equal(catalog[1].contextWindow, 131072, 'unknown rows fall back to the baseline')
  })

  await check('parseDetailCaps reads the model object directly', () => {
    const caps = parseDetailCaps({ provider_pricing: [{ vision: false, reasoning: false, tools: false }], context_length: 0 })
    assert.equal(caps.vision, false)
    assert.equal(caps.contextWindow, undefined, 'zero is not a context window')
    assert.equal(parseDetailCaps(undefined), undefined)
  })

  await check('parseLoad normalizes the fleet document', () => {
    const load = parseLoad({ models: { A: { state: 'idle', label: 'Idle', utilization: 19.9 }, B: 'junk' }, scope: 'fleet' })
    assert.equal(load.A.state, 'idle')
    assert.equal(load.A.utilization, 19.9)
    assert.equal(load.B, undefined)
    assert.deepEqual(parseLoad(null), {})
  })

  await check('display names are human, ids stay raw', () => {
    assert.equal(displayModelName('Qwen3.8-27B'), 'Qwen3.8 27B')
    assert.equal(displayModelName('DeepSeek-V4-Flash'), 'DeepSeek V4 Flash')
    assert.equal(capabilitiesFor('Unknown-Model').contextWindow, 131072)
  })

  // ── free-only filter ──────────────────────────────────────────────────────
  await check('the free section is the only accepted directory section', () => {
    assert.equal(FREE_SECTION, 'public_free')
    assert.equal(directorySection({ section: { key: 'public_free' } }), 'public_free')
    assert.equal(directorySection({ section: { key: 'dedicated' } }), 'dedicated')
    assert.equal(directorySection({}), undefined)
    // A recognised free section passes; a paid or unknown one throws before a
    // single card is read.
    assert.equal(assertFreeSection({ section: { key: 'public_free' } }), 'public_free')
    assert.equal(assertFreeSection({}), undefined)
    assert.throws(() => assertFreeSection({ section: { key: 'dedicated' } }), /dedicated/)
    assert.throws(() => assertFreeSection({ section: { key: 'mystery' } }), /mystery/)
  })

  await check('isFreeDetail reads the section discriminator first', () => {
    // The measured free document: section public_free wins outright.
    assert.equal(isFreeDetail({ token_factory: { section: 'public_free' }, display_status: 'anything' }), true)
    // The measured paid document: dedicated fails even when a free-ish status
    // dangles elsewhere; dedicated_deploy access fails on its own.
    assert.equal(isFreeDetail({ token_factory: { section: 'dedicated' } }), false)
    assert.equal(isFreeDetail({ token_factory: { access: { kind: 'dedicated_deploy' } } }), false)
    // No section: the measured display_status whitelist decides.
    assert.equal(isFreeDetail({ display_status: 'free_endpoint' }), true)
    assert.equal(isFreeDetail({ display_status: 'limited_free' }), true)
    assert.equal(isFreeDetail({ display_status: 'paid' }), false)
    // A document that declares nothing is unknown, and unknown is not free.
    assert.equal(isFreeDetail({}), false)
    assert.equal(isFreeDetail(undefined), false)
  })

  await check('buildCatalog drops paid cards and reports them', () => {
    const excluded = []
    const catalog = buildCatalog(
      ['Free-One', 'Paid-One', 'Free-Two'],
      {
        'Free-One': { token_factory: { section: 'public_free' }, context_length: 1048576 },
        'Paid-One': { token_factory: { section: 'dedicated' }, context_length: 131072 },
        'Free-Two': { token_factory: { section: 'public_free' }, context_length: 262144 },
      },
      excluded,
    )
    assert.deepEqual(catalog.map(entry => entry.id), ['Free-One', 'Free-Two'])
    assert.deepEqual(excluded, ['Paid-One'])
    // No detail (a failed fetch) keeps the curated baseline row: transient
    // errors degrade capabilities, never the free-only promise.
    const kept = buildCatalog(['No-Detail-Model'], {})
    assert.equal(kept.length, 1)
    assert.equal(kept[0].id, 'No-Detail-Model')
  })

  // ── messages ──────────────────────────────────────────────────────────────
  const chat = messages => toChatMessages(messages, undefined, [])

  await check('system, user and assistant text project onto the chat wire', () => {
    const out = chat([
      { role: 'system', content: [{ type: 'text', text: 'be brief' }] },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }], source: { kind: 'model' } },
    ])
    assert.deepEqual(out.map(row => row.role), ['system', 'user', 'assistant'])
    assert.equal(out[0].content, 'be brief')
  })

  await check('V4 tool messages become first-class tool rows keyed by call id', () => {
    const out = chat([
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }], source: { kind: 'model' } },
      { role: 'tool', content: [{ type: 'text', text: 'file contents' }], toolCallId: 'c1', source: { kind: 'tool', callId: 'c1' } },
    ])
    assert.equal(out.length, 2)
    assert.equal(out[1].role, 'tool')
    assert.equal(out[1].tool_call_id, 'c1')
    assert.equal(out[1].content, 'file contents')
  })

  await check('repair drops an unanswered call and an orphan answer', () => {
    const repaired = repairToolPairing([
      // A call with no answer — the interruption case.
      { role: 'assistant', content: [{ type: 'tool-call', id: 'dead', name: 'read', arguments: '{}' }], source: { kind: 'model' } },
      // An answer with no call (its call was removed).
      { role: 'tool', content: [{ type: 'text', text: 'orphan' }], toolCallId: 'ghost', source: { kind: 'tool', callId: 'ghost' } },
      { role: 'user', content: [{ type: 'text', text: 'still here' }] },
    ])
    assert.deepEqual(repaired.map(row => row.role), ['user'])
  })

  await check('repair keeps a complete call/answer pair untouched', () => {
    const pair = [
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }], source: { kind: 'model' } },
      { role: 'tool', content: [{ type: 'text', text: 'ok' }], toolCallId: 'c1', source: { kind: 'tool', callId: 'c1' } },
    ]
    const repaired = repairToolPairing(pair)
    // A fresh array of the *same message objects*: nothing was rewritten, so a
    // byte-identical history never gets re-encoded on the way out.
    assert.equal(repaired.length, 2)
    assert.equal(repaired[0], pair[0])
    assert.equal(repaired[1], pair[1])
  })

  await check('tool schemas project to the chat wrapper with unique names', () => {
    const { tools, rename } = shapeChatTools([
      { name: 'read', description: 'd', parameters: { type: 'object', properties: {} } },
      { name: 'read', description: 'dup', parameters: {} },
      { function: { name: 'write', description: 'w', parameters: {} } },
    ])
    assert.equal(tools.length, 2)
    assert.equal(tools[0].type, 'function')
    assert.equal(tools[0].function.name, 'read')
    assert.equal(tools[1].function.name, 'write')
    assert.equal(rename.size, 0, 'nothing renames on this lane')

    const defs = toToolDefs([{ name: 'read', description: 'd', parameters: {} }], 'chat')
    assert.equal(defs[0].function.name, 'read')
  })

  // ── stream decoding ───────────────────────────────────────────────────────
  await check('usage mapping subtracts cache hits from input tokens', () => {
    const mapped = mapUsage({ prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 }, completion_tokens_details: { reasoning_tokens: 7 } })
    assert.equal(mapped.inputTokens, 40)
    assert.equal(mapped.outputTokens, 20)
    assert.equal(mapped.cacheReadTokens, 60)
    assert.equal(mapped.reasoningTokens, 7)
    assert.equal(mapped.totalTokens, 120)
    // An absent details block must not produce NaN — the durable log rejects it.
    const bare = mapUsage({ prompt_tokens: 5, completion_tokens: 5 })
    assert.equal(bare.inputTokens, 5)
    assert.ok(Number.isFinite(bare.inputTokens))
    assert.equal(mapUsage(undefined), undefined)
  })

  await check('finish tokens map onto the harness vocabulary', () => {
    assert.deepEqual(finishReason('tool_calls'), { kind: 'tool-calls' })
    assert.deepEqual(finishReason('length'), { kind: 'max-tokens' })
    assert.deepEqual(finishReason('stop'), { kind: 'stop' })
    assert.deepEqual(finishReason(undefined), { kind: 'stop' })
  })

  await check('a streamed answer assembles text blocks and reports the finish', async () => {
    const result = await readChunks([
      { choices: [{ index: 0, delta: { content: 'Hel' } }] },
      { choices: [{ index: 0, delta: { content: 'lo' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { usage: { prompt_tokens: 10, completion_tokens: 3 } },
    ])
    assert.equal(result.text, 'Hello')
    assert.equal(result.sawFinish, true)
    assert.equal(result.finish, 'stop')
    assert.equal(result.usage.outputTokens, 3)
  })

  await check('tool-call deltas assemble into one parsed block', async () => {
    const result = await readChunks([
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'f', arguments: '{"a"' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ])
    assert.equal(result.toolCalls.length, 1)
    assert.equal(JSON.parse(result.toolCalls[0].arguments).a, 1)
    assert.equal(result.finish, 'tool_calls')
  })

  await check('a broken tool-call argument marks the turn truncated', async () => {
    const result = await readChunks([
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'f', arguments: '{"a":' } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ])
    assert.equal(result.brokenToolCall, true)
  })

  await check('an in-stream error envelope throws a classified failure', async () => {
    await assert.rejects(
      () => readChunks([{ type: 'error', error: { message: 'rate limit', type: 'rate_limit_error' } }]),
      error => error.code === CODE.quota,
    )
  })

  await check('a stream without a finish frame reports sawFinish=false', async () => {
    const result = await readChunks([{ choices: [{ index: 0, delta: { content: 'partial' } }] }])
    assert.equal(result.sawFinish, false)
    assert.equal(result.firstDeltaAt !== undefined, true)
  })

  // ── effort budgets ────────────────────────────────────────────────────────
  await check('the ladder is enforced as token ceilings', () => {
    const model = { reasoning: true, canDisableThinking: true, maxOutput: 65536 }
    assert.equal(budgetFor('light', model, undefined, 32768), 2048)
    assert.equal(budgetFor('balanced', model, undefined, 32768), 8192)
    assert.equal(budgetFor('deep', model, undefined, 32768), 32768)
    // A caller ceiling only ever lowers.
    assert.equal(budgetFor('deep', model, 4096, 32768), 4096)
    // Thinking-always-on doubles the low rungs.
    const always = { ...model, canDisableThinking: false }
    assert.equal(budgetFor('light', always, undefined, 32768), 4096)
    // A cleared settings input is "no ceiling", not zero.
    assert.equal(budgetFor('deep', model, undefined, 0), 65536)
    // A model with no effort menu keeps its whole window.
    const noMenu = { reasoning: false, maxOutput: 16384 }
    assert.equal(budgetFor('light', noMenu, undefined, 32768), 16384)
    assert.equal(resolveLevel('light', noMenu), undefined)
    assert.equal(resolveLevel('nonsense', model).id, DEFAULT_LEVEL)
    assert.equal(LEVELS.length, 3)
  })

  // ── failure classification ────────────────────────────────────────────────
  await check('status codes classify into the harness vocabulary', () => {
    assert.equal(classifyFailure(401, {}).code, CODE.credential)
    assert.equal(classifyFailure(403, {}).code, CODE.credential)
    assert.equal(classifyFailure(429, {}).code, CODE.quota)
    assert.equal(classifyFailure(500, { error: { message: 'oops' } }).code, CODE.server)
    const named = classifyFailure(400, { error: { message: 'no such model', type: 'ModelError' } })
    assert.equal(named.unavailable, true)
    // The reason phrase of a reverse proxy must not name the model.
    const busy = classifyFailure(503, { error: { message: 'Service Unavailable' } })
    assert.equal(busy.unavailable, undefined)
  })

  await check('the body shape decides, not the content type', () => {
    assert.equal(sniffBody('data: {"a":1}\n\n'), 'sse')
    assert.equal(sniffBody(': comment\ndata: x'), 'sse')
    assert.equal(sniffBody('{"choices":[]}'), 'json')
    assert.equal(sniffBody('[1,2]'), 'json')
    assert.equal(sniffBody(''), 'empty')
    assert.equal(sniffBody('<html>'), 'unknown')
  })

  // ── probe verdicts ────────────────────────────────────────────────────────
  await check('the probe state vocabulary has no region verdict', () => {
    assert.deepEqual(
      Object.values(STATE).sort(),
      ['available', 'busy', 'no-key', 'throttled', 'unknown', 'unavailable'].sort(),
    )
    assert.equal(STATE.regionBlocked, undefined)
  })

  await check('a saturated pool is told apart from an exhausted key', () => {
    // AMD's own load endpoint publishes `state: 'full'` at 100%. A 429 arriving
    // while that reads saturated is capacity, not the caller's quota — and the
    // badge has to say so, because the two clear by opposite means: one on its
    // own in minutes, the other not at all until the quota resets.
    assert.equal(isSaturated({ state: 'full', utilization: 100 }), true)
    assert.equal(isSaturated({ state: 'busy', utilization: 99.9 }), true, '99%+ is full in everything but the label')
    assert.equal(isSaturated({ state: 'busy', utilization: 72.4 }), false)
    assert.equal(isSaturated({ state: 'idle', utilization: 4 }), false)
    // No reading is not evidence of saturation: absence keeps the conservative
    // reading, because asserting capacity from no data is the same mistake.
    assert.equal(isSaturated(undefined), false)
    assert.equal(isSaturated(null), false)
    assert.equal(isSaturated({}), false)
  })

  // ── trust fence ───────────────────────────────────────────────────────────
  await check('loopback hosts are the only bindable addresses', () => {
    assert.equal(isLoopbackHost('127.0.0.1'), true)
    assert.equal(isLoopbackHost('localhost'), true)
    assert.equal(isLoopbackHost('0.0.0.0'), false)
    assert.equal(isLoopbackHost('192.168.1.5'), false)
  })

  const req = headers => ({ headers: { host: '127.0.0.1:3099', ...headers } })
  await check('the structural fence admits a same-origin loopback request', () => {
    assert.equal(structuralRejection(req({ origin: 'http://127.0.0.1:3099' })), undefined)
    assert.equal(structuralRejection(req({})), undefined)
  })
  await check('the structural fence refuses rebinding, cross-site and foreign origins', () => {
    assert.equal(structuralRejection(req({ host: 'evil.example' })), 403)
    assert.equal(structuralRejection(req({ 'sec-fetch-site': 'cross-site' })), 403)
    assert.equal(structuralRejection(req({ origin: 'https://evil.example' })), 403)
    assert.equal(structuralRejection(req({ host: '' })), 403, 'a missing Host fails closed')
  })
  await check('a connection service outranks the replica, and a throwing one falls back', () => {
    assert.equal(rejectionFor(req({}), { admit: () => ({ rejection: 401 }) }), 401)
    assert.equal(rejectionFor(req({}), { admit: () => undefined }), undefined)
    assert.equal(rejectionFor(req({ origin: 'https://evil.example' }), { admit: () => { throw new Error('bug') } }), 403)
  })

  console.log(`\noffline-test: ${passed} passed, ${failures.length} failed`)
  if (failures.length > 0) process.exitCode = 1
}

/** Run readStream over JSON payloads and collect the assembled view. */
async function readChunks(payloads) {
  async function* lines() { for (const payload of payloads) yield JSON.stringify(payload) }
  const state = { text: '', toolCalls: [], chunks: [] }
  const iterator = readStream(lines(), 'chat', new Map())
  while (true) {
    const { value, done } = await iterator.next()
    if (done) {
      // The generator's return value is the summary object.
      state.summary = value
      break
    }
    state.chunks.push(value)
    if (value.type === 'text-delta') state.text += value.text
    if (value.type === 'block-end' && value.block?.type === 'tool-call') state.toolCalls.push(value.block)
  }
  return { ...state, ...(state.summary ?? {}) }
}

main().catch(error => {
  console.error('offline-test crashed:', error)
  process.exitCode = 1
})
