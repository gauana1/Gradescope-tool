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
    body: JSON.stringify({ name: repoName, private: isPrivate, auto_init: true }),
  });
  if (res.status === 422) {
    // Repo already exists — fetch and return it
    const user = await getAuthenticatedUser(token);
    return getRepo(token, user.login, repoName);
  }
  if (!res.ok) throw new Error(`createRepo failed: ${res.status} ${await res.text()}`);
  return res.json();
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
  if (!res.ok) throw new Error(`createBlob failed: ${res.status} ${await res.text()}`);
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
  // force:true on PATCH so re-archiving the same course never 422s
  const body = exists ? { sha, force: true } : { ref: `refs/heads/${branch}`, sha };
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
