/**
 * Availability probing for the AMD lane.
 *
 * Two independent questions, deliberately kept apart because they fail for
 * different reasons:
 *
 * 1. **Is the key valid?** `GET /radeon/api/v1/models` with `Authorization:
 *    Bearer …` answers 200 with the routed list when the key works, and 401
 *    with an empty body when it does not (measured live, both with and without
 *    a dummy key). This verdict gates everything else: without a working key no
 *    model is usable, and the settings page has to say so rather than let the
 *    picker fill with models that all fail.
 * 2. **Does this model answer?** A ping — the smallest request that can produce
 *    a verdict (`max_tokens: 16`, one word). Only readings that come from the
 *    answer itself move a model: a refusal that names the model makes it
 *    `unavailable`; 5xx, 429, timeouts and transport failures say nothing about
 *    the model and leave it where it was.
 *
 * The fleet-load document is a third, weaker signal: it reports `idle`/`busy`/
 * `full` per model with a utilization percentage, costs no key, and is shown as
 * a load badge rather than as availability — capacity is transient, and a model
 * at 100% now is not a model that should leave the picker.
 *
 * @module src/probe.js
 */

import { CODE, getApi, postStreamed } from './http.js'
import { modelsUrl } from './upstream.js'

/**
 * Verdicts the probe can return, and how each maps to picker membership.
 *
 * There is no "quota exceeded" verdict, and that is a finding rather than an
 * omission. AMD publishes no per-user allowance for the free section: every
 * model card states "Free to use. Points show relative usage—not a charge",
 * the load endpoint is the only capacity signal it exposes, and the page
 * carries no rate-limit, fair-use or quota terms at all. The only refusal the
 * free lane is observed to produce is a 429 raised while the model's pool is
 * saturated — and which models are saturated changes minute to minute.
 *
 * So every 429 is reported as what can actually be claimed about it: the
 * fleet would not take this request right now. A separate per-user limit, if
 * AMD ever introduces one, is an undocumented behaviour change — the raw
 * status and body are still recorded on the row, so it shows up in the log
 * rather than being guessed at in the badge.
 */
export const STATE = {
  available: 'available',
  unavailable: 'unavailable',
  /** The fleet refused this request (429) while the model was unavailable. */
  busy: 'busy',
  noKey: 'no-key',
  unknown: 'unknown',
}

const PING_PROMPT = 'ping'

/**
 * Verify the configured key against the OpenAI listing.
 *
 * @param {string} apiKey
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ok: boolean, models: string[], detail?: string, inconclusive?: boolean}>}
 */
export async function verifyKey(apiKey, { signal } = {}) {
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    return { ok: false, models: [], detail: 'no API key configured' }
  }
  try {
    const payload = await getApi(modelsUrl(), apiKey.trim(), { signal, timeoutMs: 15000 })
    const ids = Array.isArray(payload?.data)
      ? payload.data.map(row => (typeof row === 'string' ? row : row?.id)).filter(id => typeof id === 'string')
      : []
    return { ok: true, models: ids }
  } catch (error) {
    if (error?.code === CODE.credential) return { ok: false, models: [], detail: 'the key was rejected (401)' }
    // Anything else — a timeout, a 5xx on the listing — is not a verdict about
    // the key: reporting `ok: false` there would blank the picker on a blip.
    return { ok: false, models: [], detail: typeof error?.message === 'string' ? error.message.slice(0, 200) : String(error), inconclusive: true }
  }
}

/**
 * Ask the gateway for one model, once.
 *
 * @param {object} model - catalog entry
 * @param {object} options
 * @param {string} options.apiKey
 * @param {string} [options.attributionUserAgent]
 * @param {{state: string, utilization: number}} [options.load] - the model's
 *   most recent fleet-load reading, so a refusal can be read against capacity
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{state: string, detail?: string, latencyMs: number, ttftMs?: number}>}
 */
export async function probeModel(model, { apiKey, attributionUserAgent, load, signal, timeoutMs = 45000 } = {}) {
  const started = Date.now()
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    return { state: STATE.noKey, detail: 'no API key configured', latencyMs: 0 }
  }

  const body = { model: model.id, messages: [{ role: 'user', content: PING_PROMPT }], stream: true, max_tokens: 16 }
  let firstDelta
  try {
    await postStreamed({
      apiKey: apiKey.trim(),
      body,
      attributionUserAgent,
      signal,
      timeoutMs,
      onData: payload => {
        if (firstDelta !== undefined) return
        if (/"(delta|content|text)"/.test(payload)) firstDelta = Date.now()
      },
    })
    return { state: STATE.available, latencyMs: Date.now() - started, ttftMs: firstDelta === undefined ? undefined : firstDelta - started }
  } catch (error) {
    return {
      state: stateOf(error),
      detail: describeRefusal(error, load),
      latencyMs: Date.now() - started,
    }
  }
}

/**
 * Map one probe failure onto a verdict.
 *
 * The line that matters is whether the gateway *named this model as something
 * it will not route*. Only those readings come from the answer itself: a
 * refusal whose message is about the model, or a status whose whole meaning is
 * the identifier we sent — 400, 404, 422.
 *
 * Everything else says nothing about the model and must not move it:
 * - 401/403 is the *key*, which `verifyKey` owns; a per-model ping seeing it
 *   while the listing said ok is a mid-run revocation, reported `unknown` so
 *   the key status, not the model, changes;
 * - 429 is capacity — the model exists and the budget is spent;
 * - 5xx, timeouts, transport: the gateway's own trouble;
 * - no status at all means no answer was received.
 *
 * The asymmetry is deliberate: a stale entry costs one failed turn the user can
 * retry, while a model that vanished on a hiccup costs a re-probe-and-wait cycle
 * the user has no visibility into.
 */
const ROUTING_REFUSAL_STATUS = new Set([400, 404, 422])

/**
 * How saturated is this model's pool right now?
 *
 * AMD's own load endpoint publishes exactly this: `state: 'full'` at 100%
 * utilization, `busy` above 60%, `idle` below. It is read for the *wording* of
 * a refusal, not for the verdict: on this lane a 429 means the fleet would not
 * take the request, and the reading only decides whether the settings page can
 * say "the pool is full" or has to say "the gateway declined without saying
 * why" — an honest admission rather than an invented quota.
 *
 * @param {{state: string, utilization: number}|undefined} load
 * @returns {boolean}
 */
export function isSaturated(load) {
  if (!load || typeof load !== 'object') return false
  if (load.state === 'full') return true
  // 99%+ is `full` in everything but the label, and the utilization is the
  // number the endpoint computes; trust it over a string that may lag.
  return typeof load.utilization === 'number' && load.utilization >= 99
}

/**
 * The sentence the settings page shows under a refused model.
 *
 * Two claims, kept apart on purpose. When the load endpoint says the pool is
 * full, that is a fact about the fleet and it clears by itself. When the
 * gateway refuses with no saturation to point at, the plugin says exactly that
 * — it does not reach for "your quota ran out", because the free section
 * publishes no per-user allowance for that to be true of.
 *
 * @param {object} error - the classified failure
 * @param {{state: string, utilization: number}|undefined} load
 * @returns {string}
 */
function describeRefusal(error, load) {
  const base = typeof error?.message === 'string' && error.message !== '' ? error.message : String(error)
  if (error?.code !== CODE.quota) return base
  const percent = typeof load?.utilization === 'number' ? Math.round(load.utilization) : null
  if (isSaturated(load)) {
    const reading = percent === null ? 'at capacity' : `at ${percent}% utilization`
    return `AMD's compute pool for this model is ${reading} (fleet load: ${load.state}). This is fleet capacity, not an allowance on your account — it usually clears within minutes. The gateway said: ${base}`
  }
  const observed = load === undefined
    ? 'no saturation reading was available'
    : `the fleet reported ${load.state}${percent === null ? '' : ` at ${percent}%`} for it`
  return `The gateway declined this request (HTTP 429) and ${observed}. The free section publishes no per-user allowance, so this is reported as capacity rather than a quota. The gateway said: ${base}`
}

function stateOf(error) {
  switch (error?.code) {
    // Every 429 on this lane is the fleet declining, whatever the load
    // endpoint happened to say at that instant — see the STATE note.
    case CODE.quota: return STATE.busy
    case CODE.credential: return STATE.unknown
    default: break
  }
  const message = String(error?.message ?? '')
  // The message match may only speak when the status did not already answer:
  // a reverse proxy spells 503 "Service Unavailable", and reading that reason
  // phrase as the gateway naming this model drops a working model until the
  // next round.
  const gatewayTrouble = Number.isInteger(error?.status) && error.status >= 500
  const named = error?.unavailable === true
    || (!gatewayTrouble && /unavailable|not supported|no such model|unknown model|invalid model/i.test(message))
  if (named) return STATE.unavailable
  if (Number.isInteger(error?.status) && ROUTING_REFUSAL_STATUS.has(error.status)) return STATE.unavailable
  return STATE.unknown
}

/**
 * Probe a whole catalog with a bounded fan-out.
 *
 * Concurrency stays low on purpose: this lane accounts rate per key and answers
 * 429, so a wide burst would throttle the very key whose availability we are
 * establishing.
 *
 * `options.load` may be a reading for one model or a resolver for the whole
 * map; it is resolved per model, immediately before that model's ping, so a
 * saturated model is recognised even when the fleet fills up mid-round.
 *
 * @param {Array<object>} models
 * @param {object} options - forwarded to `probeModel` (needs `apiKey`)
 * @param {(id: string, result: object) => void} [onResult]
 * @param {number} [concurrency]
 * @returns {Promise<Record<string, object>>}
 */
export async function probeCatalog(models, options = {}, onResult = () => {}, concurrency = 2) {
  const results = {}
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, models.length)) }, async () => {
    while (cursor < models.length) {
      const index = cursor++
      const model = models[index]
      const perModel = { ...options }
      if (typeof options.load === 'function') perModel.load = options.load(model.id)
      const result = await probeModel(model, perModel)
      results[model.id] = result
      onResult(model.id, result)
    }
  })
  await Promise.all(workers)
  return results
}
