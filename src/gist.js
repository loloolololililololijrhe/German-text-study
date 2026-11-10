// Storing the synced state in a secret GitHub Gist on the learner's own account.

const API = 'https://api.github.com';
export const GIST_FILE = 'german-text-study.json';
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

export async function createGist(token, state) {
  const g = await gh(token, '/gists', {
    method: 'POST',
    body: JSON.stringify({
      description: DESCRIPTION,
      public: false,
      files: { [GIST_FILE]: { content: JSON.stringify(state) } },
    }),
  });
  return g.id;
}

/** Returns the stored state object, or null when the file is missing or unreadable. */
export async function readGist(token, id) {
  const g = await gh(token, `/gists/${id}`);
  const file = g.files?.[GIST_FILE];
  if (!file) return null;
  let content = file.content;
  if (file.truncated && file.raw_url) {
    const res = await fetch(file.raw_url);
    if (!res.ok) throw new GistError(res.status, 'Could not download the synced data from GitHub.');
    content = await res.text();
  }
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export async function writeGist(token, id, state) {
  await gh(token, `/gists/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ files: { [GIST_FILE]: { content: JSON.stringify(state) } } }),
  });
}
