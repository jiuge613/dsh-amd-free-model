/**
 * Outbound HTTP for the AMD lane: request posting, SSE line extraction, the
 * discovery helpers the catalog needs, and the classification of gateway
 * failures into the harness's provider-neutral codes.
 *
 * Three failure shapes matter operationally on this lane:
 *
 * - 401 on `/api/v1/*` — the key is missing, malformed or revoked. This is the
 *   one credential the plugin has, so it maps to `INVALID_CREDENTIAL` and feeds
 *   the settings page's key status rather than a retry.
 * - 429 — per-key rate/capacity. The fleet load endpoint reports the same
 *   pressure as `busy`/`full`, and retrying spends the key's budget.
 * - 400/404/422 on a model — the gateway naming the model as something it will
 *   not route, which is what the availability probe reads as `unavailable`.
 *
 * How a 2xx body is read is decided by the body, not by `Content-Type`: the
 * reference implementation measured this class of gateway answering 200 with a
 * JSON content type over an SSE frame stream, and believing the header cost the
 * whole turn. The head is sniffed and replayed into the stream reader, so no
 * token is buffered.
 *
 * @module src/http.js
 */

import { AMD_ORIGIN, APP_BASE, apiHeaders, endpointFor, siteHeaders } from './upstream.js'

/** Harness-neutral failure codes (packages/llm/llm/src/error.ts vocabulary). */
export const CODE = {
  region: 'REGION_BLOCKED',
  quota: 'RATE_LIMIT',
  credential: 'INVALID_CREDENTIAL',
  transport: 'TRANSPORT',
  timeout: 'TIMEOUT',
  server: 'SERVER',
  empty: 'EMPTY_RESPONSE',
  aborted: 'ABORTED',
}

export class UpstreamError extends Error {
  constructor(message, code, details = {}) {
    super(message)
    this.name = 'UpstreamError'
    this.code = code
    Object.assign(this, details)
  }
}

/** Turn a gateway JSON error envelope into a classified failure. */
export function classifyFailure(status, payload, retryAfterMs) {
  const error = payload?.error ?? payload ?? {}
  const type = typeof error.type === 'string' ? error.type : ''
  const message = typeof error.message === 'string' ? error.message : `upstream HTTP ${status}`
  const flat = message.toLowerCase()
  if (type === 'RegionError' || /not available in your country|region/i.test(flat)) {
    return new UpstreamError(message, CODE.region, { status, type })
  }
  if (status === 429 || /usage limit|rate limit|too many requests/.test(flat)) {
    return new UpstreamError(message, CODE.quota, { status, type, providerRetryAfterMs: retryAfterMs })
  }
  // The key is the whole credential on this lane: 401 (empty body, measured
  // live) and 403 both mean "this key cannot", never "this model cannot".
  if (status === 401 || status === 403) return new UpstreamError(message, CODE.credential, { status, type })
  if (type === 'ModelError' || /model is unavailable|not supported|no such model|unknown model/.test(flat)) {
    return new UpstreamError(message, CODE.server, { status, type, unavailable: true })
  }
  if (status >= 500) return new UpstreamError(message, CODE.server, { status, type })
  return new UpstreamError(message, CODE.server, { status, type })
}

/** Parse `Retry-After` into milliseconds, when the header carries a number. */
function retryAfter(header) {
  const seconds = Number(header)
  return Number.isFinite(seconds) && seconds > 0 ? Math.trunc(seconds * 1000) : undefined
}

/**
 * How many bytes to look at before deciding what the body is.
 *
 * The header is a hint, not a verdict (see the module note), and the bytes
 * spent looking are replayed in front of the reader — never swallowed by a
 * `response.text()`, which would buffer a live stream to the end before
 * yielding a single token.
 */
const SNIFF_BYTES = 4096

/**
 * Two deadlines, because "no answer yet" and "answer stalled" are different
 * failures with different remedies.
 *
 * `FIRST_BYTE_MS` bounds only the wait for the response head: the request
 * reached the gateway and nothing has come back. A healthy route answers in
 * seconds, so a minute of silence is a failure — and waiting five minutes to
 * learn that is what turned a dead turn into a UI that looked hung. The single
 * `timeoutMs` this replaced applied the same budget twice, once here and once
 * in `readSse`, so a stalled head spent the full five minutes before saying
 * anything at all.
 *
 * `IDLE_MS` then bounds the gaps *between* frames of an answer already
 * streaming, and stays generous on purpose: a reasoning model legitimately emits
 * nothing for a long stretch mid-answer, and cutting it off would truncate a
 * turn that was going to succeed.
 */
const FIRST_BYTE_MS = 60_000
const IDLE_MS = 300_000

/**
 * Classify the beginning of a response body by shape.
 *
 * @param {string} text - the decoded head, possibly a partial stream
 * @returns {'sse'|'json'|'empty'|'unknown'}
 */
export function sniffBody(text) {
  const head = String(text ?? '').replace(/^﻿/, '').trimStart()
  if (head === '') return 'empty'
  if (head.startsWith(':') || /^(?:data|event|id|retry)[ \t]*:/m.test(head.slice(0, 64))) return 'sse'
  if (head.startsWith('{') || head.startsWith('[')) return 'json'
  return 'unknown'
}

/**
 * Take the first `limit` bytes of a body without losing the rest of it.
 *
 * Stops as soon as the head has said it is a stream: a short answer whose
 * server keeps the connection open would otherwise sit here until the deadline,
 * and the cancel on the way out discards everything already read — a complete
 * turn, reported as a retryable timeout.
 *
 * @param {ReadableStream} stream
 * @param {number} limit
 * @param {object} options
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs] - how long to wait for the first byte
 * @returns {Promise<{reader:object, chunks:Uint8Array[], done:boolean, text:string, decoder:TextDecoder}>}
 */
async function readHead(stream, limit, { signal, timeoutMs = FIRST_BYTE_MS }) {
  const reader = stream.getReader()
  const chunks = []
  // One decoder for the whole body: flushing here would corrupt a multi-byte
  // character whose tail arrives in the next chunk.
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  let done = false
  try {
    while (size < limit) {
      const row = await headRead(reader, signal, deadlineFor(timeoutMs))
      if (row.done) { done = true; break }
      if (row.value === undefined) continue
      chunks.push(row.value)
      size += row.value.byteLength ?? 0
      text += decoder.decode(row.value, { stream: true })
      if (sniffBody(text) === 'sse') break
    }
  } catch (error) {
    // Abandoning the body: cancel it so the connection is not held, and do not
    // let a lock-release complaint replace the failure the caller classifies.
    await reader.cancel().catch(() => {})
    try { reader.releaseLock?.() } catch { /* mid-teardown */ }
    throw classifyStreamFailure(error, signal)
  }
  return { reader, chunks, done, text, decoder }
}

/**
 * Normalize anything the body reads can throw into an `UpstreamError`.
 *
 * Aborting a request rejects the pending `reader.read()` with the signal's own
 * `DOMException`, whose `code` is the *numeric* legacy `20`. The adapter's
 * `toFailure` only carries a string code, so anything unrecognized becomes
 * `TRANSPORT` — a retryable code — and the harness would retry a turn the user
 * deliberately cancelled.
 */
export function classifyStreamFailure(error, signal) {
  if (error instanceof UpstreamError) return error
  if (signal?.aborted === true || error?.name === 'AbortError') return new UpstreamError('request aborted', CODE.aborted)
  return new UpstreamError(`amd-free-model: upstream stream read failed: ${error?.message ?? error}`, CODE.transport)
}

/** The head is the one read with no line-level deadline behind it, so it needs its own. */
function deadlineFor(timeoutMs) {
  return Date.now() + timeoutMs
}

/**
 * One read off the body while deciding what it is, bounded by the same deadline
 * and abort signal `readSse` would have honoured. Without this a connection
 * that accepts the request and then never sends a byte would hang the turn
 * here, in the few lines of code that run before any watchdog exists.
 */
async function headRead(reader, signal, deadline) {
  if (signal?.aborted) throw new UpstreamError('request aborted', CODE.aborted)
  let timer
  let onAbort
  const pending = reader.read()
  const halted = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new UpstreamError('amd-free-model: upstream sent no bytes before its deadline', CODE.timeout)),
      Math.max(0, deadline - Date.now()))
    timer.unref?.()
    onAbort = () => {
      void reader.cancel().catch(() => {})
      reject(new UpstreamError('request aborted', CODE.aborted))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([pending, halted])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    // The losing read settles on its own once the reader is cancelled or closed;
    // nothing is waiting on it, so its outcome must not surface as a rejection.
    pending.catch(() => {})
  }
}

/**
 * Turn a head that was already read, plus the reader that follows it, back into
 * one byte stream.
 */
async function* replayStream(head) {
  try {
    for (const chunk of head.chunks) yield chunk
    if (head.done) return
    while (true) {
      const row = await head.reader.read()
      if (row.done) return
      if (row.value !== undefined) yield row.value
    }
  } finally {
    if (!head.done) await head.reader.cancel().catch(() => {})
    head.reader.releaseLock?.()
  }
}

/**
 * Read the rest of a body that is not a stream, as text.
 * Continues on the decoder the head used, so a character split across the sniff
 * boundary still decodes.
 */
async function readRemainder(head, signal) {
  let text = head.text
  try {
    if (!head.done) {
      while (true) {
        const row = await head.reader.read()
        if (row.done) break
        if (row.value !== undefined) text += head.decoder.decode(row.value, { stream: true })
      }
    }
  } catch (error) {
    await head.reader.cancel().catch(() => {})
    throw classifyStreamFailure(error, signal)
  }
  return text + head.decoder.decode()
}

/**
 * The harness mandates an attribution User-Agent on every provider request;
 * the gateway does not check it on this lane, so attribution is all it carries.
 */
function userAgentWith(attribution) {
  if (typeof attribution !== 'string' || attribution === '') return 'deepseek-harness'
  return attribution
}

/**
 * POST one chat request and stream back decoded SSE `data:` payloads.
 *
 * @param {object} options
 * @param {string} options.apiKey - the user's Token Factory key
 * @param {object} options.body - JSON request body
 * @param {string} [options.attributionUserAgent] - harness User-Agent
 * @param {AbortSignal} [options.signal]
 * @param {(payload: string) => void} options.onData - one `data:` payload, in order
 * @param {number} [options.timeoutMs] - idle deadline for the stream
 * @returns {Promise<{status:number, headers:Headers}>}
 */
export async function postStreamed({ apiKey, body, attributionUserAgent, signal, onData, timeoutMs = IDLE_MS }) {
  const headers = apiHeaders(apiKey, { stream: true })
  headers['user-agent'] = userAgentWith(attributionUserAgent)
  let response
  try {
    response = await fetch(endpointFor(), { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal })
  } catch (error) {
    // The signal's own reason is what fetch rejects with, and Node's is a
    // `TimeoutError`/user Error rather than `AbortError` — testing the name
    // alone would report a cancelled turn as `TRANSPORT`, which is retryable.
    if (signal?.aborted === true || error?.name === 'AbortError') throw new UpstreamError('request aborted', CODE.aborted)
    throw new UpstreamError(`amd-free-model: upstream request failed: ${error?.message ?? error}`, CODE.transport)
  }

  const setRetry = retryAfter(response.headers.get('retry-after'))
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let payload
    try { payload = JSON.parse(text) } catch { payload = { error: { message: text.slice(0, 300) || `HTTP ${response.status}` } } }
    throw classifyFailure(response.status, payload, setRetry)
  }
  if (response.body === null) throw new UpstreamError('amd-free-model: upstream returned no body', CODE.empty)

  // `Content-Type` is a hint; take the first bytes and let the body say what it
  // is. Whatever was spent reading them is replayed in front of the stream.
  // The head gets FIRST_BYTE_MS rather than the caller's stream budget: "no
  // answer at all" and "answer went quiet" are different questions.
  const head = await readHead(response.body, SNIFF_BYTES, { signal, timeoutMs: FIRST_BYTE_MS })
  const shape = sniffBody(head.text)
  if (shape === 'empty') throw new UpstreamError('amd-free-model: upstream returned no body', CODE.empty)
  if (shape === 'sse') {
    await readSse(replayStream(head), onData, signal, timeoutMs)
    return { status: response.status, headers: response.headers }
  }

  const text = head.done ? head.text : await readRemainder(head, signal)
  if (shape !== 'json') throw new UpstreamError(`amd-free-model: unexpected non-SSE response: ${text.slice(0, 200)}`, CODE.server, { status: response.status })
  let payload
  try { payload = JSON.parse(text) } catch {
    throw new UpstreamError(`amd-free-model: unexpected non-SSE response: ${text.slice(0, 200)}`, CODE.server, { status: response.status })
  }
  if (payload.error) throw classifyFailure(response.status, payload, setRetry)
  onData(JSON.stringify(payload))
  return { status: response.status, headers: response.headers }
}

/**
 * Split an SSE byte stream into `data:` payload strings; comment lines ignored.
 *
 * The source is anything that yields byte chunks: a `ReadableStream` (Node's
 * own response body) or an async iterable, which is what lets a head that was
 * already sniffed be replayed in front of the live reader.
 */
export async function readSse(source, onData, signal, timeoutMs = IDLE_MS) {
  const reader = typeof source?.getReader === 'function' ? source.getReader() : null
  const iterator = reader ?? (typeof source?.[Symbol.asyncIterator] === 'function' ? source[Symbol.asyncIterator]() : source)
  const decoder = new TextDecoder()
  let buffer = ''
  let deadline = Date.now() + timeoutMs
  const stop = () => {
    if (reader !== null) void reader.cancel().catch(() => {})
    else void iterator?.return?.()
  }
  const onAbort = () => { stop() }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    while (true) {
      const { value, done } = await iterator.next()
      if (done) break
      if (Date.now() > deadline) throw new UpstreamError('amd-free-model: upstream stream idle past its deadline', CODE.timeout)
      if (value !== undefined) buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        emit(line, onData)
        newline = buffer.indexOf('\n')
      }
      deadline = Date.now() + timeoutMs
    }
    // Flush the decoder so a multi-byte character split over the last two chunks
    // is not silently dropped from the final payload.
    buffer += decoder.decode()
    emit(buffer, onData)
  } catch (error) {
    throw classifyStreamFailure(error, signal)
  } finally {
    signal?.removeEventListener('abort', onAbort)
    if (reader !== null) reader.releaseLock?.()
    else void iterator?.return?.()
  }
}

function emit(line, onData) {
  const text = line.trim()
  if (text === '' || text.startsWith(':')) return
  if (text.startsWith('data:')) {
    const payload = text.slice(5).trim()
    if (payload === '' || payload === '[DONE]') return
    onData(payload)
  }
}

/**
 * Fetch one URL as JSON with the given headers, bounded and abortable.
 *
 * Used for both discovery (`siteHeaders`) and the authenticated OpenAI
 * endpoints (`apiHeaders`); the caller decides which credential, because the
 * directory answers without a key and the OpenAI list does not.
 *
 * @param {string} url - absolute URL
 * @param {object} options
 * @param {Record<string,string>} options.headers
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs]
 * @param {string} [options.method]
 * @param {string} [options.body]
 * @returns {Promise<any>}
 */
export async function getJson(url, { headers, signal, timeoutMs = 20000, method = 'GET', body } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  let callerAborted = false
  const onCallerAbort = () => { callerAborted = true; controller.abort() }
  signal?.addEventListener('abort', onCallerAbort, { once: true })
  try {
    const response = await fetch(url, {
      method,
      headers: { ...headers, 'user-agent': userAgentWith(headers?.['user-agent']) },
      ...body === undefined ? {} : { body },
      redirect: 'error',
      signal: controller.signal,
    })
    const text = await response.text()
    let payload
    try { payload = JSON.parse(text) } catch { payload = { error: { message: text.slice(0, 200) } } }
    if (!response.ok) throw classifyFailure(response.status, payload)
    return payload
  } catch (error) {
    if (error instanceof UpstreamError) throw error
    if (callerAborted || signal?.aborted === true) throw new UpstreamError('request aborted', CODE.aborted)
    if (error?.name === 'AbortError') throw new UpstreamError('amd-free-model: upstream GET timed out', CODE.timeout)
    throw new UpstreamError(`amd-free-model: upstream GET failed: ${error?.message ?? error}`, CODE.transport)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onCallerAbort)
  }
}

/** GET a discovery document (directory / detail / load) with the site headers. */
export function getDiscovery(url, options = {}) {
  return getJson(url, { ...options, headers: { ...siteHeaders(), ...(options.headers ?? {}) } })
}

/** POST the model directory with the site headers (the CSRF check needs both). */
export function postDiscovery(url, options = {}) {
  return getJson(url, {
    ...options,
    method: 'POST',
    body: options.body ?? '{}',
    headers: { ...siteHeaders(), 'content-type': 'application/json', ...(options.headers ?? {}) },
  })
}

/** GET an authenticated OpenAI endpoint (`/models`). */
export function getApi(url, apiKey, options = {}) {
  return getJson(url, { ...options, headers: { ...apiHeaders(apiKey), ...(options.headers ?? {}) } })
}

/** Origin and app base, exported for the trust fence's same-origin checks. */
export { AMD_ORIGIN, APP_BASE }
