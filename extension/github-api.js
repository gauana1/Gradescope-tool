// github-api.js
const GITHUB_API = 'https://api.github.com';

function ghHeaders(token) {
  return {
    Authorization: `token ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/vnd.github+json',
  };
}

export async function getAuthenticatedUser(token) {
  const res = await fetch(`${GITHUB_API}/user`, { headers: ghHeaders(token) });
  if (!res.ok) throw new Error(`getUser failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function getRepo(token, owner, repo) {
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}`, { headers: ghHeaders(token) });
  if (!res.ok) throw new Error(`getRepo failed: ${res.status}`);
  return res.json();
}

export async function createRepo(token, repoName, { isPrivate = true } = {}) {
  const res = await fetch(`${GITHUB_API}/user/repos`, {
    method: 'POST',
    headers: ghHeaders(token),
    body: JSON.stringify({ name: repoName, private: isPrivate }),
  });
  if (res.status === 422) {
    // Repo already exists — fetch and return it
    const user = await getAuthenticatedUser(token);
    return getRepo(token, user.login, repoName);
  }
  if (!res.ok) throw new Error(`createRepo failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * Initialize an empty repo by creating a placeholder commit via the Contents API.
 * This is the only GitHub API that works on repos with zero commits.
 * Returns { commitSha, branch } so callers can use Git Data API from here on.
 */
export async function initEmptyRepo(token, owner, repo, branch = 'main', readmeContent = '') {
  const content = btoa(unescape(encodeURIComponent(readmeContent || `# ${repo}\n\nArchived from Gradescope.\n`)));
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/README.md`, {
    method: 'PUT',
    headers: ghHeaders(token),
    body: JSON.stringify({ message: 'Initial commit', content, branch }),
  });
  if (!res.ok) throw new Error(`initEmptyRepo failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return { commitSha: data.commit.sha, branch };
}

export async function getDefaultBranchSha(token, owner, repo, branch) {
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/ref/heads/${branch}`, {
    headers: ghHeaders(token),
  });
  if (!res.ok) throw new Error(`getRef failed: ${res.status}`);
  const data = await res.json();
  return data.object.sha;
}

export async function getCommitTreeSha(token, owner, repo, commitSha) {
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/commits/${commitSha}`, {
    headers: ghHeaders(token),
  });
  if (!res.ok) throw new Error(`getCommit failed: ${res.status}`);
  const data = await res.json();
  return data.tree.sha;
}

export async function createBlob(token, owner, repo, content, encoding = 'base64') {
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/blobs`, {
    method: 'POST',
    headers: ghHeaders(token),
    body: JSON.stringify({ content, encoding }),
  });
  if (!res.ok) {
    const responseText = await res.text();
    const retryAfter = res.headers.get('Retry-After');
    const lower = (responseText || '').toLowerCase();

    let message = `createBlob failed: ${res.status} ${responseText}`;
    if (res.status === 413 || lower.includes('too large') || lower.includes('exceeds')) {
      message = `createBlob failed: ${res.status} Blob rejected by GitHub. Ensure callers skip files >50MB before createBlob.`;
    }

    const error = new Error(message);
    error.status = res.status;
    if (retryAfter) {
      const retryAfterSeconds = Number(retryAfter);
      if (Number.isFinite(retryAfterSeconds)) {
        error.retryAfterSeconds = retryAfterSeconds;
      }
    }
    throw error;
  }
  return res.json();
}

export async function createTree(token, owner, repo, tree, baseTreeSha = null) {
  const body = { tree };
  if (baseTreeSha) body.base_tree = baseTreeSha;
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/trees`, {
    method: 'POST',
    headers: ghHeaders(token),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`createTree failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function createCommit(token, owner, repo, message, treeSha, parentShas = []) {
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/commits`, {
    method: 'POST',
    headers: ghHeaders(token),
    body: JSON.stringify({ message, tree: treeSha, parents: parentShas }),
  });
  if (!res.ok) throw new Error(`createCommit failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function updateRef(token, owner, repo, branch, sha, parentSha) {
  const exists = parentSha !== null && parentSha !== undefined;
  const method = exists ? 'PATCH' : 'POST';
  // Use normal fast-forward updates. Force-push can be rejected by repo rules
  // and causes 422 "Reference cannot be updated".
  const body = exists ? { sha } : { ref: `refs/heads/${branch}`, sha };
  const url = exists
    ? `${GITHUB_API}/repos/${owner}/${repo}/git/refs/heads/${branch}`
    : `${GITHUB_API}/repos/${owner}/${repo}/git/refs`;
  const res = await fetch(url, {
    method,
    headers: ghHeaders(token),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`updateRef failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * Validate a GitHub PAT by calling GET /user.
 * Returns { login, name, avatarUrl } on success, throws on failure.
 */
export async function validateToken(token) {
  if (!token || !token.trim()) throw new Error('Token is empty.');
  const res = await fetch(`${GITHUB_API}/user`, { headers: ghHeaders(token) });
  if (res.status === 401) throw new Error('Token rejected — check it has the "repo" scope.');
  if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
  const data = await res.json();
  return { login: data.login, name: data.name, avatarUrl: data.avatar_url };
}
