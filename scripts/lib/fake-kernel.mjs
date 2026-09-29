/**
 * A minimal cordis-shaped context, enough to run `index.js`'s `apply()` in a
 * test process without a harness installation.
 *
 * Three behaviours are load-bearing rather than convenient:
 *
 * - `effect(fn, label)` collects disposers, so a test can tear a generation
 *   down exactly the way the fiber would;
 * - `inject(['webServer'], cb)` hands the callback a scoped context carrying a
 *   recording `webServer`, so the plugin's real route registration runs and the
 *   tests can invoke the handlers it publishes;
 * - `llm.registerAdapter` captures the adapter instance — that object is what
 *   the end-to-end stream assertions drive directly.
 *
 * @module scripts/lib/fake-kernel.mjs
 */

import { Readable } from 'node:stream'

/**
 * Build a fake `ctx`.
 *
 * @param {object} [options]
 * @param {(message: string) => void} [options.log] - receives logger lines
 * @returns {object} the ctx, plus a `__test` harness for assertions
 */
export function makeCtx(options = {}) {
  const log = options.log ?? (() => {})
  const disposers = []
  const routes = []
  const events = []
  let registration = null

  const logger = {
    info: message => log(`[info] ${message}`),
    warn: message => log(`[warn] ${message}`),
    error: message => log(`[error] ${message}`),
    debug: message => log(`[debug] ${message}`),
    log: message => log(`[log] ${message}`),
  }

  const webServer = {
    register(route) {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index !== -1) routes.splice(index, 1)
      }
    },
  }

  const ctx = {
    logger,
    llm: {
      registerAdapter(routes, adapter) {
        registration = { routes: [...routes], adapter }
        const dispose = () => { if (registration?.adapter === adapter) registration = null }
        dispose.replace = next => { if (registration) registration.routes = [...next] }
        return dispose
      },
      registerConfigurableProviders() { return () => {} },
      registerModelDiscovery() { return () => {} },
    },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
    on() {},
    emit() {},
    get(name) {
      if (name === 'webServer') return webServer
      if (name === 'attachments') return undefined
      if (name === 'connection') return undefined
      return undefined
    },
    inject(deps, callback) {
      const scoped = {
        webServer,
        effect(fn) {
          const disposer = fn()
          if (typeof disposer === 'function') disposers.push(disposer)
        },
      }
      callback(scoped)
    },
  }

  ctx.__test = {
    routes,
    events,
    get registration() { return registration },
    dispose() {
      // Reverse order, the way a fiber unwinds: intervals and listeners first,
      // stores last, so nothing writes after its own disposer ran.
      for (const disposer of [...disposers].reverse()) {
        try { disposer() } catch (error) { log(`[dispose error] ${error?.message ?? error}`) }
      }
      disposers.length = 0
    },
  }
  return ctx
}

/**
 * Invoke a registered plugin route with a mock request/response pair.
 *
 * @param {(req: object, res: object) => any} handler - a route handler the plugin registered
 * @param {string} method
 * @param {string} path - the full path, e.g. `/api/amd-free-model/summary`
 * @param {object} [body] - JSON body for POST
 * @param {object} [headers] - extra headers (host defaults to a loopback authority)
 * @returns {Promise<{status: number, headers: object, body: string, json: any}>}
 */
export function callRoute(handler, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body)
    const req = Readable.from([Buffer.from(payload, 'utf8')])
    req.method = method
    req.url = path
    req.headers = {
      host: '127.0.0.1:3999',
      origin: 'http://127.0.0.1:3999',
      referer: 'http://127.0.0.1:3999/',
      'content-type': 'application/json',
      ...headers,
    }
    const res = {
      statusCode: 0,
      headers: {},
      body: '',
      writeHead(status, responseHeaders = {}) {
        this.statusCode = status
        this.headers = responseHeaders
        return this
      },
      end(chunk) {
        if (chunk !== undefined && chunk !== null) this.body += String(chunk)
        let json
        try { json = JSON.parse(this.body) } catch { json = undefined }
        resolve({ status: this.statusCode, headers: this.headers, body: this.body, json })
      },
    }
    try {
      const outcome = handler(req, res)
      if (outcome && typeof outcome.catch === 'function') outcome.catch(reject)
    } catch (error) {
      reject(error)
    }
  })
}

/** Wait until `probe()` returns a truthy value, or fail with `label`. */
export async function waitFor(probe, { timeoutMs = 15000, intervalMs = 50, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await probe()
    if (last) return last
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)
}
