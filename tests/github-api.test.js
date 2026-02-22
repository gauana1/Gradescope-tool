// github-api.test.js
// Tests for GitHub API helper functions using mocked global.fetch.
// Babel (see babel.config.js) transforms the ES-module exports so Jest can require() them.

const {
  getAuthenticatedUser,
  createRepo,
  getDefaultBranchSha,
  getCommitTreeSha,
  createBlob,
  createTree,
  createCommit,
  updateRef,
} = require('../extension/github-api.js');

const TOKEN = 'ghp_test_token_abc';
const OWNER = 'testuser';
const REPO  = 'gradescope-12345-com-sci-131';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFetchResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: () => null,
    },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function mockFetch(status, body) {
  global.fetch = jest.fn().mockResolvedValue(makeFetchResponse(status, body));
}

afterEach(() => {
  jest.resetAllMocks();
});

// ---------------------------------------------------------------------------
// getAuthenticatedUser
// ---------------------------------------------------------------------------
describe('getAuthenticatedUser', () => {
  test('returns user object on success', async () => {
    mockFetch(200, { login: OWNER, id: 99999 });
    const user = await getAuthenticatedUser(TOKEN);
    expect(user.login).toBe(OWNER);
    expect(user.id).toBe(99999);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.github.com/user',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: `token ${TOKEN}` }),
      })
    );
  });

  test('throws on 401 Unauthorized', async () => {
    mockFetch(401, { message: 'Bad credentials' });
    await expect(getAuthenticatedUser(TOKEN)).rejects.toThrow('getUser failed: 401');
  });
});

// ---------------------------------------------------------------------------
// createRepo
// ---------------------------------------------------------------------------
describe('createRepo', () => {
  test('returns repo on successful creation (201)', async () => {
    mockFetch(201, { id: 42, name: REPO, default_branch: 'main', html_url: `https://github.com/${OWNER}/${REPO}` });
    const repo = await createRepo(TOKEN, REPO, { isPrivate: true });
    expect(repo.name).toBe(REPO);
    expect(repo.default_branch).toBe('main');
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.private).toBe(true);
    expect(body.auto_init).toBe(true);
  });

  test('on 422 (already exists) falls back to fetching existing repo', async () => {
    global.fetch = jest.fn()
      // 1st call: POST /user/repos → 422
      .mockResolvedValueOnce(makeFetchResponse(422, {}))
      // 2nd call: GET /user → returns authenticated user
      .mockResolvedValueOnce(makeFetchResponse(200, { login: OWNER }))
      // 3rd call: GET /repos/{owner}/{repo} → existing repo
      .mockResolvedValueOnce(makeFetchResponse(200, { id: 55, name: REPO, default_branch: 'main', html_url: `https://github.com/${OWNER}/${REPO}` }));

    const repo = await createRepo(TOKEN, REPO);
    expect(repo.name).toBe(REPO);
    expect(repo.id).toBe(55);
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  test('throws on non-422 error (500)', async () => {
    mockFetch(500, { message: 'Internal Server Error' });
    await expect(createRepo(TOKEN, REPO)).rejects.toThrow('createRepo failed: 500');
  });

  test('defaults to private repo', async () => {
    mockFetch(201, { id: 1, name: REPO, default_branch: 'main' });
    await createRepo(TOKEN, REPO); // no options passed
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.private).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createBlob
// ---------------------------------------------------------------------------
describe('createBlob', () => {
  test('returns blob sha on success', async () => {
    mockFetch(201, { sha: 'blobsha123', url: 'https://api.github.com/repos/...' });
    const blob = await createBlob(TOKEN, OWNER, REPO, 'SGVsbG8=', 'base64');
    expect(blob.sha).toBe('blobsha123');
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.encoding).toBe('base64');
  });

  test('defaults encoding to base64', async () => {
    mockFetch(201, { sha: 'blobsha456' });
    await createBlob(TOKEN, OWNER, REPO, 'SGVsbG8=');
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.encoding).toBe('base64');
  });

  test('throws on failure', async () => {
    mockFetch(422, { message: 'content not properly encoded' });
    await expect(createBlob(TOKEN, OWNER, REPO, 'bad', 'base64')).rejects.toThrow('createBlob failed: 422');
  });

  test('throws clear error for oversized blobs', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 413,
      headers: { get: () => null },
      text: () => Promise.resolve('Payload too large'),
    });

    await expect(createBlob(TOKEN, OWNER, REPO, 'bad', 'base64')).rejects.toThrow('Ensure callers skip files >50MB');
  });

  test('attaches retryAfterSeconds on rate limit responses', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 403,
      headers: { get: (name) => (name === 'Retry-After' ? '15' : null) },
      text: () => Promise.resolve('Rate limited'),
    });

    try {
      await createBlob(TOKEN, OWNER, REPO, 'data', 'base64');
      throw new Error('Expected createBlob to throw');
    } catch (error) {
      expect(error.retryAfterSeconds).toBe(15);
    }
  });
});

// ---------------------------------------------------------------------------
// createTree
// ---------------------------------------------------------------------------
describe('createTree', () => {
  const treeEntries = [{ path: 'README.md', mode: '100644', type: 'blob', sha: 'blobsha' }];

  test('creates tree and returns sha', async () => {
    mockFetch(201, { sha: 'treesha789' });
    const tree = await createTree(TOKEN, OWNER, REPO, treeEntries);
    expect(tree.sha).toBe('treesha789');
  });

  test('does NOT include base_tree when none is given', async () => {
    mockFetch(201, { sha: 'treesha' });
    await createTree(TOKEN, OWNER, REPO, treeEntries);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.base_tree).toBeUndefined();
  });

  test('includes base_tree when provided', async () => {
    mockFetch(201, { sha: 'treesha2' });
    await createTree(TOKEN, OWNER, REPO, treeEntries, 'parentTreeSha');
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.base_tree).toBe('parentTreeSha');
  });

  test('throws on failure', async () => {
    mockFetch(422, {});
    await expect(createTree(TOKEN, OWNER, REPO, treeEntries)).rejects.toThrow('createTree failed: 422');
  });
});

// ---------------------------------------------------------------------------
// createCommit
// ---------------------------------------------------------------------------
describe('createCommit', () => {
  test('creates commit with message, tree, and parents', async () => {
    mockFetch(201, { sha: 'commitsha001' });
    const commit = await createCommit(TOKEN, OWNER, REPO, 'Archive CS 131', 'treeSha', ['parentSha']);
    expect(commit.sha).toBe('commitsha001');
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.message).toBe('Archive CS 131');
    expect(body.tree).toBe('treeSha');
    expect(body.parents).toEqual(['parentSha']);
  });

  test('creates initial commit with empty parents list', async () => {
    mockFetch(201, { sha: 'commitsha002' });
    await createCommit(TOKEN, OWNER, REPO, 'Initial', 'treeSha', []);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.parents).toEqual([]);
  });

  test('throws on failure', async () => {
    mockFetch(404, {});
    await expect(createCommit(TOKEN, OWNER, REPO, 'msg', 'treeSha', [])).rejects.toThrow('createCommit failed: 404');
  });
});

// ---------------------------------------------------------------------------
// updateRef
// ---------------------------------------------------------------------------
describe('updateRef', () => {
  test('updates branch ref and returns result', async () => {
    mockFetch(200, { ref: 'refs/heads/main', object: { sha: 'commitsha001' } });
    const result = await updateRef(TOKEN, OWNER, REPO, 'main', 'commitsha001', 'parentsha');
    expect(result.ref).toBe('refs/heads/main');
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.sha).toBe('commitsha001');
    expect(body.force).toBeUndefined();
  });

  test('calls the correct URL for the branch', async () => {
    mockFetch(200, { ref: 'refs/heads/main' });
    await updateRef(TOKEN, OWNER, REPO, 'main', 'sha', 'parentsha');
    const url = global.fetch.mock.calls[0][0];
    expect(url).toContain(`/repos/${OWNER}/${REPO}/git/refs/heads/main`);
  });

  test('creates new branch ref when parentSha is null', async () => {
    mockFetch(200, { ref: 'refs/heads/main' });
    await updateRef(TOKEN, OWNER, REPO, 'main', 'sha', null);
    const url = global.fetch.mock.calls[0][0];
    expect(url).toContain(`/repos/${OWNER}/${REPO}/git/refs`);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.ref).toBe('refs/heads/main');
    expect(body.sha).toBe('sha');
  });

  test('throws on failure', async () => {
    mockFetch(422, {});
    await expect(updateRef(TOKEN, OWNER, REPO, 'main', 'bad', 'parentsha')).rejects.toThrow('updateRef failed: 422');
  });
});

// ---------------------------------------------------------------------------
// getDefaultBranchSha
// ---------------------------------------------------------------------------
describe('getDefaultBranchSha', () => {
  test('returns sha of branch tip', async () => {
    mockFetch(200, { ref: 'refs/heads/main', object: { sha: 'tipSha' } });
    const sha = await getDefaultBranchSha(TOKEN, OWNER, REPO, 'main');
    expect(sha).toBe('tipSha');
  });

  test('throws on failure', async () => {
    mockFetch(404, {});
    await expect(getDefaultBranchSha(TOKEN, OWNER, REPO, 'main')).rejects.toThrow('getRef failed: 404');
  });
});

// ---------------------------------------------------------------------------
// getCommitTreeSha
// ---------------------------------------------------------------------------
describe('getCommitTreeSha', () => {
  test('returns tree sha of a commit', async () => {
    mockFetch(200, { sha: 'commitSha', tree: { sha: 'treeShaFromCommit' } });
    const sha = await getCommitTreeSha(TOKEN, OWNER, REPO, 'commitSha');
    expect(sha).toBe('treeShaFromCommit');
  });

  test('throws on failure', async () => {
    mockFetch(404, {});
    await expect(getCommitTreeSha(TOKEN, OWNER, REPO, 'bad')).rejects.toThrow('getCommit failed: 404');
  });
});
