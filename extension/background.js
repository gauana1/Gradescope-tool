// background.js
import {
  getAuthenticatedUser,
  createRepo,
  getDefaultBranchSha,
  getCommitTreeSha,
  createBlob,
  createTree,
  createCommit,
  updateRef,
} from './github-api.js';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch(err => sendResponse({ error: String(err) }));
  return true; // async response
});

async function handleMessage(message, sender) {
  if (!message || !message.type) return;

  if (message.type === 'INJECT_INJECT_JS') {
    const tabId = sender?.tab?.id;
    if (!tabId) return { ok: false };
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['scraper.js', 'inject.js'],
        world: 'MAIN'
      });
    } catch (error) {
      console.error('background: failed to inject scripts:', error);
    }
    return { ok: true };
  }

  if (message.type === 'COURSES_FOUND') {
    const courses = message.payload || [];
    await chrome.storage.local.set({ courses });
    broadcast({ type: 'COURSES_UPDATED', payload: courses });
    return { ok: true };
  }

  if (message.type === 'START_UPLOAD') {
    const { course_ids } = message.payload || {};
    handleUpload(course_ids); // fire-and-forget, progress sent via broadcast
    return { ok: true, started: true };
  }

  if (message.type === 'REFRESH_COURSES') {
    // Find the Gradescope tab and trigger scraping
    chrome.tabs.query({ url: 'https://*.gradescope.com/*' }, (tabs) => {
      if (tabs.length === 0) {
        broadcast({ type: 'COURSES_UPDATED', payload: [], error: 'No Gradescope tab found' });
        return;
      }
      const tab = tabs[0];
      chrome.tabs.sendMessage(tab.id, { type: 'SCRAPE_COURSES' });
    });
    return { ok: true };
  }
}

async function handleUpload(course_ids) {
  const { githubToken, courses } = await chrome.storage.local.get(['githubToken', 'courses']);

  if (!githubToken) {
    broadcast({
      type: 'UPLOAD_ERROR',
      payload: { error: 'No GitHub token found. Open Options to save one.', retryable: false },
    });
    return;
  }

  let user;
  try {
    user = await getAuthenticatedUser(githubToken);
  } catch (e) {
    console.error('background: GitHub auth failed', e);
    broadcast({
      type: 'UPLOAD_ERROR',
      payload: { error: `GitHub auth failed: ${e.message}`, retryable: false },
    });
    return;
  }

  const selected = (courses || []).filter(c => course_ids.includes(c.course_id));

  for (const course of selected) {
    try {
      await uploadCourse(githubToken, user.login, course);
    } catch (e) {
      broadcast({
        type: 'UPLOAD_ERROR',
        payload: { course_id: course.course_id, error: e.message, retryable: true },
      });
    }
  }
}

async function uploadCourse(token, owner, course) {
  const { course_id, full_name, github_repo: repoName } = course;
  // Always use the current repo name from the course — never override from stale storage

  broadcast({ type: 'UPLOAD_PROGRESS', payload: { course_id, step: 'Creating repository', pct: 10 } });
  const repo = await createRepo(token, repoName, { isPrivate: true });
  // Use the actual name returned by GitHub for subsequent operations
  const actualRepoName = repo.name || repoName;
  const branch = repo.default_branch || 'main';

  broadcast({ type: 'UPLOAD_PROGRESS', payload: { course_id, step: 'Fetching branch info', pct: 30 } });
  let parentSha = null;
  let baseTreeSha = null;
  try {
    parentSha = await getDefaultBranchSha(token, owner, actualRepoName, branch);
    baseTreeSha = await getCommitTreeSha(token, owner, actualRepoName, parentSha);
  } catch (_) {
    // None — repo may be fresh with no commits yet
    parentSha = null;
    baseTreeSha = null;
  }

  broadcast({ type: 'UPLOAD_PROGRESS', payload: { course_id, step: 'Creating files', pct: 50 } });
  const readmeText = `# ${full_name}\n\nArchived from Gradescope.\n\nCourse ID: ${course_id}\nArchived at: ${new Date().toISOString()}\n`;
  const readmeB64 = btoa(unescape(encodeURIComponent(readmeText)));
  const blob = await createBlob(token, owner, actualRepoName, readmeB64, 'base64');

  broadcast({ type: 'UPLOAD_PROGRESS', payload: { course_id, step: 'Committing', pct: 75 } });
  const tree = await createTree(
    token, owner, actualRepoName,
    [{ path: 'README.md', mode: '100644', type: 'blob', sha: blob.sha }],
    baseTreeSha
  );
  const commit = await createCommit(
    token, owner, actualRepoName,
    `Archive ${full_name}`,
    tree.sha,
    parentSha ? [parentSha] : []
  );
  await updateRef(token, owner, actualRepoName, branch, commit.sha, parentSha);

  broadcast({
    type: 'UPLOAD_DONE',
    payload: { course_id, repoUrl: repo.html_url || `https://github.com/${owner}/${actualRepoName}`, sha: commit.sha },
  });

  // Persist status update
  const { courses } = await chrome.storage.local.get('courses');
  const updated = (courses || []).map(c =>
    c.course_id === course_id
      ? { ...c, status: 'done', last_synced: new Date().toISOString() }
      : c
  );
  await chrome.storage.local.set({ courses: updated });

  // Persist mapping from course_id -> repo metadata (name, id, url)
  try {
    const { repoMap: existing = {} } = await chrome.storage.local.get('repoMap');
    existing[course_id] = { name: repo.name, id: repo.id, url: repo.html_url };
    await chrome.storage.local.set({ repoMap: existing });
  } catch (e) {
    // non-fatal
  }
}

function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // Popup may not be open — ignore
  });
}
