<div align="center">

# dsh-amd-free-model

[简体中文](README.md) | **English**

<img alt="License" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square">
<img alt="Zero dependencies" src="https://img.shields.io/badge/dependencies-zero-4b6fff?style=flat-square">
<img alt="No build step" src="https://img.shields.io/badge/build%20step-none-7da1de?style=flat-square">
<img alt="Kernel" src="https://img.shields.io/badge/dsh-%3E%3D0.2.0-rc.2-2f6f4f?style=flat-square">
<img alt="Status" src="https://img.shields.io/badge/status-beta-f0a441?style=flat-square">

</div>

<div align="center">

> Paste **one** AMD Radeon Token Factory API key into DeepSeek Harness (dsh)
> and the DeepSeek V4, MiMo V2.6, Qwen3.8 and GLM 5.3 fleet on the AMD GPU
> Cloud appears in the model picker.
>
> The model directory and its capabilities follow upstream; availability is
> measured from your own machine; each effort level is a real output budget.
> Token dashboard and an OpenAI-compatible local forward port included.
>
> **Probed once a day** for the free section; models in AMD's paid section are
> never wired in.
>
> Pure plugin mount: no kernel edits, no build step, zero dependencies.

</div>

---

## Highlights

- **Free models only, enforced twice** — AMD's Token Factory publishes two sections: the free `public_free` one ("Public Free Model APIs") and the paid `dedicated` one ("Deploy dedicated instances with your own credits"). This plugin reads the free section only, and it *asserts* the section is `public_free` before parsing a single card: a paid or unrecognised section makes it decline the whole document rather than filter it. Each model's detail document is then checked again on `token_factory.section`, so a paid card that shows up in the free directory is dropped and named in the settings page. **Nothing billable can reach the picker.**
- **Daily probe, adjustable** — the catalog refreshes every 1440 minutes by default: one directory POST, one detail document per model, one key check and one ping per model. That cadence answers "which free models does AMD have today" — the directory itself changes a few times a week, so a fifteen-minute poll only spends the key's budget. Lower it in settings if the roster starts moving faster.
- **A 429 is about capacity, not your allowance** — AMD's free section has **no per-user quota**: every model card reads "Free to use. Points show relative usage—not a charge", and the page carries no rate-limit, fair-use or quota terms. So a 429 is always shown as "Busy, try again shortly" and the model **stays in the picker** (it clears in minutes; retry, do not change the key) rather than being reported as "your quota ran out". The settings page gives the gateway's own words alongside the load it published; when no saturation reading exists, the plugin says so instead of inventing a reason.
  - Evidence (checked 2026-09-29): the free section's `token_factory.pricing.note`, a whole-page scan for `rate limit` / `quota` / `限流` (0 hits each), and four candidate limit endpoints (all 404). `credits` is the paid section's unit for deployed instances, unrelated to the free API.
- **One key, models appear** — paste it once in settings. The key lives on this machine only (`0600` file); the API returns its masked shape and never the value.
- **The roster follows upstream** — models, context lengths and vision/tool/thinking capabilities are re-fetched from the free directory on every refresh. The directory needs no key, so you can browse the full fleet before configuring one.
- **Load is load, availability is availability** — a public endpoint (idle/busy/full + utilization) refreshes every two minutes as a badge; a model at 100% stays in the picker. Only per-model probing moves availability.
- **Honest probe verdicts** — only a refusal that names the model removes it from the picker. 5xx, 429, timeouts and network failures leave it alone. With no key every model reads "Key needed" and stays advertised — the picker never goes empty.
- **Effort levels are enforced** — `Light / Balanced / Deep` become the `max_tokens` actually sent (2048 / 8192 / model capacity); models that cannot switch thinking off double the low rungs, because thinking and the answer share one ceiling.
- **Local forward port** — an OpenAI-compatible listener on `127.0.0.1` for your other local tools; loopback-only binding, a routable address is refused outright.
- **In-app upgrades + hot reload** — one click in settings: download → SHA-256 verify → backup → atomic replace → read-back → hot reload, with automatic rollback at any failed step.
- **Runs without a browser surface** — `llm` is the only hard dependency; a composition with no HTTP server still serves models, and the settings routes wait on their own fiber.
- **Usage dashboard, all local** — token heatmap, cumulative curves, output speed and first-token latency sampled per call. Nothing is uploaded.
- **Trust fence** — the plugin's routes outrank the kernel's `/api` in prefix dispatch, so they carry their own admission check: the composition's `connection` service when present, otherwise a structural replica (loopback only, cross-site refused, missing Host fails closed).

## What you get

`Settings → AMD Free Model`, seven sections:

1. **Model roster** — availability badge, load badge (idle/busy/full + utilization), vision/text, context, max output, the real per-rung output ceilings, measured first-token latency, and a per-model benchmark button. A "N paid model(s) excluded" line sits at the top; hovering it names them.
2. **API Key** — password field, save/clear, masked status with the verify verdict, and a link to mint a key. Saving verifies against `/v1/models` immediately and re-probes everything.
3. **Announcement center** — pushed from the repository, live arrival, read markers, optional OS notifications.
4. **Usage dashboard** — totals, a 17-week token heatmap, cumulative curves, speed sparklines, per-model table.
5. **Local forward** — toggle, bind address and port, copy base URL, show/copy/rotate the forward key, a `curl` example.
6. **Plugin settings** — master switch, probe interval (default 1440 minutes = daily), per-call output ceiling, key status, last probe time.
7. **Plugin upgrade** — current/latest version, check, one-click upgrade, hot-reload button.

## Install

### Desktop (recommended)

1. Open the **left navigation → Plugins**;
2. Click the **add plugin** button in the top-right corner;
3. Paste the repository URL into the input field:

   ```
   https://github.com/jiuge613/dsh-amd-free-model
   ```

4. Confirm, then restart the app once (or let the plugin hot-reload).

The in-app plugin manager handles the profile gate itself — do **not** install
with a `link:` dependency or a directory junction by hand; the gate refuses to
start with `PROFILE_UPGRADE_REQUIRED`.

### Command line (`dsh web`)

```bash
dsh plugin --profile web add github:jiuge613/dsh-amd-free-model
```

`--profile` is whichever profile you actually run. Restart once after installing.

### Configure the key

1. Sign in at [developer.amd.com.cn/radeon/profile](https://developer.amd.com.cn/radeon/profile) and pick up an API key;
2. `Settings → AMD Free Model → API Key`, paste, save;
3. The page flips to "key valid" and the models move from "Key needed" to "Available".

## Which sources does it talk to

One: the **AMD Radeon Cloud Token Factory** (`developer.amd.com.cn`). Concretely (`src/upstream.js`, verified by direct request on 2026-09-29):

| Purpose | Target | Credential |
| --- | --- | --- |
| Chat requests | `POST /radeon/api/v1/chat/completions` | `Authorization: Bearer <your key>` |
| Key verification + model list | `GET /radeon/api/v1/models` | same |
| **Free-section** directory + capabilities | `POST /radeon/api/tokenfactory/bootstrap`, `GET …/model?id=…` | none (requires `Origin` + `Referer` headers — the site's CSRF check) |
| Fleet load | `GET /radeon/api/tokenfactory/load` | none |
| Announcements + upgrade manifest | this repository's `feed/*.json` (raw.githubusercontent, jsDelivr fallback) | none |
| Egress IP (forward diagnostics) | `api.ipify.org` et al., your public address only | none |

- **The paid section (`/api/templates`, `token_factory.section: "dedicated"`) is never requested**: it deploys dedicated instances against the account's credits, this plugin does not wire it in, and it is absent from the outbound list above.
- **No proxies, no pool**: your prompts, tool results and attached images go to the AMD free gateway as ordinary inference requests, exactly like calling any model API.
- Dashboard data, settings and the key stay under `DSH_HOME/amd-free-model/`.
- The settings API returns only the masked key shape (first 4 + last 4); the file is `0600`.
- In-app upgrades trust the plugin repository itself — whoever can push the repository can push code, the same trust model as installing a plugin update. File integrity is covered by the SHA-256 manifest.

## Security and privacy

- All state under `DSH_HOME/amd-free-model/`: `settings.json` (contains the key, `0600`), `stats.json`, `availability.json`, `catalog.json`.
- The forward listener binds loopback only and rejects keyless requests with `401`; a routable bind address is refused at the settings endpoint and again at start.
- Forward keys are minted with `crypto` and compared with `timingSafeEqual`. No hardcoded credentials ship in this repository.
- Announcement HTML is rendered through a strict client-side whitelist (script injection, event attributes, `javascript:` URLs, iframe/svg/form all dropped).
- Uninstall removes the bundle entry only; the data directory is plain JSON and can be deleted as-is.

## Develop

```bash
npm test                    # every offline suite + manifest check; one command, no network
npm run selftest            # end-to-end against a fake gateway; also no network
npm run manifest            # regenerate feed/manifest.json
npm run manifest:check      # verify the manifest matches the on-disk bytes
```

`npm test` runs five suites:

- `scripts/offline-test.mjs` — catalog projection and the free-only filter, message projection and tool-pairing repair, SSE decoding, effort budgets, failure classification, trust fence: 32 assertions;
- `scripts/client-lint.mjs` — zh/en dictionary key parity, every `t()` key resolves, no dead keys, bundle id matches the package name;
- `scripts/build-manifest.mjs --check` — manifest equals the disk bytes (LF-normalized, so CRLF checkouts cannot drift);
- `scripts/host-selftest.mjs` — the full chain against a fake AMD gateway: a paid card dropped, cold start without a key, key save, probe, six stream paths, trust fence, forward port, benchmark: 25 assertions;
- `scripts/section-gate-test.mjs` — its own process, with the gateway answering the paid section: 4 assertions proving the section gate refuses the document before any card is read (it must be a separate process, because the AMD origin is a module-load constant).

All three free-only guards were mutation-tested: making `isFreeDetail` always true, making `buildCatalog` never drop a paid card, and making the section gate accept anything each turn the offline suite red.

Node `^22.19.0 || >=24.0.0`. No install step, no dependencies.

## Kernel compatibility

The declared range is **`>=0.2.0-rc.2 <0.3.0-0`** (`peerDependencies` on `@deepseek-ai/dsh-llm`, marked optional). It is not a guess:

- rc.2's `llm.registerAdapter` validation (an adapter's `providerInfo` must preserve its id and carry a non-empty name) matches this plugin; `prepareCall` / `listModels` / `resolveModel` / `imageRequestPricing` did not change between rc.1 and rc.2.
- rc.2's retry scheduler (`@deepseek-ai/dsh-llm-retry`) reads `initialDelayMs` / `maxDelayMs` / `jitterRatio` off the **top level** (`config.initialDelayMs * 2 ** exponent`). This plugin's `providerRetryPolicy()` returns exactly that flat, already-resolved policy — nesting the delay fields under `backoff: {}` makes every delay `NaN`, and the durable session log rejects non-finite numbers, which turns one recoverable blip into a dead turn.
- The plugin imports `@deepseek-ai/dsh-llm` in exactly one place (`adapter/kernel.js`, for the attribution User-Agent, degrading to a literal when unavailable), and its adapter is structural rather than a subclass, so no kernel version is pinned.

## Implementation layout

```text
index.js          Host half: adapter registration, directory + probe loop, key
                  storage and masking, webServer routes, forward port,
                  announcement/upgrade/hot-reload wiring
adapter/          The kernel seam — the only place allowed to import @deepseek-ai/*
src/adapter.js    Structural LlmAdapter: providerInfo, listModels, resolveModel,
                  prepareCall, stream, providerRetryPolicy
src/upstream.js   Endpoints and auth: directory/load/chat URLs, site headers
                  (CSRF), Bearer header
src/http.js       Request posting, body-shape sniffing (never trust
                  Content-Type), failure classification
src/catalog.js    Catalog projection: local capability baseline + discovery
                  overlay + load parsing
src/probe.js      Key verification (/v1/models) and per-model ping probing —
                  two questions, kept apart
src/messages.js   Harness messages -> chat wire, tool-call pairing repair
src/stream.js     SSE -> harness StreamChunk with disjoint usage accounting
src/effort.js     Effort level -> the max_tokens budget actually sent
src/forward.js    Standalone OpenAI-compatible listener (loopback only)
src/trust.js      Request trust fence for the plugin's HTTP surface
src/store.js      Plugin-owned JSON storage (0600, atomic writes)
src/feed.js       Remote announcement feed; src/updater.js in-app upgrade;
                  src/reload.js self hot-reload
client.js         Browser half: hand-written ModuleLoader bundle, no build step
scripts/          Offline test suites and the release manifest builder
```

### Three architecture decisions worth knowing

- **A structural adapter, no `@deepseek-ai/dsh-llm` import.** The kernel never checks `instanceof`; duck typing is the contract. The same code runs across kernel lines and no dependency pins a version.
- **Directory discovery needs no key.** The Token Factory's directory, capability and load endpoints are public (the directory POST only checks `Origin`/`Referer`), so the roster and its capability cards are complete before a key exists; the key gates *calling*, not *seeing*.
- **Plugin-owned JSON storage instead of the settings seam.** The settings registration API changed shape between kernel lines; a private JSON store behaves identically on both, and the key lands in a `0600` file outside any shared settings document.

## About `dsh-our-free-model`

The skeleton, architecture and much of the engineering (body-shape sniffing, tool-pairing repair, flat retry policies, budget-based effort levels, atomic upgrades, the trust fence) derive from [zouyuxuan122/dsh-our-free-model](https://github.com/zouyuxuan122/dsh-our-free-model), used under its MIT license; the copyright notice is preserved in [LICENSE](LICENSE). That project solves "a keyless OpenAI gateway"; this one solves "the AMD Token Factory with a user-owned key", and the probe, auth and directory layers are rewritten.

This is an independent plugin with no affiliation, endorsement or sponsorship from AMD. "AMD" and "Radeon" are trademarks of AMD, used here only to identify the service being integrated. Using your key under the free tier is subject to AMD's own terms.

## License

MIT, see [LICENSE](LICENSE).
