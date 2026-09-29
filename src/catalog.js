/**
 * Model catalog for the AMD Radeon Token Factory lane.
 *
 * Four sources, deliberately layered so no single one can break the plugin:
 *
 * 1. the free directory (`POST /api/tokenfactory/bootstrap?directory=true`,
 *    section key `public_free`) —the only section this plugin ever reads.
 *    AMD publishes a second, paid section (`dedicated`, served from
 *    `/api/templates`) whose cards deploy billable instances; it is never
 *    fetched, and as defense in depth {@link isFreeDetail} also drops any
 *    dedicated card that appears in the free directory anyway;
 * 2. the directory detail documents (`/api/tokenfactory/model?id=—) —the
 *    authoritative capability set: context length, vision/tools/reasoning flags
 *    and supported parameters, published per model without a key;
 * 3. the OpenAI listing (`/api/v1/models`) —what the key may actually route,
 *    fetched only when a key is configured;
 * 4. a vetted local baseline —so a cold start with no network, or a discovery
 *    endpoint that moved, still lists the fleet with honest capacities.
 *
 * The baseline below was read from the live free-section detail documents on
 * 2026-09-29.
 *
 * @module src/catalog.js
 */

import { baseModelId } from './upstream.js'

/**
 * The one directory section this plugin treats as its input: "Public Free Model
 * APIs" (measured 2026-09-29). Anything else —notably `dedicated`, AMD's
 * pay-with-credits instance section —is refused rather than filtered, because
 * a section whose meaning we do not know may hide billing behind an id.
 */
export const FREE_SECTION = 'public_free'

/**
 * Local capability baseline for the nine directory entries.
 *
 * `contextWindow` comes from `context_length`; `vision`/`tools`/`reasoning`
 * from `provider_pricing[0]`; `maxOutput` is *not* published by the gateway, so
 * it is a conservative per-model capacity and the session's own output ceiling
 * (settings `defaultMaxTokens`) is what actually bounds a turn.
 *
 * `canDisableThinking` is only `false` where the same model was measured unable
 * to switch thinking off on a sibling lane (MiMo V2.6); for the rest it is
 * assumed true and the effort ladder stays undoubled until a probe says
 * otherwise.
 */
export const CAPABILITIES = [
  { id: 'MiMo-V2.6-Flash', vision: true, reasoning: true, tools: true, contextWindow: 1048576, maxOutput: 65536, canDisableThinking: false },
  { id: 'DeepSeek-V4.1-Flash', vision: true, reasoning: true, tools: true, contextWindow: 1048576, maxOutput: 65536, canDisableThinking: true },
  { id: 'DeepSeek-V4-Flash', vision: false, reasoning: true, tools: true, contextWindow: 1048576, maxOutput: 65536, canDisableThinking: true },
  { id: 'DeepSeek-V4-Flash-Vision-Exp', vision: true, reasoning: true, tools: true, contextWindow: 1048576, maxOutput: 65536, canDisableThinking: true },
  { id: 'GLM-5.3-Flash', vision: false, reasoning: true, tools: true, contextWindow: 262144, maxOutput: 32768, canDisableThinking: true },
  { id: 'Qwen3.8-Flash-Next', vision: true, reasoning: true, tools: true, contextWindow: 262144, maxOutput: 32768, canDisableThinking: true },
  { id: 'Qwen3.8-27B', vision: true, reasoning: true, tools: true, contextWindow: 262144, maxOutput: 32768, canDisableThinking: true },
  { id: 'MiniCPM5-2B', vision: false, reasoning: true, tools: true, contextWindow: 131072, maxOutput: 16384, canDisableThinking: true },
  // Document-conversion lane: listed by the directory, but the detail document
  // declares no streaming and no tool support, and its status is `limited_free`.
  // The probe decides whether it routes; the baseline records what it declared.
  { id: 'MinerU2.5-Pro', vision: false, reasoning: false, tools: false, contextWindow: 131072, maxOutput: 16384, canDisableThinking: true },
]

/** Human-facing display names, so a raw id never reaches the picker. */
const DISPLAY_NAMES = {
  'MiMo-V2.6-Flash': 'MiMo V2.6 Flash',
  'DeepSeek-V4.1-Flash': 'DeepSeek V4.1 Flash',
  'DeepSeek-V4-Flash': 'DeepSeek V4 Flash',
  'DeepSeek-V4-Flash-Vision-Exp': 'DeepSeek V4 Flash Vision',
  'GLM-5.3-Flash': 'GLM 5.3 Flash',
  'Qwen3.8-Flash-Next': 'Qwen3.8 Flash Next',
  'Qwen3.8-27B': 'Qwen3.8 27B',
  'MiniCPM5-2B': 'MiniCPM 5 2B',
  'MinerU2.5-Pro': 'MinerU 2.5 Pro',
}

/** Look up the baseline capabilities for one model id. */
export function capabilitiesFor(modelId) {
  const base = baseModelId(modelId)
  const known = CAPABILITIES.find(entry => entry.id === base)
  if (known !== undefined) return known
  return { id: base, vision: false, reasoning: true, tools: true, contextWindow: 131072, maxOutput: 32768, canDisableThinking: true }
}

/** Title-case a bare id into something a picker can show. */
export function displayModelName(modelId) {
  const base = baseModelId(modelId)
  const known = DISPLAY_NAMES[base]
  if (known !== undefined) return known
  return base
    .replace(/[-_.]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map(word => (/^\d/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ')
}

/**
 * Build catalog entries from a list of raw ids, layered over the baseline.
 *
 * Free-only enforcement runs here: when a detail document exists for an id and
 * says the model belongs to the paid section, the entry is dropped entirely — * it never reaches the picker, the roster, or the forward port. An id whose
 * detail fetch *failed* keeps its curated baseline row (the baseline contains
 * free models only), so a transient network error degrades capabilities, not
 * the free-only promise.
 *
 * @param {string[]} ids - raw model ids (the directory's `model` field)
 * @param {object} [details] - detail documents keyed by id, when discovery ran
 * @param {string[]} [excluded] - optional sink collecting paid ids that were dropped
 * @returns {Array<object>} catalog entries in listing order
 */
export function buildCatalog(ids, details = {}, excluded = undefined) {
  const seen = new Set()
  const entries = []
  for (const raw of ids ?? []) {
    const id = String(raw ?? '').trim()
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    const detail = details[id]
    if (detail !== undefined && !isFreeDetail(detail)) {
      excluded?.push(id)
      continue
    }
    const caps = capabilitiesFor(id)
    const fromDetail = parseDetailCaps(detail)
    const merged = { ...caps, ...fromDetail, id }
    entries.push({
      id,
      name: displayModelName(id),
      wire: 'chat',
      vision: merged.vision === true,
      reasoning: merged.reasoning === true,
      tools: merged.tools !== false,
      contextWindow: positive(merged.contextWindow) ?? caps.contextWindow,
      maxOutput: positive(merged.maxOutput) ?? caps.maxOutput,
      canDisableThinking: merged.canDisableThinking !== false,
      status: typeof detail?.display_status === 'string' ? detail.display_status : '',
      enabled: detail?.enabled !== false,
      tags: Array.isArray(detail?.token_factory?.tags) ? detail.token_factory.tags : [],
      supports: Array.isArray(detail?.supported_parameters) ? detail.supported_parameters : undefined,
    })
  }
  return entries
}

/**
 * Extract the capability fields the adapter cares about from one directory
 * detail document's `model` object (the caller passes `payload.model`), or
 * `undefined` for a non-document.
 */
export function parseDetailCaps(model) {
  if (!model || typeof model !== 'object') return undefined
  const pricing = Array.isArray(model.provider_pricing) ? model.provider_pricing[0] : undefined
  return {
    vision: pricing?.vision === true,
    reasoning: pricing?.reasoning === true,
    tools: pricing?.tools === true,
    contextWindow: positive(model.context_length),
    status: typeof model.display_status === 'string' ? model.display_status : undefined,
    enabled: typeof model.enabled === 'boolean' ? model.enabled : undefined,
  }
}

/**
 * Parse the OpenAI `{"data":[{"id":—]}` listing.
 *
 * @param {object} payload
 * @returns {string[]} ids
 */
export function parseListing(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : Array.isArray(payload) ? payload : []
  return rows.map(row => (typeof row === 'string' ? row : row?.id)).filter(id => typeof id === 'string' && id !== '')
}

/**
 * Parse the fleet-load document (`/api/tokenfactory/load`).
 *
 * @param {object} payload - `{models: {id: {state, label, utilization}}, scope}`
 * @returns {Record<string, {state: string, label: string, utilization: number}>}
 */
export function parseLoad(payload) {
  const out = {}
  const models = payload?.models
  if (!models || typeof models !== 'object') return out
  for (const [id, row] of Object.entries(models)) {
    if (!row || typeof row !== 'object') continue
    out[id] = {
      state: typeof row.state === 'string' ? row.state : 'unknown',
      label: typeof row.label === 'string' ? row.label : '',
      utilization: typeof row.utilization === 'number' && Number.isFinite(row.utilization) ? row.utilization : 0,
    }
  }
  return out
}

/**
 * Parse the model-directory bootstrap document into its detail ids.
 *
 * @param {object} payload - `{section, cards: [{id: "model_gateway:—}]}`
 * @returns {string[]} raw directory ids in card order
 */
export function parseDirectory(payload) {
  const cards = Array.isArray(payload?.cards) ? payload.cards : []
  return cards
    .map(card => String(card?.id ?? ''))
    .filter(id => id !== '')
}

/**
 * The section key a directory document declares (`public_free`, `dedicated`,
 * —, or `undefined` when it declares none. The caller refuses any section it
 * does not recognise before reading a single card.
 *
 * @param {object} payload
 * @returns {string|undefined}
 */
export function directorySection(payload) {
  const section = payload?.section ?? payload?.token_factory_section
  if (section === null || typeof section !== 'object') return undefined
  return typeof section.key === 'string' && section.key !== '' ? section.key : undefined
}

/**
 * Refuse a directory document that is not the free section.
 *
 * AMD publishes a second, paid section (`dedicated`: "Deploy dedicated
 * instances with your own credits") from a different endpoint. A bootstrap
 * document that declares any other section key —or one we cannot read —is
 * rejected *before* a single card is parsed: a section whose meaning we do not
 * know may hide billing behind an ordinary-looking id, and the catalog's whole
 * promise is that everything in it is free.
 *
 * @param {object} payload - the bootstrap document
 * @returns {string|undefined} the recognised section key, when the document declared one
 * @throws {Error} when the document declares a section other than `public_free`
 */
export function assertFreeSection(payload) {
  const section = directorySection(payload)
  if (section !== undefined && section !== FREE_SECTION) {
    throw new Error(`directory answered section "${section}", not "${FREE_SECTION}" —refusing to read a section this plugin does not own`)
  }
  return section
}

/** `display_status` values AMD uses inside the free section (measured). */
const FREE_STATUSES = new Set(['free_endpoint', 'limited_free'])

/**
 * Is this detail document a *free* model? The paid section (AMD's `dedicated`
 * instances, deployed against the account's credits) must never enter the
 * catalog even if a card for one shows up in the free directory:
 *
 * - `token_factory.section` is the authoritative discriminator —`public_free`
 *   passes, `dedicated` fails outright;
 * - without a section, the `access.kind` (`dedicated_deploy`) and the
 *   measured `display_status` whitelist settle it;
 * - a detail that declares nothing at all is *unknown*, not free: it fails,
 *   because the cards this plugin reads come from a section we have already
 *   gated, so only a parsing surprise lands here, and parsing surprises do not
 *   get the benefit of the doubt on a billing question.
 *
 * A missing detail (the fetch failed) is handled by the caller —the baseline
 * row stands in, and baseline rows are curated from the free section only.
 *
 * @param {object|undefined} model - the detail document's `model` object
 * @returns {boolean}
 */
export function isFreeDetail(model) {
  if (!model || typeof model !== 'object') return false
  const tf = model.token_factory
  if (tf && typeof tf === 'object') {
    if (typeof tf.section === 'string' && tf.section !== '') return tf.section === FREE_SECTION
    const access = tf.access
    if (access && typeof access === 'object' && typeof access.kind === 'string') {
      if (access.kind === 'dedicated_deploy') return false
    }
  }
  if (typeof model.display_status === 'string' && model.display_status !== '') {
    return FREE_STATUSES.has(model.display_status)
  }
  return false
}

/** Strip the directory's `model_gateway:` source prefix from one card id. */
export function sourceId(cardId) {
  const text = String(cardId ?? '')
  const colon = text.indexOf(':')
  return colon === -1 ? text : text.slice(colon + 1)
}

function positive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined
}
