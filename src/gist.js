// Storing the synced state in a secret GitHub Gist on the learner's own account.

const API = 'https://api.github.com';
export const GIST_FILE = 'german-text-study.json';
/** Past texts live in a second file of the same gist, so progress syncs stay small. */
export const TEXTS_FILE = 'german-text-study-texts.json';
const DESCRIPTION = 'German Text Study progress (synced automatically by the app)';

export class GistError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function gh(token, path, options = {}) {
  let res;
  try {
    res = await fetch(path.startsWith('http') ? path : API + path, {
      ...options,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
  } catch {
    throw new GistError(0, 'Could not reach GitHub. Check your internet connection.');
  }
  if (res.ok) return res.json();
  if (res.status === 401) throw new GistError(401, 'GitHub rejected the token. Create a new one and paste it again.');
  if (res.status === 403 || res.status === 404) {
    const missing = res.status === 404 && /\/gists\/[0-9a-f]+$/i.test(path);
    throw new GistError(
      res.status,
      missing
        ? 'The sync gist no longer exists.'
        : 'The token is not allowed to use gists. It needs the "gist" permission.',
    );
  }
  throw new GistError(res.status, `GitHub returned an error (${res.status}).`);
}

/** Find the gist this app created earlier with this account, if any. */
export async function findGist(token) {
  for (let page = 1; page <= 5; page++) {
    const list = await gh(token, `/gists?per_page=100&page=${page}`);
    const hit = list.find((g) => g.files && g.files[GIST_FILE]);
    if (hit) return hit.id;
    if (list.length < 100) break;
  }
  return null;
}

const asFiles = (files) =>
  Object.fromEntries(Object.entries(files).map(([name, value]) => [name, { content: JSON.stringify(value) }]));

/** Create the gist with the given files: { fileName: object }. */
export async function createGist(token, files) {
  const g = await gh(token, '/gists', {
    method: 'POST',
    body: JSON.stringify({ description: DESCRIPTION, public: false, files: asFiles(files) }),
  });
  return g.id;
}

/** The parsed content of each of the app's files: { fileName: object | null }. */
export async function readGist(token, id) {
  const g = await gh(token, `/gists/${id}`);
  const out = {};
  for (const name of [GIST_FILE, TEXTS_FILE]) {
    const file = g.files?.[name];
    out[name] = null;
    if (!file) continue;
    let content = file.content;
    // GitHub cuts long files off in this response and serves them whole elsewhere.
    if (file.truncated && file.raw_url) {
      const res = await fetch(file.raw_url);
      if (!res.ok) throw new GistError(res.status, 'Could not download the synced data from GitHub.');
      content = await res.text();
    }
    try {
      out[name] = JSON.parse(content);
    } catch {
      /* unreadable: treated as missing */
    }
  }
  return out;
}

/** Write the given files, leaving the gist's other files as they are. */
export async function writeGist(token, id, files) {
  await gh(token, `/gists/${id}`, { method: 'PATCH', body: JSON.stringify({ files: asFiles(files) }) });
}
