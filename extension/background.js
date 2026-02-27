// background.js
import {
  getAuthenticatedUser,
  createRepo,
  getDefaultBranchSha,
  initEmptyRepo,
  createBlob,
  createTree,
  createCommit,
  updateRef,
} from './github-api.js';

const INJECT_SOURCE = 'gradescope-archiver-inject';
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;
const RESUME_ALARM = 'resume-upload-job';
const RETRY_ALARM = 'retry-upload-job';
const FETCH_TIMEOUT_MS = 180000;

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message, sender)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: String(err) }));
    return true;
  });

  chrome.runtime.onStartup.addListener(() => {
    resumeIfJobPending();
  });

  chrome.runtime.onInstalled.addListener(() => {
    resumeIfJobPending();
  });

  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (!alarm || (alarm.name !== RESUME_ALARM && alarm.name !== RETRY_ALARM)) return;
    await resumeIfJobPending();
  });
}

export async function handleMessage(message, sender) {
  if (!message || !message.type) return { ok: false };

  if (message.type === 'INJECT_INJECT_JS') {
    const tabId = sender?.tab?.id;
    if (!tabId) return { ok: false };
    await ensureInjectScripts(tabId);
    return { ok: true };
  }

  if (message.type === 'COURSES_FOUND') {
    const courses = message.payload || [];
    await chrome.storage.local.set({ courses });
    broadcast({ type: 'COURSES_UPDATED', payload: courses });
    return { ok: true };
  }

  if (message.type === 'REFRESH_COURSES') {
    let tabId = await findGradescopeTabId();
    if (!tabId) {
      // No GS tab open — open the dashboard so the user is logged in and courses can be scraped
      try {
        const tab = await chrome.tabs.create({ url: 'https://www.gradescope.com/', active: true });
        await waitForTabLoad(tab.id, 30000);
        tabId = tab.id;
      } catch (err) {
        broadcast({ type: 'COURSES_UPDATED', payload: [], error: 'Could not open Gradescope tab' });
        return { ok: false };
      }
    }
    await ensureInjectScripts(tabId);
    await sendTabMessage(tabId, { type: 'SCRAPE_COURSES' });
    return { ok: true };
  }

  if (message.type === 'START_UPLOAD') {
    const payload = message.payload || {};
    const courseId = payload.course_id || null;
    if (!courseId) return { ok: false, error: 'Missing course_id' };
    await startUpload(courseId, sender?.tab?.id || null);
    return { ok: true, started: true };
  }

  if (message.type === 'CANCEL_UPLOAD') {
    await cancelUpload(message.payload?.course_id || null);
    return { ok: true };
  }

  if (message.type === 'RETRY_FILE') {
    await retryFile(message.payload?.course_id || null);
    return { ok: true };
  }

  if (message.type === 'KEEPALIVE_DISCONNECTED') {
    await scheduleAlarm(RESUME_ALARM, Date.now() + 3000);
    return { ok: true };
  }

  if (message.type === 'FILE_DATA') {
    await onFileData(message.payload || {});
    return { ok: true };
  }

  if (message.type === 'FILE_TOO_LARGE') {
    await onFileTooLarge(message.payload || {});
    return { ok: true };
  }

  if (message.type === 'FETCH_PROGRESS' || message.type === 'UPLOAD_PROGRESS') {
    await onFetchProgress(message.payload || {});
    return { ok: true };
  }

  if (message.type === 'FETCH_ERROR') {
    await markFileError(message.payload?.path, message.payload?.error || 'Fetch failed');
    return { ok: true };
  }

  if (message.type === 'VALIDATE_TOKEN') {
    const { token } = message.payload || {};
    if (!token) return { ok: false, error: 'No token provided.' };
    try {
      const data = await getAuthenticatedUser(token);
      return { ok: true, user: { login: data.login, name: data.name, avatarUrl: data.avatar_url } };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }

  return { ok: false, ignored: true };
}

export async function startUpload(courseId, preferredTabId = null) {
  const { githubToken, courses } = await chrome.storage.local.get(['githubToken', 'courses']);
  if (!githubToken) {
    broadcast({
      type: 'UPLOAD_ERROR',
      payload: { course_id: courseId, error: 'No GitHub token found. Open Options to save one.', retryable: false },
    });
    return;
  }

  const course = (courses || []).find((entry) => entry.course_id === courseId);
  if (!course) {
    broadcast({
      type: 'UPLOAD_ERROR',
      payload: { course_id: courseId, error: `Course ${courseId} not found`, retryable: false },
    });
    return;
  }

  let tabId = preferredTabId;
  if (!tabId) {
    try {
      tabId = await ensureCourseTab(courseId);
    } catch (err) {
      broadcast({
        type: 'UPLOAD_ERROR',
        payload: { course_id: courseId, error: `Could not open Gradescope tab: ${err.message}`, retryable: true },
      });
      return;
    }
  }

  await ensureInjectScripts(tabId);
  await setCourseStatus(courseId, 'uploading');

  // Derive a safe repo name: prefer course.github_repo, fall back to slugifying short_name/full_name.
  const repoName = course.github_repo
    || slugify(course.short_name || course.full_name || courseId)
    || `gradescope-${courseId}`;

  const initialJob = {
    courseId,
    repoName,
    visibility: 'private',
    status: 'in_progress',
    tabId,
    files: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await chrome.storage.local.set({ uploadJob: initialJob });
  await reportProgress(courseId, 'Enumerating assignment files', 1);

  let fileEntries = [];
  try {
    fileEntries = await enumerateCourseFiles(tabId, courseId);
  } catch (error) {
    await chrome.storage.local.set({
      uploadJob: {
        ...initialJob,
        status: 'error',
        error: error?.message || String(error),
        updatedAt: new Date().toISOString(),
      },
    });
    broadcast({
      type: 'UPLOAD_ERROR',
      payload: { course_id: courseId, error: `Failed to enumerate files: ${error?.message || String(error)}`, retryable: true },
    });
    return;
  }

  const files = (fileEntries || []).map((entry) => ({
    url: entry.url,
    path: entry.path,
    status: 'pending',
  }));

  const uploadJob = {
    ...initialJob,
    files,
    updatedAt: new Date().toISOString(),
  };

  await chrome.storage.local.set({ uploadJob });
  await reportProgress(courseId, files.length ? 'Queued files' : 'No files found in this course', files.length ? 2 : 0);
  if (!files.length) {
    await chrome.storage.local.set({
      uploadJob: {
        ...uploadJob,
        status: 'error',
        error: 'No downloadable files found for this course',
        updatedAt: new Date().toISOString(),
      },
    });
    await setCourseStatus(courseId, 'error');
    broadcast({
      type: 'UPLOAD_ERROR',
      payload: { course_id: courseId, error: 'No downloadable files found for this course', retryable: true },
    });
    return;
  }
  await processQueue();
}

export async function processQueue() {
  const { uploadJob } = await chrome.storage.local.get('uploadJob');
  if (!uploadJob || uploadJob.status !== 'in_progress') return;

  const workingJob = await ensureRepoInitialized(uploadJob);
  if (!workingJob || workingJob.status !== 'in_progress') return;

  const hasInProgress = (workingJob.files || []).some((file) => file.status === 'in_progress');
  if (hasInProgress) return;

  const nextIndex = (workingJob.files || []).findIndex((file) => file.status === 'pending');
  if (nextIndex === -1) {
    await finalizeUpload(workingJob);
    return;
  }

  await processNextFile(nextIndex);
}

export async function processNextFile(index) {
  const { uploadJob } = await chrome.storage.local.get('uploadJob');
  if (!uploadJob || uploadJob.status !== 'in_progress') return;
  const file = uploadJob.files?.[index];
  if (!file) return;

  uploadJob.files[index] = { ...file, status: 'in_progress', updatedAt: new Date().toISOString() };
  uploadJob.updatedAt = new Date().toISOString();
  await checkpointJob(uploadJob);
  await reportProgress(uploadJob.courseId, `Downloading ${file.path}`, computeOverallPct(uploadJob));

  try {
    // Fetch the file directly from the service worker.
    // Extension service workers share the browser cookie store (credentials work)
    // and are not subject to CORS — they bypass it for URLs in host_permissions.
    // This avoids the CORS block that happens when inject.js (page context) follows
    // a Gradescope → S3 redirect.
    const { b64, mimeType, filename: fetchedFilename } = await fetchFileDirectly(file.url);

    // Re-read job after the (potentially slow) fetch — SW may have been restarted
    const { uploadJob: currentJob, githubToken } = await chrome.storage.local.get(['uploadJob', 'githubToken']);
    if (!currentJob || currentJob.status !== 'in_progress') return;

    await reportProgress(currentJob.courseId, `Creating blob for ${file.path}`, computeOverallPct(currentJob));
    const { sha: blobSha } = await createBlob(githubToken, currentJob.owner, currentJob.repoName, b64, 'base64');

    const fileIndex = (currentJob.files || []).findIndex((f) => f.path === file.path && f.status === 'in_progress');
    if (fileIndex !== -1) {
      currentJob.files[fileIndex] = {
        ...currentJob.files[fileIndex],
        status: 'done',
        blobSha,
        mimeType,
        filename: fetchedFilename || filenameFromPath(file.path),
        updatedAt: new Date().toISOString(),
      };
      currentJob.updatedAt = new Date().toISOString();
      await checkpointJob(currentJob);
    }
  } catch (error) {
    await markFileError(file.path, error.message || String(error));
    await scheduleAlarm(RESUME_ALARM, Date.now() + 5000);
  }

  await processQueue();
}

async function onFileData(payload) {
  const { path, b64, filename, mimeType } = payload;
  const { uploadJob, githubToken } = await chrome.storage.local.get(['uploadJob', 'githubToken']);
  if (!uploadJob || uploadJob.status !== 'in_progress') return;

  // Match by path with in_progress status (normal case), OR by url (covers the SW-restart
  // race where the file was reset to 'pending' before FILE_DATA arrived, then re-sent to
  // inject.js, and both fetches return data — accept whichever arrives first).
  let fileIndex = (uploadJob.files || []).findIndex((entry) => entry.path === path && entry.status === 'in_progress');
  if (fileIndex === -1) {
    // Try matching by url in case path was mutated by a prior attempt
    const urlFromPayload = payload.url || '';
    if (urlFromPayload) {
      fileIndex = (uploadJob.files || []).findIndex(
        (entry) => entry.url === urlFromPayload && (entry.status === 'in_progress' || entry.status === 'pending')
      );
    }
  }
  if (fileIndex === -1) {
    debugLog('[Archiver] FILE_DATA no matching file (already done or path mismatch)', { path, url: payload.url, statuses: (uploadJob.files || []).map((f) => ({ path: f.path, status: f.status })) });
    return;
  }
  // If the matched file is still pending (SW restart race), promote it to in_progress now
  if (uploadJob.files[fileIndex].status === 'pending') {
    uploadJob.files[fileIndex] = { ...uploadJob.files[fileIndex], status: 'in_progress', updatedAt: new Date().toISOString() };
    uploadJob.updatedAt = new Date().toISOString();
    await checkpointJob(uploadJob);
  }
  const fileEntry = uploadJob.files[fileIndex];
  // If we received a JSON or HTML response where a binary (PDF) is expected,
  // attempt alternate download URL patterns rather than uploading the JSON.
  const mime = (mimeType || '').toLowerCase();
  const payloadLooksText = looksLikeTextPayloadB64(b64);
  const payloadSig = String(b64 || '').slice(0, 12);
  debugLog('[Archiver] FILE_DATA', {
    path,
    url: fileEntry?.url,
    mimeType,
    filename,
    payloadLooksText,
    payloadSig,
  });
  const looksLikeJson = mime.includes('application/json') || mime.includes('text/html') || payloadLooksText;
  if (looksLikeJson) {
    const originalUrl = fileEntry.url || '';
    const tried = fileEntry.triedUrls || [originalUrl];

    // First, attempt to parse the returned payload for embedded download links.
    const extracted = extractDownloadUrlFromJsonB64(b64);
    if (extracted && !tried.includes(extracted)) {
      const alternates = [extracted, ...deriveAlternateSubmissionUrls(originalUrl)].filter((u) => !tried.includes(u));
      if (alternates.length > 0) {
        uploadJob.files[fileIndex] = {
          ...fileEntry,
          status: 'pending',
          triedUrls: [...tried, alternates[0]],
          url: alternates[0],
          error: `Received non-file payload (${mimeType || 'unknown'}); retrying with extracted URL`,
          updatedAt: new Date().toISOString(),
        };
        uploadJob.updatedAt = new Date().toISOString();
        await checkpointJob(uploadJob);
        await reportProgress(uploadJob.courseId, `Retrying ${path} with extracted URL`, computeOverallPct(uploadJob));
        await scheduleAlarm(RESUME_ALARM, Date.now() + 800);
        return;
      }
    }

    const alternates = deriveAlternateSubmissionUrls(originalUrl).filter((u) => !tried.includes(u));
    if (alternates.length > 0) {
      // Replace the URL with the next candidate and mark pending so the queue will retry it
      uploadJob.files[fileIndex] = {
        ...fileEntry,
        status: 'pending',
        triedUrls: [...tried, alternates[0]],
        url: alternates[0],
        error: `Received non-file payload (${mimeType || 'unknown'}); retrying with alternate URL`,
        updatedAt: new Date().toISOString(),
      };
      uploadJob.updatedAt = new Date().toISOString();
      await checkpointJob(uploadJob);
      await reportProgress(uploadJob.courseId, `Retrying ${path} with alternate URL`, computeOverallPct(uploadJob));
      // Schedule immediate resume
      await scheduleAlarm(RESUME_ALARM, Date.now() + 800);
      return;
    }
    // No alternates left — mark as error (avoid uploading JSON blobs as files)
    uploadJob.files[fileIndex] = {
      ...fileEntry,
      status: 'error',
      error: `Unexpected non-file payload: ${mimeType || 'unknown'}`,
      updatedAt: new Date().toISOString(),
    };
    uploadJob.updatedAt = new Date().toISOString();
    await checkpointJob(uploadJob);
    broadcast({
      type: 'UPLOAD_ERROR',
      payload: { course_id: uploadJob.courseId, error: `Unexpected non-file payload for ${path}: ${mimeType || 'unknown'}`, retryable: true },
    });
    return;
  }

  try {
    await reportProgress(uploadJob.courseId, `Creating blob for ${path}`, computeOverallPct(uploadJob));

    // Patch filename/path with correct extension derived from the actual mimeType,
    // since Gradescope download URLs often have no extension (e.g. /download, /submissions/123).
    // Priority: Content-Type mime → filename from Content-Disposition (already in `filename`) → path
    const resolvedFilename = filename || filenameFromPath(path);
    const isSubmissionUrl = /\/submissions\/\d+/.test(String(fileEntry?.url || ''));
    const ext = extFromMime(mime)
      || extFromPath(resolvedFilename)
      || extFromPath(path)
      || extFromMagicBytes(b64)
      || (isSubmissionUrl ? '.pdf' : '');
    const finalPath = ensureExtension(path, ext);
    const finalFilename = ensureExtension(resolvedFilename, ext);
    debugLog('[Archiver] FILE_DATA resolved', {
      path,
      resolvedFilename,
      ext,
      finalPath,
      finalFilename,
      isSubmissionUrl,
    });

    const blob = await createBlob(githubToken, uploadJob.owner, uploadJob.repoName, b64, 'base64');
    uploadJob.files[fileIndex] = {
      ...uploadJob.files[fileIndex],
      status: 'done',
      blobSha: blob.sha,
      originalPath: uploadJob.files[fileIndex].originalPath || uploadJob.files[fileIndex].path,
      path: finalPath,
      filename: finalFilename,
      mimeType: mimeType || 'application/octet-stream',
      updatedAt: new Date().toISOString(),
    };
    uploadJob.updatedAt = new Date().toISOString();
    await checkpointJob(uploadJob);
    await reportProgress(uploadJob.courseId, `Uploaded ${finalPath}`, computeOverallPct(uploadJob));
  } catch (error) {
    const retryAfterSeconds = Number(error?.retryAfterSeconds || 0);
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
      uploadJob.files[fileIndex] = {
        ...uploadJob.files[fileIndex],
        status: 'pending',
        error: `Rate limited. Retry in ${retryAfterSeconds}s`,
        updatedAt: new Date().toISOString(),
      };
      uploadJob.updatedAt = new Date().toISOString();
      await checkpointJob(uploadJob);
      await scheduleAlarm(RETRY_ALARM, Date.now() + retryAfterSeconds * 1000);
      return;
    }
    uploadJob.files[fileIndex] = {
      ...uploadJob.files[fileIndex],
      status: 'error',
      error: error.message || String(error),
      updatedAt: new Date().toISOString(),
    };
    uploadJob.updatedAt = new Date().toISOString();
    await checkpointJob(uploadJob);
    broadcast({
      type: 'UPLOAD_ERROR',
      payload: { course_id: uploadJob.courseId, error: error.message || String(error), retryable: true },
    });
  }
}

async function onFileTooLarge(payload) {
  const { path, sizeBytes } = payload;
  const { uploadJob } = await chrome.storage.local.get('uploadJob');
  if (!uploadJob || uploadJob.status !== 'in_progress') return;

  const index = (uploadJob.files || []).findIndex((entry) => entry.path === path && entry.status === 'in_progress');
  if (index === -1) return;

  uploadJob.files[index] = {
    ...uploadJob.files[index],
    status: 'skipped',
    sizeBytes: sizeBytes || 0,
    error: `Skipped (> 50MB)` ,
    updatedAt: new Date().toISOString(),
  };
  uploadJob.updatedAt = new Date().toISOString();
  await checkpointJob(uploadJob);
  await reportProgress(uploadJob.courseId, `Skipped ${uploadJob.files[index].path} (>50MB)`, computeOverallPct(uploadJob));
}

async function onFetchProgress(payload) {
  const { path, pct = 0 } = payload;
  const { uploadJob } = await chrome.storage.local.get('uploadJob');
  if (!uploadJob || uploadJob.status !== 'in_progress') return;
  const safePct = Math.max(0, Math.min(100, Number(pct) || 0));
  const overall = computeOverallPct(uploadJob, safePct);
  await reportProgress(uploadJob.courseId, `Downloading ${path || 'file'} (${safePct}%)`, overall);
}

async function ensureRepoInitialized(job) {
  if (job.owner && job.repoUrl && job.branch) return job;
  const { githubToken, courses } = await chrome.storage.local.get(['githubToken', 'courses']);
  let user;
  try {
    user = await getAuthenticatedUser(githubToken);
  } catch (error) {
    broadcast({
      type: 'UPLOAD_ERROR',
      payload: { course_id: job.courseId, error: `GitHub auth failed: ${error.message}`, retryable: false },
    });
    return null;
  }

  await reportProgress(job.courseId, 'Creating repository', 3);
  const repo = await createRepo(githubToken, job.repoName, { isPrivate: job.visibility !== 'public' });

  const branch = repo.default_branch || 'main';
  let parentSha = null;
  try {
    parentSha = await getDefaultBranchSha(githubToken, user.login, repo.name, branch);
  } catch (_) {
    parentSha = null;
  }

  // Empty repo — GitHub's Git Data API (createBlob/createTree) returns 409 until
  // at least one commit exists. Use the Contents API to make the initial commit.
  if (!parentSha) {
    try {
      const fullName = ((courses || []).find((c) => c.course_id === job.courseId)?.full_name) || job.courseId;
      const { commitSha } = await initEmptyRepo(
        githubToken, user.login, repo.name, branch,
        `# ${fullName}\n\nArchived from Gradescope.\n`,
      );
      parentSha = commitSha;
    } catch (initErr) {
      debugLog('[Archiver] initEmptyRepo failed', { error: initErr?.message });
      // Non-fatal — finalizeUpload will try with parents: [] which handles this
    }
  }

  const nextJob = {
    ...job,
    owner: user.login,
    repoName: repo.name,
    repoUrl: repo.html_url,
    repoId: repo.id,
    branch,
    parentSha,
    updatedAt: new Date().toISOString(),
  };

  await checkpointJob(nextJob);
  return nextJob;
}

async function finalizeUpload(job) {
  const { githubToken, courses, repoMap: existingRepoMap = {} } = await chrome.storage.local.get(['githubToken', 'courses', 'repoMap']);
  const files = (job.files || []).filter((entry) => entry.status === 'done' && entry.blobSha);

  // Guard: exclude any add entry whose blobSha is missing
  const addEntries = files
    .filter((entry) => entry.blobSha)
    .map((entry) => ({ path: entry.path, mode: '100644', type: 'blob', sha: entry.blobSha }));

  let commit = null;
  let lastFinalizeError = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      // Re-create the README blob fresh on every attempt.
      // Using the blob SHA from ensureRepoInitialized causes GitRPC::BadObjectState
      // because those objects were created right after auto_init and may not be
      // fully replicated on GitHub's backend yet.
      await reportProgress(job.courseId, `Preparing README (attempt ${attempt})`, 92);
      const fullName = ((courses || []).find((c) => c.course_id === job.courseId)?.full_name) || job.courseId;
      const readmeText = `# ${fullName}\n\nArchived from Gradescope.\n\nCourse ID: ${job.courseId}\nArchived at: ${new Date().toISOString()}\n`;
      const readmeB64 = btoa(unescape(encodeURIComponent(readmeText)));
      const readmeBlob = await createBlob(githubToken, job.owner, job.repoName, readmeB64, 'base64');

      // Always use base_tree: null — we're building a complete course snapshot,
      // so we don't need to inherit from the auto_init commit. This is the only
      // reliable way to avoid GitRPC::BadObjectState on freshly-created repos.
      const treeEntries = [
        { path: 'README.md', mode: '100644', type: 'blob', sha: readmeBlob.sha },
        ...addEntries,
      ];

      let latestParentSha = null;
      try {
        latestParentSha = await getDefaultBranchSha(githubToken, job.owner, job.repoName, job.branch || 'main');
      } catch (_) {
        latestParentSha = job.parentSha || null;
      }

      debugLog('[Archiver] finalizeUpload tree entries', {
        attempt,
        addedFiles: files.map((entry) => entry.path),
        latestParentSha,
      });

      await reportProgress(job.courseId, `Creating commit tree (attempt ${attempt})`, 94);
      const tree = await createTree(githubToken, job.owner, job.repoName, treeEntries, null);

      await reportProgress(job.courseId, `Creating commit (attempt ${attempt})`, 97);
      commit = await createCommit(
        githubToken,
        job.owner,
        job.repoName,
        `Archive course ${job.courseId}`,
        tree.sha,
        latestParentSha ? [latestParentSha] : []
      );

      await updateRef(githubToken, job.owner, job.repoName, job.branch || 'main', commit.sha, latestParentSha || null);
      lastFinalizeError = null;
      break;
    } catch (error) {
      lastFinalizeError = error;
      debugLog('[Archiver] finalizeUpload attempt failed', {
        attempt,
        error: error?.message || String(error),
      });
      await sleep(500 * attempt);
    }
  }

  if (lastFinalizeError || !commit) {
    const errorText = lastFinalizeError?.message || 'Finalize upload failed';
    await chrome.storage.local.set({
      uploadJob: { ...job, status: 'error', error: errorText, updatedAt: new Date().toISOString() },
    });
    await setCourseStatus(job.courseId, 'error');
    broadcast({
      type: 'UPLOAD_ERROR',
      payload: { course_id: job.courseId, error: errorText, retryable: true },
    });
    throw lastFinalizeError || new Error(errorText);
  }

  const updatedCourses = (courses || []).map((course) =>
    course.course_id === job.courseId
      ? { ...course, status: 'done', last_synced: new Date().toISOString() }
      : course
  );

  existingRepoMap[job.courseId] = { name: job.repoName, id: job.repoId, url: job.repoUrl };

  await chrome.storage.local.set({
    courses: updatedCourses,
    repoMap: existingRepoMap,
    uploadJob: { ...job, status: 'done', updatedAt: new Date().toISOString() },
  });

  await reportProgress(job.courseId, 'Upload complete', 100);
  broadcast({
    type: 'UPLOAD_DONE',
    payload: { course_id: job.courseId, repoUrl: job.repoUrl, sha: commit.sha },
  });
  await chrome.alarms.clear(RESUME_ALARM);
  await chrome.alarms.clear(RETRY_ALARM);
}

export async function resumeIfJobPending() {
  const { uploadJob } = await chrome.storage.local.get('uploadJob');
  if (!uploadJob || uploadJob.status !== 'in_progress') return;

  const repaired = {
    ...uploadJob,
    files: (uploadJob.files || []).map((file) => (
      file.status === 'in_progress'
        ? { ...file, status: 'pending', updatedAt: new Date().toISOString() }
        : file
    )),
    updatedAt: new Date().toISOString(),
  };
  await checkpointJob(repaired);
  await processQueue();
}

export async function cancelUpload(courseId = null) {
  const { uploadJob, courses } = await chrome.storage.local.get(['uploadJob', 'courses']);
  if (!uploadJob || (courseId && uploadJob.courseId !== courseId)) return;

  const nextCourses = (courses || []).map((course) =>
    course.course_id === uploadJob.courseId
      ? { ...course, status: 'idle' }
      : course
  );
  await chrome.storage.local.set({
    uploadJob: { ...uploadJob, status: 'cancelled', updatedAt: new Date().toISOString() },
    courses: nextCourses,
  });
  await chrome.alarms.clear(RESUME_ALARM);
  await chrome.alarms.clear(RETRY_ALARM);
  broadcast({
    type: 'UPLOAD_ERROR',
    payload: { course_id: uploadJob.courseId, error: 'Upload cancelled', retryable: true },
  });
}

export async function retryFile(courseId = null) {
  const { uploadJob } = await chrome.storage.local.get('uploadJob');
  if (!uploadJob || uploadJob.status !== 'in_progress') return;
  if (courseId && uploadJob.courseId !== courseId) return;

  const index = (uploadJob.files || []).findIndex((file) => file.status === 'error');
  if (index === -1) {
    await processQueue();
    return;
  }
  uploadJob.files[index] = {
    ...uploadJob.files[index],
    status: 'pending',
    error: null,
    updatedAt: new Date().toISOString(),
  };
  uploadJob.updatedAt = new Date().toISOString();
  await checkpointJob(uploadJob);
  await processQueue();
}

async function markFileError(path, errorText) {
  const { uploadJob } = await chrome.storage.local.get('uploadJob');
  if (!uploadJob || uploadJob.status !== 'in_progress') return;
  const index = (uploadJob.files || []).findIndex((file) => file.path === path && file.status === 'in_progress');
  if (index === -1) return;

  const file = uploadJob.files[index];
  const originalUrl = file.url || '';
  const triedUrls = file.triedUrls || [originalUrl];
  const alternates = deriveAlternateSubmissionUrls(originalUrl).filter((url) => !triedUrls.includes(url));

  // If fetch failed (especially 404 on non-final endpoints), keep trying alternates
  // before marking the file as terminal error.
  if (alternates.length > 0) {
    const nextUrl = alternates[0];
    uploadJob.files[index] = {
      ...file,
      status: 'pending',
      url: nextUrl,
      triedUrls: [...triedUrls, nextUrl],
      error: `Fetch failed (${errorText}); retrying with alternate URL`,
      updatedAt: new Date().toISOString(),
    };
    uploadJob.updatedAt = new Date().toISOString();
    await checkpointJob(uploadJob);
    await reportProgress(uploadJob.courseId, `Retrying ${path} with alternate URL`, computeOverallPct(uploadJob));
    await scheduleAlarm(RESUME_ALARM, Date.now() + 800);
    debugLog('[Archiver] markFileError retry', {
      path,
      errorText,
      fromUrl: originalUrl,
      nextUrl,
      triedCount: triedUrls.length + 1,
    });
    return;
  }

  uploadJob.files[index] = {
    ...uploadJob.files[index],
    status: 'error',
    error: errorText,
    updatedAt: new Date().toISOString(),
  };
  uploadJob.updatedAt = new Date().toISOString();
  await checkpointJob(uploadJob);
  debugLog('[Archiver] markFileError terminal', {
    path,
    errorText,
    url: originalUrl,
    triedUrls,
  });
  broadcast({
    type: 'UPLOAD_ERROR',
    payload: { course_id: uploadJob.courseId, error: errorText, retryable: true },
  });
}

async function waitForFileResolution(path, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { uploadJob } = await chrome.storage.local.get('uploadJob');
    if (!uploadJob || uploadJob.status !== 'in_progress') return;
    const current = (uploadJob.files || []).find((file) => file.path === path || file.originalPath === path);
    if (!current) return;
    if (current.status === 'done' || current.status === 'skipped' || current.status === 'error') return;
    await sleep(350);
  }
  throw new Error('Timed out waiting for file fetch');
}

/**
 * Fetch a file URL directly from the service worker.
 * SW fetches share the browser cookie store (credentials: 'include' sends the
 * user's Gradescope session) and are not subject to CORS — Gradescope → S3
 * redirects succeed without any CORS headers required.
 */
async function fetchFileDirectly(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      credentials: 'include',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Fetch failed: ${response.status} ${response.statusText || ''}`.trim());
    }
    const mimeType = (response.headers.get('Content-Type') || 'application/octet-stream').split(';')[0].trim();
    if (mimeType === 'text/html' || mimeType === 'application/xhtml+xml') {
      throw new Error(`Received HTML instead of file — likely not authenticated or URL is wrong`);
    }
    const disposition = response.headers.get('Content-Disposition') || '';
    const dispMatch = /filename\*?=(?:UTF-\d+''\s*)?["']?([^;"'\n\r]+)["']?/i.exec(disposition);
    const filename = dispMatch ? dispMatch[1].trim().replace(/["']/g, '') : '';
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_FILE_SIZE_BYTES) {
      throw new Error(`File too large: ${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB (limit 50 MB)`);
    }
    // Convert ArrayBuffer → base64 in chunks to avoid call-stack overflow
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return { b64: btoa(binary), mimeType, filename };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function checkpointJob(uploadJob) {
  await chrome.storage.local.set({ uploadJob });
}

export async function reportProgress(courseId, step, pct) {
  const safePct = Math.max(0, Math.min(100, Number(pct) || 0));
  const progressKey = `progress_${courseId}`;
  await chrome.storage.local.set({
    [progressKey]: {
      course_id: courseId,
      step,
      pct: safePct,
      updatedAt: Date.now(),
    },
  });
  broadcast({
    type: 'UPLOAD_PROGRESS',
    payload: { course_id: courseId, step, pct: safePct },
  });
}

async function setCourseStatus(courseId, status) {
  const { courses } = await chrome.storage.local.get('courses');
  const nextCourses = (courses || []).map((course) => (
    course.course_id === courseId ? { ...course, status } : course
  ));
  await chrome.storage.local.set({ courses: nextCourses });
}

async function enumerateCourseFiles(tabId, courseId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [courseId],
    func: async (innerCourseId) => {
      // -----------------------------------------------------------------------
      // Direct submission PDF enumeration.
      // 1. Fetch the course page and parse graded assignments.
      // 2. For each assignment, extract the submission ID from the URL itself,
      //    or discover it by fetching the assignment page (which redirects to
      //    the submission view or contains a link to it).
      // 3. Build the canonical graded-copy URL: .../submissions/<sid>.pdf
      // No probing, no parseFileLinks fallback, no guessing endpoints.
      // -----------------------------------------------------------------------
      const scraper = window.gradescopeScraper;
      if (!scraper || typeof scraper.parseAssignments !== 'function') {
        return [];
      }

      const courseUrl = `https://www.gradescope.com/courses/${innerCourseId}`;
      let courseDoc = document;
      try {
        // Only re-fetch if we're not already on this course's page
        if (!window.location.pathname.startsWith(`/courses/${innerCourseId}`)) {
          const courseResponse = await fetch(courseUrl, { credentials: 'include' });
          if (courseResponse.ok) {
            const courseHtml = await courseResponse.text();
            courseDoc = new DOMParser().parseFromString(courseHtml, 'text/html');
          }
        }
      } catch (_) {}

      const assignments = scraper.parseAssignments(courseDoc)
        .filter((a) => a.url && a.url.includes(`/courses/${innerCourseId}/assignments/`));

      const uniqueFiles = new Map();
      for (const assignment of assignments) {
        const assignmentUrl = assignment.url;
        if (assignmentUrl.includes('/submissions/new')) continue;

        const assignmentName = (assignment.name || 'Assignment')
          .replace(/[^a-zA-Z0-9._\- ]+/g, '_').slice(0, 50);

        try {
          // Strip any trailing submission/fragment to get the assignment base
          const assignmentBase = assignmentUrl.replace(/\/submissions\/\d+.*/, '');

          // Step 1: submission ID may already be in the parsed URL
          // e.g. /courses/<cid>/assignments/<aid>/submissions/<sid>
          let sid = (assignmentUrl.match(/\/submissions\/(\d+)/) || [])[1] || null;

          // Step 2: if not in the URL, fetch to discover it via redirect or HTML
          if (!sid) {
            const resp = await fetch(assignmentUrl, { credentials: 'include' });
            if (!resp.ok) continue;
            // Gradescope may redirect students to their own submission view
            const finalUrl = resp.url || assignmentUrl;
            sid = (finalUrl.match(/\/submissions\/(\d+)/) || [])[1] || null;
            if (!sid) {
              const html = await resp.text();
              const doc = new DOMParser().parseFromString(html, 'text/html');
              for (const a of doc.querySelectorAll('a[href*="/submissions/"]')) {
                const href = a.getAttribute('href') || '';
                const m = href.match(/\/submissions\/(\d+)/);
                if (m && !href.includes('/submissions/new')) { sid = m[1]; break; }
              }
            }
          }

          if (!sid) continue;

          const fileUrl = `${assignmentBase}/submissions/${sid}.pdf`;
          if (uniqueFiles.has(fileUrl)) continue;

          const filename = `submission-${sid}.pdf`;
          const path = `${assignmentName}/${filename}`;
          uniqueFiles.set(fileUrl, { url: fileUrl, path, filename });
        } catch (_) {}
      }
      return Array.from(uniqueFiles.values());
    },
  });

  return result || [];
}

async function ensureInjectScripts(tabId) {
  // scraper.js must be in BOTH worlds:
  //   - ISOLATED: so content-script.js can see window.gradescopeScraper for SCRAPE_COURSES
  //   - MAIN: so the inline func inside enumerateCourseFiles (which runs in MAIN) can call it
  // inject.js stays in MAIN only (needs page-session cookies for fetch()).

  const [checks] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => ({
      hasScraper: !!window.gradescopeScraper,
      hasInject: !!window.__gradescopeArchiverInjectReady,
    }),
  });

  const [isolatedCheck] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    func: () => !!window.gradescopeScraper,
  });

  const jobs = [];

  if (!checks?.result?.hasScraper) {
    jobs.push(chrome.scripting.executeScript({
      target: { tabId },
      files: ['scraper.js'],
      world: 'MAIN',
    }));
  }

  if (!isolatedCheck?.result) {
    jobs.push(chrome.scripting.executeScript({
      target: { tabId },
      files: ['scraper.js'],
      world: 'ISOLATED',
    }));
  }

  if (!checks?.result?.hasInject) {
    jobs.push(chrome.scripting.executeScript({
      target: { tabId },
      files: ['inject.js'],
      world: 'MAIN',
    }));
  }

  if (jobs.length) await Promise.all(jobs);
}

async function openKeepalivePort(tabId) {
  if (!tabId) throw new Error('No tab available for keepalive');
  const port = chrome.tabs.connect(tabId, { name: 'gradescope-upload-keepalive' });
  port.onDisconnect.addListener(async () => {
    await scheduleAlarm(RESUME_ALARM, Date.now() + 3000);
  });
  return port;
}

async function scheduleAlarm(name, whenMs) {
  await chrome.alarms.create(name, { when: Math.max(Date.now() + 1000, whenMs) });
}

async function findGradescopeTabId() {
  const tabs = await chrome.tabs.query({
    url: ['https://*.gradescope.com/*', 'https://gradescope.com/*'],
  });
  return tabs?.[0]?.id || null;
}

/**
 * Finds an existing Gradescope tab or opens the specific course page and waits
 * for it to fully load. Always returns a valid tabId or throws.
 */
async function ensureCourseTab(courseId) {
  // Prefer a tab already on this course's page
  const courseTabs = await chrome.tabs.query({
    url: [`https://www.gradescope.com/courses/${courseId}*`, `https://gradescope.com/courses/${courseId}*`],
  });
  if (courseTabs.length > 0) return courseTabs[0].id;

  // Any Gradescope tab will do (inject.js can fetch the course page itself)
  const anyTab = await findGradescopeTabId();
  if (anyTab) return anyTab;

  // No GS tab at all — open the course page in the background and wait
  const courseUrl = `https://www.gradescope.com/courses/${courseId}`;
  const tab = await chrome.tabs.create({ url: courseUrl, active: false });
  await waitForTabLoad(tab.id, 30000);
  return tab.id;
}

/**
 * Polls until a tab's status is 'complete' or the timeout elapses.
 */
async function waitForTabLoad(tabId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') return;
    } catch (_) {
      // Tab may have been closed; give up gracefully
      return;
    }
    await sleep(400);
  }
}

async function sendTabMessage(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg.includes('Receiving end does not exist') || msg.includes('Could not establish connection')) {
      // Content script not ready yet — wait briefly, re-inject, then retry once
      await sleep(800);
      await ensureInjectScripts(tabId);
      await sleep(300);
      return await chrome.tabs.sendMessage(tabId, message);
    }
    throw err;
  }
}

/**
 * Verifies a tabId is still open and on a Gradescope URL.
 * If not, finds or creates a valid Gradescope tab and returns its id.
 */
async function ensureValidTab(tabId, courseId) {
  if (tabId) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && tab.url && tab.url.includes('gradescope.com')) return tabId;
    } catch (_) {
      // tab was closed — fall through
    }
  }
  // Tab is gone or not on Gradescope — get a fresh one
  return ensureCourseTab(courseId);
}

function filenameFromPath(path) {
  return String(path || '').split('/').filter(Boolean).pop() || 'file';
}

/**
 * Convert a human-readable course name into a valid GitHub repo slug.
 * e.g. "CS 101 - Intro to Programming" → "cs-101-intro-to-programming"
 */
function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100) || null;
}

/** Map common MIME types to file extensions. */
function extFromMime(mime) {
  mime = (mime || '').toLowerCase().split(';')[0].trim();
  const map = {
    'application/pdf': '.pdf',
    'application/zip': '.zip',
    'application/x-zip-compressed': '.zip',
    'application/x-tar': '.tar',
    'application/gzip': '.tar.gz',
    'application/x-gzip': '.tar.gz',
    'text/plain': '.txt',
    'text/csv': '.csv',
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
  };
  return map[mime] || '';
}

/** Infer extension from file signature bytes in a base64 payload. */
function extFromMagicBytes(b64) {
  const raw = String(b64 || '');
  if (!raw) return '';

  // PDF: "%PDF-"
  if (raw.startsWith('JVBERi0')) return '.pdf';
  // ZIP: PK\x03\x04 or PK\x05\x06 or PK\x07\x08
  if (raw.startsWith('UEsDB') || raw.startsWith('UEsFB') || raw.startsWith('UEsHB')) return '.zip';
  // PNG: \x89PNG\r\n\x1a\n
  if (raw.startsWith('iVBORw0KGgo')) return '.png';
  // JPEG: \xFF\xD8\xFF
  if (raw.startsWith('/9j/')) return '.jpg';
  // GIF87a/GIF89a
  if (raw.startsWith('R0lGODdh') || raw.startsWith('R0lGODlh')) return '.gif';

  return '';
}

/**
 * Detect whether a base64 payload is likely JSON/HTML/text rather than a binary file.
 * Gradescope sometimes responds with text payloads while headers claim octet-stream.
 */
function looksLikeTextPayloadB64(b64) {
  try {
    const raw = String(b64 || '');
    if (!raw) return false;
    const head = atob(raw.slice(0, 512));
    const trimmed = head.replace(/^\uFEFF/, '').trimStart().toLowerCase();
    if (!trimmed) return false;

    return (
      trimmed.startsWith('{')
      || trimmed.startsWith('[')
      || trimmed.startsWith('<!doctype html')
      || trimmed.startsWith('<html')
      || trimmed.startsWith('<?xml')
      || trimmed.startsWith('error')
      || trimmed.startsWith('forbidden')
      || trimmed.startsWith('unauthorized')
    );
  } catch (_) {
    return false;
  }
}

/** Extract extension from an existing path/filename (.pdf, .zip etc.). */
function extFromPath(path) {
  const name = filenameFromPath(path);
  const dot = name.lastIndexOf('.');
  if (dot > 0 && dot < name.length - 1) return name.slice(dot);
  return '';
}

/**
 * Ensure a path ends with `ext`.  If the path already has the right extension,
 * or if ext is empty, return path unchanged.  Otherwise strip a generic
 * no-extension segment like "download"/"file"/"submission" and append ext.
 */
function ensureExtension(path, ext) {
  if (!ext) return path;
  if (path.toLowerCase().endsWith(ext.toLowerCase())) return path;
  // If the last segment already has a real extension, keep it
  const name = filenameFromPath(path);
  const dot = name.lastIndexOf('.');
  if (dot > 0 && dot < name.length - 1) return path; // already has an ext
  return path + ext;
}

/**
 * Given a Gradescope submission URL, return plausible alternate download URLs
 * to try when the primary URL returns JSON/HTML instead of the PDF.
 */
/**
 * Given a Gradescope submission URL, return the canonical .pdf URL to retry.
 * Returns empty array if the URL already ends in .pdf (nothing useful to try).
 */
function deriveAlternateSubmissionUrls(origUrl) {
  try {
    const u = new URL(origUrl);
    // Already a .pdf URL — no point retrying with the same thing
    if (u.pathname.endsWith('.pdf')) return [];
    const origin = u.origin;
    const pathname = u.pathname || '';
    const m = pathname.match(/(.*\/submissions\/(\d+))/);
    if (m) {
      const pdfUrl = `${origin}${m[1]}.pdf`;
      if (pdfUrl !== origUrl) return [pdfUrl];
      return [];
    }
    const sid = u.searchParams.get('submission_id');
    const assignmentMatch = pathname.match(/(.*\/assignments\/\d+)/);
    if (sid && assignmentMatch) {
      return [`${origin}${assignmentMatch[1]}/submissions/${sid}.pdf`];
    }
    return [];
  } catch (_) {
    return [];
  }
}

/**
 * Given a base64-encoded JSON/text payload from a submission endpoint, try to
 * extract a direct download URL (pdf/file) by scanning for common keys or URL
 * patterns. Returns a URL string or null.
 */
function extractDownloadUrlFromJsonB64(b64) {
  try {
    const bin = atob(b64);
    // Try to parse as JSON
    let data = null;
    try {
      data = JSON.parse(bin);
    } catch (_) {
      // Not strict JSON — fallback to text search
      const txt = bin;
      const url = findUrlInText(txt);
      return url;
    }

    // Recursively search object for likely download URLs
    const found = findUrlInObject(data);
    return found || null;
  } catch (err) {
    return null;
  }
}

function findUrlInText(txt) {
  if (!txt) return null;
  const urlRe = /(https?:\/\/[^"'\s<>]+(?:\.pdf|download[^"'\s<>]*|submissions\/[0-9]+[^"'\s<>]*))/i;
  const m = txt.match(urlRe);
  return m ? m[1] : null;
}

function findUrlInObject(obj) {
  if (!obj) return null;
  if (typeof obj === 'string') {
    if (obj.match(/https?:\/\//i) && (obj.toLowerCase().includes('.pdf') || obj.toLowerCase().includes('download'))) return obj;
    return null;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const res = findUrlInObject(item);
      if (res) return res;
    }
    return null;
  }
  if (typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v === 'string' && v.match(/https?:\/\//i) && (v.toLowerCase().includes('.pdf') || v.toLowerCase().includes('download') || v.toLowerCase().includes('file'))) return v;
      const res = findUrlInObject(v);
      if (res) return res;
    }
  }
  return null;
}

function computeOverallPct(uploadJob, activeFilePct = null) {
  const files = uploadJob.files || [];
  if (!files.length) return 100;
  const doneCount = files.filter((file) => file.status === 'done' || file.status === 'skipped').length;
  const inProgressCount = files.filter((file) => file.status === 'in_progress').length;
  const perFile = 100 / files.length;
  const activePct = activeFilePct == null ? (inProgressCount ? 50 : 0) : activeFilePct;
  const pct = doneCount * perFile + (inProgressCount ? (activePct / 100) * perFile : 0);
  return Math.round(Math.max(0, Math.min(100, pct)));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {
  });
}

function debugLog(tag, details = {}) {
  broadcast({
    type: 'ARCHIVER_DEBUG',
    payload: {
      tag,
      details,
      ts: Date.now(),
    },
  });
}
