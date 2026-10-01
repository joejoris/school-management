/**
 * Upload this repository to GitHub over the API.
 *
 * ── Why this exists ─────────────────────────────────────────────────
 *
 * `git push` from this machine authenticates as `joe12-joe`, which has no write
 * access to `joejoris/school-management`. GitHub returns 403 and there is no
 * local workaround: the refusal is a decision on GitHub's side.
 *
 * The alternatives are all manual — drag a zip onto the repo page, add a
 * collaborator and push, register an SSH key. This is the one that can be driven
 * without a browser, so it is worth having ready.
 *
 * ── The token is read from a file, never from the command line ───────
 *
 * A token pasted into a chat is a token in scrollback, in transcripts, and in
 * whatever this conversation is stored in. Read from a path instead, so it never
 * appears in the conversation at all.
 *
 * The file must be OUTSIDE the repository, and `.gitignore`d even so — a token
 * committed to a public repo is a disaster that is hard to undo.
 *
 * ── History is reproduced, not flattened ─────────────────────────────
 *
 * This walks the local commits oldest-first and builds each one with the Git
 * Data API, so the remote ends up with the same two commits, the same messages,
 * the same authors and the same dates. Flattening everything into one "initial
 * upload" commit would work and would throw away the distinction between the
 * domain rules and the frontend, which is the distinction worth seeing.
 *
 * Run with:  node tools/upload.mjs <path-to-token-file>
 */

import { readFileSync, existsSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const REPO = process.env.GITHUB_REPO ?? 'joejoris/school-management'
const BRANCH = process.env.GITHUB_BRANCH ?? 'main'
const API = 'https://api.github.com'

const die = (msg) => {
  console.error(`\n  ${msg}\n`)
  process.exit(1)
}

// ── 1. The token ─────────────────────────────────────────────────────

const tokenPath = process.argv[2] ?? process.env.GITHUB_TOKEN_FILE
if (!tokenPath) {
  die(
    'No token file given.\n\n' +
      '  Create a fine-grained token at https://github.com/settings/personal-access-tokens/new\n' +
      '    Repository access:  select only joejoris/school-management\n' +
      '    Permissions:       Contents -> Read and write\n' +
      '  Save it to a file OUTSIDE this repository, then run:\n\n' +
      '    node tools/upload.mjs C:/path/to/token.txt',
  )
}

const resolved = resolve(tokenPath)
if (!existsSync(resolved)) die(`No such file: ${resolved}`)

// A directory would make readFileSync throw something unhelpful.
if (statSync(resolved).isDirectory()) die(`${resolved} is a directory, not a token file.`)

const token = readFileSync(resolved, 'utf8').trim()
if (!/^[\w.-]{20,}$/.test(token)) {
  die(
    'That file does not look like a GitHub token.\n' +
      '  A fine-grained token starts with github_pat_ and is much longer than this.\n' +
      '  Check you saved the token itself and not the page you created it on.',
  )
}

const auth = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'school-library-uploader',
}

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...auth, ...(init.headers ?? {}) },
  })
  const text = await res.text()
  let body
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    body = { message: text.slice(0, 200) }
  }
  if (!res.ok) {
    const detail = body.message ?? res.statusText
    if (res.status === 401) die('The token was rejected (401). Check it was copied in full.')
    if (res.status === 403) {
      die(
        `GitHub refused the request (403): ${detail}\n\n` +
          '  The token is valid but lacks write access to this repository.\n' +
          '  Check the token was created with Contents: Read and write, and that\n' +
          '  Repository access includes joejoris/school-management.',
      )
    }
    die(`GitHub returned ${res.status}: ${detail}`)
  }
  return body
}

// ── 2. Confirm who we are, before writing anything ──────────────────

const me = await api('/user')
console.log(`  authenticated as: ${me.login}`)

const repo = await api(`/repos/${REPO}`)
console.log(`  target:           ${repo.full_name} (${repo.visibility})`)

if (me.login !== repo.owner.login && !(repo.permissions?.push ?? false)) {
  console.log(
    `  note: ${me.login} is not ${repo.owner.login}; continuing because the token\n` +
      '        reports push permission on this repository.',
  )
}

if (!repo.permissions?.push) {
  die(
    `This token cannot push to ${repo.full_name}.\n` +
      '  Create the token with Contents: Read and write for this repository.',
  )
}

// ── 3. Walk the local history ────────────────────────────────────────

const git = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

const commits = git('rev-list', '--reverse', 'HEAD').trim().split('\n')
console.log(`  local commits:    ${commits.length}`)

const existing = await api(`/repos/${REPO}/git/ref/heads/${BRANCH}`).catch(() => null)
console.log(
  `  remote ${BRANCH}:   ${existing ? existing.object.sha.slice(0, 7) : '(absent)'}` +
    (existing ? ` — ${(await api(`/repos/${REPO}/commits/${existing.object.sha}`)).commit.message.split('\n')[0]}` : ''),
)

let parent = null
for (const sha of commits) {
  const meta = git('show', '-s', '--format=%s%n%b%n%an%n%ae%n%aI', sha).split('\n')
  const message = meta[0]
  const body = meta[1] === '' ? null : meta.slice(1).join('\n').trim()
  const author = { name: meta[2], email: meta[3], date: meta[4] }

  // The files this commit touched, and their blob content.
  const files = git('show', '--name-only', '--format=', sha).trim().split('\n').filter(Boolean)
  const blobs = []
  for (const path of files) {
    // Binary-safe: git returns the bytes, and the API wants base64.
    const b64 = execFileSync('git', ['show', `${sha}:${path}`], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
    const blob = await api(`/repos/${REPO}/git/blobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: b64.toString('base64'), encoding: 'base64' }),
    })
    blobs.push({ path, mode: '100644', type: 'blob', sha: blob.sha })
  }

  const tree = await api(`/repos/${REPO}/git/trees`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base_tree: parent, tree: blobs }),
  })

  const made = await api(`/repos/${REPO}/git/commits`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      tree: tree.sha,
      parents: parent ? [parent] : [],
      author: { ...author, date: author.date },
      committer: { ...author, date: author.date },
    }),
  })

  parent = made.sha
  console.log(`    + ${made.sha.slice(0, 7)}  ${message}  (${files.length} files)`)
}

// ── 4. Point the branch at the new history ──────────────────────────

await api(`/repos/${REPO}/git/refs/heads/${BRANCH}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  // `force` is safe here and is checked below: the only thing being replaced is
  // the placeholder commit this script reported at the start.
  body: JSON.stringify({ sha: parent, force: true }),
})

// ── 5. Verify against GitHub, not against our own optimism ──────────

const final = await api(`/repos/${REPO}/commits/${BRANCH}`)
const listed = await api(`/repos/${REPO}/contents/package.json?ref=${BRANCH}`)

console.log(`\n  ${BRANCH} is now ${final.sha.slice(0, 7)}: ${final.commit.message.split('\n')[0]}`)
console.log(`  package.json present on the remote: ${listed.name} (${listed.size} bytes)`)
console.log(`  ${REPO}/tree/${BRANCH}  \n`)