/**
 * Upstream wire for the AMD Radeon Token Factory lane.
 *
 * Every fact in this file was verified by direct request against the live
 * gateway on 2026-09-29:
 *
 * - `GET  /radeon/api/tokenfactory/load`          — fleet load per model, no auth
 * - `POST /radeon/api/tokenfactory/bootstrap?...` — model directory cards; the
 *   POST is refused with 403 unless `Origin` and `Referer` both name the site
 *   (a CSRF check, not a credential), and answers without a key.
 * - `GET  /radeon/api/tokenfactory/model?id=…`    — full capability document per
 *   model: context length, vision/tools/reasoning flags, supported parameters,
 *   display metadata, status. No auth.
 * - `GET  /radeon/api/v1/models`                  — OpenAI list; requires
 *   `Authorization: Bearer <key>` (401 with an empty body without one).
 * - `POST /radeon/api/v1/chat/completions`        — OpenAI chat wire, same auth.
 * - `POST /radeon/api/v1/messages`                — Anthropic wire, `x-api-key`.
 *
 * This plugin speaks the OpenAI chat wire only: every directory entry declares
 * `OpenAI compatible`, so one wire covers the fleet. The Anthropic endpoint
 * stays reachable through the forward listener, which owns its own auth.
 *
 * @module src/upstream.js
 */

/**
 * Overridable so the offline suites can point the adapter at a dead port and
 * exercise the transport-failure path without touching the real lane.
 */
export const AMD_ORIGIN = process.env.AMD_FREE_MODEL_ORIGIN ?? 'https://developer.amd.com.cn'

/** Base path of the Radeon application on the origin. */
export const APP_BASE = '/radeon'

/** The OpenAI-compatible API base every model request in this plugin targets. */
export const API_BASE = `${AMD_ORIGIN}${APP_BASE}/api/v1`

/** Discovery endpoints (directory / detail / load) live beside it. */
export const DISCOVERY_BASE = `${AMD_ORIGIN}${APP_BASE}/api/tokenfactory`

/** Where a user obtains a key: sign in, then the profile page issues one. */
export const KEY_URL = `${AMD_ORIGIN}${APP_BASE}/profile`

/** Anthropic wire version header, used by the forward listener's /messages. */
export const ANTHROPIC_API_VERSION = '2023-06-01'

const MAX_TOOL_NAME_LEN = 128

/**
 * The headers every discovery request carries.
 *
 * The directory POST answers 403 unless both headers name the site: measured
 * live, no headers → 403, `Content-Type` alone → 403, `Origin` + `Referer`
 * together → 200. The detail GET tolerates their absence but sends them anyway
 * so one code path serves all three endpoints.
 */
export function siteHeaders() {
  return {
    'origin': AMD_ORIGIN,
    'referer': `${AMD_ORIGIN}${APP_BASE}/tokenfactory`,
    'accept': 'application/json',
  }
}

/**
 * The headers an API request carries. The attribution User-Agent is merged in
 * by `http.js`; this owns what the gateway keys on: credential, content type,
 * accept.
 *
 * @param {string} apiKey - the user's Token Factory key, when one is configured
 * @param {object} [options]
 * @param {boolean} [options.stream] - ask for an SSE accept header
 * @returns {Record<string, string>}
 */
export function apiHeaders(apiKey, { stream } = {}) {
  const headers = {
    'content-type': 'application/json',
    'accept': stream === true ? 'text/event-stream' : '*/*',
  }
  if (typeof apiKey === 'string' && apiKey !== '') headers['authorization'] = `Bearer ${apiKey}`
  return headers
}

/** Strip a trailing "(level)" thinking suffix so lookups hit the base id. */
export function baseModelId(model) {
  return String(model ?? '').replace(/\([^()]+\)\s*$/, '').trim()
}

/**
 * The wire shape one endpoint speaks. Only `chat` exists on this lane; the
 * Anthropic endpoint is a parallel public surface, not a second dialect.
 */
export function wireFor() {
  return 'chat'
}

/** Which upstream path serves this model. Always the OpenAI chat wire here. */
export function endpointFor() {
  return `${API_BASE}/chat/completions`
}

/** The directory detail URL for one `model_gateway:` id. */
export function modelDetailUrl(id) {
  return `${DISCOVERY_BASE}/model?id=${encodeURIComponent(String(id))}`
}

/** The fleet-load URL. */
export function loadUrl() {
  return `${DISCOVERY_BASE}/load`
}

/** The model-directory URL, with the optional source parameter. */
export function bootstrapUrl(source = '') {
  return `${DISCOVERY_BASE}/bootstrap?directory=true${source ? `&source=${encodeURIComponent(source)}` : ''}`
}

/** The OpenAI listing URL. */
export function modelsUrl() {
  return `${API_BASE}/models`
}

function toolNameOf(tool) {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return ''
  if (typeof tool.name === 'string' && tool.name.trim()) return tool.name.trim()
  const fn = tool.function
  if (fn && typeof fn === 'object' && !Array.isArray(fn) && typeof fn.name === 'string') return fn.name.trim()
  return ''
}

function functionOf(tool) {
  return tool && tool.function && typeof tool.function === 'object' && !Array.isArray(tool.function) ? tool.function : null
}

/**
 * Canonicalize a tool list for the chat wire: unique names, function wrapper.
 * Returns the rename map for contract parity with the reference implementation;
 * on this lane nothing is ever renamed, so it comes back empty.
 *
 * @param {object[]} tools
 * @returns {{tools: object[], rename: Map<string, string>}}
 */
export function shapeChatTools(tools) {
  const rename = new Map()
  const seen = new Set()
  const out = []
  for (const tool of tools ?? []) {
    const name = toolNameOf(tool)
    if (name === '' || seen.has(name)) continue
    seen.add(name)
    const fn = functionOf(tool)
    out.push(fn
      ? tool
      : { type: 'function', function: { name, description: tool?.description ?? '', parameters: tool?.parameters ?? { type: 'object', properties: {} } } })
  }
  return { tools: out, rename }
}

/** Restore a caller tool spelling through the rename map (identity on this lane). */
export function restoreToolName(name, map) {
  if (!map || map.size === 0) return name
  return map.get(name) ?? name
}

export { toolNameOf, MAX_TOOL_NAME_LEN }
