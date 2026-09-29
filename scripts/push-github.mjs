// One-off upload of the plugin to a GitHub repository through the Contents API.
//
// Used instead of `git push` because this machine has no repository of its own
// and the push path is one-shot. Every file is created (or, for the LICENSE the
// web UI already created, updated) in directory order, so parents exist before
// their children and `feed/manifest.json` — which the app's own
// `build-manifest.mjs --check` suite compares against the on-disk bytes — lands
// after the files it describes.
//
//   node scripts/push-github.mjs <owner>/<repo> <token>
//
// The token is read from argv, used only in the Authorization header, and
// never written to disk or to any file in the repository.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const [slug, token] = process.argv.slice(2)
if (!slug || !token) {
  console.error('usage: node scripts/push-github.mjs <owner>/<repo> <token>')
  process.exit(2)
}

const API = 'https://api.github.com'
const headers = {
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'dsh-amd-free-model-push',
}

/** Every file to publish, relative to the package root, sorted by depth. */
function collect(dir = '', out = []) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const rel = dir === '' ? entry.name : `${dir}/${entry.name}`
    if (entry.isDirectory()) collect(rel, out)
    else if (entry.isFile()) out.push(rel)
  }
  return out
}

async function api(pathname, init = {}) {
  const response = await fetch(`${API}${pathname}`, { ...init, headers })
  const text = await response.text()
  let payload
  try { payload = text === '' ? undefined : JSON.parse(text) } catch { payload = { message: text.slice(0, 200) } }
  if (!response.ok) {
    const error = new Error(`${init.method ?? 'GET'} ${pathname} → ${response.status} ${payload?.message ?? ''}`)
    error.status = response.status
    error.payload = payload
    throw error
  }
  return payload
}

const files = collect().sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
console.log(`${files.length} files to publish to ${slug}\n`)

let created = 0
let updated = 0
const failed = []

for (const rel of files) {
  const bytes = fs.readFileSync(path.join(ROOT, rel))
  const body = JSON.stringify({
    message: rel === 'LICENSE'
      // The repository the web UI created already carries an Apache-2.0
      // LICENSE; this commit is where the plugin's own MIT text lands, and it
      // says so in the subject line.
      ? 'Use the plugin MIT license instead of the generated Apache-2.0'
      : `Add ${rel}`,
    content: bytes.toString('base64'),
    branch: 'main',
  })
  // A file the repository already has needs a PUT with its `sha`; a new one is
  // a PUT without it. Probing first keeps this to one call per file either way.
  let existing
  try {
    existing = await api(`/repos/${slug}/contents/${rel}?ref=main`)
  } catch (error) {
    if (error.status !== 404) { failed.push({ rel, error: error.message }); console.log(`  FAILED    ${rel}: ${error.message}`); continue }
  }
  try {
    await api(`/repos/${slug}/contents/${rel}`, {
      method: 'PUT',
      headers: { ...headers, 'content-type': 'application/json' },
      body: existing === undefined ? body : JSON.stringify({ ...JSON.parse(body), sha: existing.sha }),
    })
    const verb = existing === undefined ? 'created' : 'updated'
    if (existing === undefined) created += 1
    else updated += 1
    console.log(`  ${verb.padEnd(8)} ${rel}`)
  } catch (error) {
    failed.push({ rel, error: error.message })
    console.log(`  FAILED    ${rel}: ${error.message}`)
  }
}

console.log(`\n${created} created, ${updated} updated, ${failed.length} failed`)
if (failed.length > 0) {
  console.log('\nfailures:')
  for (const row of failed) console.log(`  ${row.rel}: ${row.error}`)
  process.exitCode = 1
}
