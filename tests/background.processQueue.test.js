jest.mock('../extension/github-api.js', () => ({
  getAuthenticatedUser: jest.fn().mockResolvedValue({ login: 'tester' }),
  createRepo: jest.fn().mockResolvedValue({
    id: 1,
    name: 'gradescope-course',
    html_url: 'https://github.com/tester/gradescope-course',
    default_branch: 'main',
  }),
  getDefaultBranchSha: jest.fn().mockResolvedValue('parent-sha'),
  getCommitTreeSha: jest.fn().mockResolvedValue('base-tree-sha'),
  createBlob: jest.fn().mockResolvedValue({ sha: 'blob-sha-1' }),
  createTree: jest.fn().mockResolvedValue({ sha: 'tree-sha' }),
  createCommit: jest.fn().mockResolvedValue({ sha: 'commit-sha' }),
  updateRef: jest.fn().mockResolvedValue({ ref: 'refs/heads/main' }),
}));

describe('background queue checkpointing/resume', () => {
  let store;
  let background;

  function createChromeMock() {
    return {
      runtime: {
        onMessage: { addListener: jest.fn() },
        onStartup: { addListener: jest.fn() },
        onInstalled: { addListener: jest.fn() },
        sendMessage: jest.fn().mockResolvedValue(undefined),
      },
      storage: {
        local: {
          get: jest.fn(async (keys) => {
            if (!keys) return { ...store };
            if (typeof keys === 'string') return { [keys]: store[keys] };
            const result = {};
            keys.forEach((key) => { result[key] = store[key]; });
            return result;
          }),
          set: jest.fn(async (obj) => {
            Object.assign(store, obj);
          }),
        },
      },
      tabs: {
        query: jest.fn().mockResolvedValue([{ id: 99 }]),
        sendMessage: jest.fn(async (_tabId, message) => {
          if (message?.type === 'FETCH_FILE' && store.uploadJob?.files?.[0]) {
            store.uploadJob.files[0].status = 'skipped';
          }
          return undefined;
        }),
        connect: jest.fn(() => ({
          onDisconnect: { addListener: jest.fn() },
          disconnect: jest.fn(),
        })),
      },
      scripting: {
        executeScript: jest.fn().mockResolvedValue([{ result: [] }]),
      },
      alarms: {
        onAlarm: { addListener: jest.fn() },
        create: jest.fn().mockResolvedValue(undefined),
        clear: jest.fn().mockResolvedValue(undefined),
      },
    };
  }

  beforeEach(async () => {
    jest.resetModules();
    store = {
      githubToken: 'gh_token',
      uploadJob: {
        courseId: '123',
        repoName: 'gradescope-course',
        visibility: 'private',
        status: 'in_progress',
        owner: 'tester',
        repoUrl: 'https://github.com/tester/gradescope-course',
        branch: 'main',
        readmeBlobSha: 'blob-readme',
        parentSha: 'parent-sha',
        baseTreeSha: 'base-tree-sha',
        tabId: 99,
        files: [{ url: 'https://gradescope.com/file1', path: 'a/file1.pdf', status: 'in_progress' }],
      },
      courses: [{ course_id: '123', full_name: 'Test Course', github_repo: 'gradescope-course', status: 'uploading' }],
    };
    global.chrome = createChromeMock();
    background = require('../extension/background.js');
  });

  test('resumeIfJobPending resets interrupted in_progress file back to pending', async () => {
    await background.resumeIfJobPending();
    expect(store.uploadJob.files[0].status).not.toBe('in_progress');
    expect(chrome.storage.local.set).toHaveBeenCalled();
  });

  test('FILE_TOO_LARGE marks file skipped and checkpoints uploadJob', async () => {
    await background.handleMessage({
      type: 'FILE_TOO_LARGE',
      payload: { path: 'a/file1.pdf', sizeBytes: 70 * 1024 * 1024 },
    }, {});

    expect(store.uploadJob.files[0].status).toBe('skipped');
    expect(chrome.storage.local.set).toHaveBeenCalled();
  });
});
