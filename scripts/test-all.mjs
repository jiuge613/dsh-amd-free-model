/**
 * The whole offline suite, one command.
 *
 * Every child is a separate Node process: a module-level state leak in one
 * suite cannot poison another, and a hung suite is attributed to itself. Each
 * child gets a hard timeout so a deadlock reports as a failure instead of
 * holding the runner (and CI) forever.
 *
 * `npm test` runs only what needs no network and no key — the live-lane
 * selftest stays a separate, manual command (`npm run selftest`), because it
 * spends a real key's budget when pointed at the real gateway.
 *
 * @module scripts/test-all.mjs
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const SUITES = [
  { script: 'scripts/offline-test.mjs', timeoutMs: 60_000 },
  { script: 'scripts/client-lint.mjs', timeoutMs: 60_000 },
  { script: 'scripts/build-manifest.mjs', args: ['--check'], timeoutMs: 30_000 },
  { script: 'scripts/host-selftest.mjs', timeoutMs: 120_000 },
  // Its own process by necessity: the AMD origin is a module-load constant, so
  // testing the paid section needs a process that never loaded the free one.
  { script: 'scripts/section-gate-test.mjs', timeoutMs: 60_000 },
]

function run(suite) {
  return new Promise(resolve => {
    const started = Date.now()
    const child = spawn(process.execPath, [path.join(ROOT, suite.script), ...(suite.args ?? [])], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    })
    let output = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, suite.timeoutMs)
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ suite, code: timedOut ? -1 : code ?? 0, output, ms: Date.now() - started })
    })
  })
}

const results = []
for (const suite of SUITES) {
  process.stdout.write(`\n── ${suite.script} ──\n`)
  const result = await run(suite)
  results.push(result)
  process.stdout.write(result.output)
  if (result.code !== 0) {
    if (result.code === -1) console.log(`SUITE HUNG: ${suite.script} exceeded ${suite.timeoutMs}ms and was killed`)
    break
  }
}

const failed = results.filter(result => result.code !== 0)
console.log('\n══ test-all ══')
for (const result of results) {
  const mark = result.code === 0 ? 'PASS' : 'FAIL'
  console.log(`  ${mark}  ${result.suite.script}  (${result.ms}ms)`)
}
if (failed.length > 0) {
  console.log(`\n${failed.length} suite(s) failed`)
  process.exitCode = 1
} else {
  console.log(`\nall ${results.length} suites passed`)
}
