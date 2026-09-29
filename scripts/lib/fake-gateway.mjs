/**
 * A local stand-in for the AMD Radeon Token Factory gateway.
 *
 * Every route here mirrors one that was measured against the live service on
 * 2026-09-29, including the two behaviours that are easy to get wrong:
 *
 * - the directory POST answers 403 unless `Origin` **and** `Referer` name the
 *   site (a CSRF check, not a credential);
 * - `/api/v1/*` answers 401 with an **empty body** when the Bearer key is
 *   missing or wrong.
 *
 * Chat requests are steered by the last user message, which lets one server
 * exercise every adapter path without a network:
 *
 *   'ping'   short answer with finish + usage (the probe's own prompt)
 *   'cut'    two text deltas, then the socket ends with no finish frame
 *   'empty'  a finish `stop` that carries no content at all
 *   'tool'   a complete tool call, finish `tool_calls`
 *   'quota'  429 with an error envelope
 *   anything else → echoed back as one text delta
 *
 * Responses always declare `content-type: application/json` even when the body
 * is a perfect SSE stream: that is the header-lying behaviour the reference
 * implementation measured, and keeping it here means the sniff path is what the
 * tests exercise, not the happy header.
 *
 * @module scripts/lib/fake-gateway.mjs
 */

import http from 'node:http'

/** The only key this gateway accepts. */
export const VALID_KEY = 'amdk_test_key_0123456789abcdef'

/** Directory cards, in display order. `chat: false` models refuse the wire. */
export const FLEET = [
  { id: 'MiMo-V2.6-Flash', vision: true, reasoning: true, tools: true, context: 1048576, chat: true },
  { id: 'DeepSeek-V4.1-Flash', vision: true, reasoning: true, tools: true, context: 1048576, chat: true },
  { id: 'DeepSeek-V4-Flash', vision: false, reasoning: true, tools: true, context: 1048576, chat: true },
  { id: 'DeepSeek-V4-Flash-Vision-Exp', vision: true, reasoning: true, tools: true, context: 1048576, chat: true },
  { id: 'GLM-5.3-Flash', vision: false, reasoning: true, tools: true, context: 262144, chat: true },
  { id: 'Qwen3.8-Flash-Next', vision: true, reasoning: true, tools: true, context: 262144, chat: true },
  { id: 'Qwen3.8-27B', vision: true, reasoning: true, tools: true, context: 262144, chat: true },
  { id: 'MiniCPM5-2B', vision: false, reasoning: true, tools: true, context: 131072, chat: true },
  // The document-conversion lane: listed by the directory, but it never answers
  // the chat wire — the probe must land on `unavailable` and drop it.
  { id: 'MinerU2.5-Pro', vision: false, reasoning: false, tools: false, context: 131072, chat: false },
]

/**
 * A paid card that appears in the *free* directory — the worst case the
 * free-only filter exists for. Its detail document declares AMD's `dedicated`
 * section (`Deploy dedicated instances with your own credits`), measured
 * against the real paid endpoint on 2026-09-29. It must never enter the
 * catalog: dropped before the picker, the roster, or the forward port.
 */
export const PAID_MODEL = 'Instanced-Whisper-Large-v3'

/**
 * Start the gateway.
 *
 * @param {object} [options]
 * @param {string} [options.key] - the Bearer key to accept (see VALID_KEY)
 * @param {string} [options.directorySection] - section key the bootstrap
 *   document declares; defaults to the real `public_free`. Tests set it to
 *   `dedicated` to prove the plugin refuses a section it does not own.
 * @returns {Promise<{origin: string, port: number, stats: object, close: () => Promise<void>}>}
 */
export async function startFakeGateway(options = {}) {
  const key = options.key ?? VALID_KEY
  const directorySection = options.directorySection ?? 'public_free'
  const stats = {
    chatBodies: [],
    chatCount: 0,
    modelsCount: 0,
    bootstrapCount: 0,
    bootstrapWithoutSiteHeaders: 0,
    loadCount: 0,
    detailCount: 0,
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname

    if (path === '/radeon/api/tokenfactory/bootstrap') {
      stats.bootstrapCount += 1
      // Measured live: no headers → 403, Content-Type alone → 403, Origin +
      // Referer together → 200.
      if (!req.headers.origin || !req.headers.referer) {
        stats.bootstrapWithoutSiteHeaders += 1
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end('{"detail":"Forbidden"}')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        section: { key: directorySection, title: 'Public Free Model APIs', subtitle: 'Ready-to-use free API endpoints' },
        cards: [...FLEET.map(row => ({
          key: `shared-model_gateway:${row.id}`,
          id: `model_gateway:${row.id}`,
          detail_url: `/radeon/api/tokenfactory/model?id=${encodeURIComponent(`model_gateway:${row.id}`)}`,
        })), {
          key: `shared-model_gateway:${PAID_MODEL}`,
          id: `model_gateway:${PAID_MODEL}`,
          detail_url: `/radeon/api/tokenfactory/model?id=${encodeURIComponent(`model_gateway:${PAID_MODEL}`)}`,
        }],
      }))
      return
    }

    if (path === '/radeon/api/tokenfactory/model') {
      stats.detailCount += 1
      const raw = url.searchParams.get('id') ?? ''
      const id = decodeURIComponent(raw).split(':').pop() ?? ''
      if (id === PAID_MODEL) {
        // Modelled on the real paid-section response (`/api/templates/{id}/tokenfactory`,
        // measured 2026-09-29): `token_factory.section: "dedicated"`, status
        // "deployable", access kind `dedicated_deploy` — deployable against the
        // account's credits, not a free endpoint.
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ model: paidDetailDocument(id) }))
        return
      }
      const row = FLEET.find(candidate => candidate.id === id)
      if (row === undefined) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{"detail":"Not Found"}')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ model: detailDocument(row) }))
      return
    }

    if (path === '/radeon/api/tokenfactory/load') {
      stats.loadCount += 1
      const models = {}
      FLEET.forEach((row, index) => {
        const utilization = [19.9, 66.9, 100, 6.2][index % 4]
        models[row.id] = {
          state: utilization >= 100 ? 'full' : utilization > 60 ? 'busy' : 'idle',
          label: utilization >= 100 ? 'At capacity' : utilization > 60 ? 'Busy' : 'Idle',
          utilization,
        }
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ models, scope: 'fleet' }))
      return
    }

    if (path === '/radeon/api/v1/models') {
      stats.modelsCount += 1
      if (!authorized(req, key)) { res.writeHead(401); res.end(); return }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: FLEET.filter(row => row.chat).map(row => ({ id: row.id, object: 'model' })) }))
      return
    }

    if (path === '/radeon/api/v1/chat/completions') {
      stats.chatCount += 1
      if (!authorized(req, key)) { res.writeHead(401); res.end(); return }
      collectBody(req).then(raw => {
        let body
        try { body = JSON.parse(raw) } catch { body = {} }
        stats.chatBodies.push(body)
        const row = FLEET.find(candidate => candidate.id === body.model)
        if (row === undefined || row.chat !== true) {
          // The gateway naming a model it will not route — what the probe reads
          // as `unavailable`.
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: `no such model: ${body.model}`, type: 'ModelError' } }))
          return
        }
        const last = [...(body.messages ?? [])].reverse().find(message => message.role === 'user')
        const prompt = typeof last?.content === 'string' ? last.content : ''
        if (prompt.includes('quota')) {
          res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' })
          res.end(JSON.stringify({ error: { message: 'rate limit exceeded for this key', type: 'rate_limit_error' } }))
          return
        }
        // Note the lying content-type on every SSE response (see module note).
        res.writeHead(200, { 'content-type': 'application/json' })
        if (prompt.includes('cut')) {
          res.write(sse({ choices: [{ index: 0, delta: { content: 'partial ' } }] }))
          res.write(sse({ choices: [{ index: 0, delta: { content: 'answer' } }] }))
          res.end()
          return
        }
        if (prompt.includes('empty')) {
          res.write(sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
          res.write(sse({ usage: { prompt_tokens: 11, completion_tokens: 0 } }))
          res.end('data: [DONE]\n\n')
          return
        }
        if (prompt.includes('tool')) {
          res.write(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_abc123', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] } }] }))
          res.write(sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }))
          res.write(sse({ usage: { prompt_tokens: 40, completion_tokens: 18 } }))
          res.end('data: [DONE]\n\n')
          return
        }
        const answer = prompt === 'ping' ? 'pong' : `echo: ${prompt.slice(0, 80)}`
        res.write(sse({ choices: [{ index: 0, delta: { content: answer } }] }))
        res.write(sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
        res.write(sse({ usage: { prompt_tokens: 24, completion_tokens: 9 } }))
        res.end('data: [DONE]\n\n')
      })
      return
    }

    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"detail":"Not Found"}')
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    stats,
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
}

function authorized(req, key) {
  const header = String(req.headers.authorization ?? '')
  return header === `Bearer ${key}`
}

function sse(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function detailDocument(row) {
  return {
    id: `model_gateway:${row.id}`,
    source: 'model_gateway',
    label: row.id,
    model: row.id,
    description: `${row.id} served by the AMD GPU Cloud`,
    family: 'custom',
    providers: ['Radeon Cloud'],
    pricing: { prompt: '1.4e-7', completion: '2.8e-7' },
    display_config: { name: row.id, publisher: 'AMD', badge_label: 'Free', tags: ['API', 'OpenAI compatible'] },
    provider_pricing: [{
      providerId: 'self-dploy',
      externalId: row.id,
      streaming: true,
      vision: row.vision,
      tools: row.tools,
      reasoning: row.reasoning,
      stability: 'experimental',
    }],
    context_length: row.context,
    supported_parameters: row.tools ? ['temperature', 'max_tokens', 'top_p', 'stream', 'response_format', 'tools', 'tool_choice'] : ['temperature', 'max_tokens', 'stream'],
    enabled: true,
    display_status: 'free_endpoint',
    status: 'online',
    token_factory: {
      section: 'public_free',
      source: 'model_gateway',
      badge: { label: 'Free', tone: 'free' },
      capability: { key: row.vision ? 'vlm' : 'text', label: row.vision ? 'VLM (Vision)' : 'LLM (Text)' },
      status: { key: 'free_endpoint', label: 'Free' },
      tags: ['API', 'OpenAI compatible'],
      access: { base_url: { label: 'Base URL', value: 'https://developer.amd.com.cn/radeon/api/v1', copyable: true } },
    },
  }
}

/**
 * The paid section's detail document, mirroring the real dedicated response:
 * `section: "dedicated"`, `status.key: "deployable"`, `access.kind:
 * "dedicated_deploy"`, no `display_status` and no `badge` — every field the
 * free-only filter reads says "this one bills".
 */
function paidDetailDocument(id) {
  return {
    id: `template:${id}`,
    source: 'template',
    label: id,
    model: id,
    description: `${id} — deploy a dedicated instance with your credits`,
    family: 'custom',
    providers: ['Radeon Cloud'],
    context_length: 131072,
    supported_parameters: ['temperature', 'max_tokens', 'stream'],
    enabled: true,
    token_factory: {
      section: 'dedicated',
      source: 'template',
      badge: null,
      capability: { key: 'text', label: 'LLM (Text)' },
      status: { key: 'deployable', label: 'Deployable instance (uses Credits)' },
      access: {
        kind: 'dedicated_deploy',
        base_url: { label: 'Base URL', value: null, empty_label: 'Available in Profile after deployment' },
        api_key: { label: 'API Key', value: null, empty_label: 'Available in Profile after deployment' },
      },
    },
  }
}

function collectBody(req) {
  return new Promise(resolve => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}
