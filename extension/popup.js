// popup.js
window.addEventListener('DOMContentLoaded', async () => {
  await renderAll();
});

document.getElementById('refresh-btn').addEventListener('click', async () => {
  setGlobalStatus('Refreshing courses…', 'info');
  const refreshBtn = document.getElementById('refresh-btn');
  refreshBtn.disabled = true;
  const timeoutId = setTimeout(() => {
    refreshBtn.disabled = false;
    setGlobalStatus('Refresh timed out. Try again from a Gradescope page.', 'error');
  }, 10000);
  try {
    const response = await chrome.runtime.sendMessage({ type: 'REFRESH_COURSES' });
    if (!response?.ok) {
      setGlobalStatus(`Refresh failed: ${response?.error || 'Unknown error'}`, 'error');
      refreshBtn.disabled = false;
      clearTimeout(timeoutId);
      return;
    }
    await renderAll();
    refreshBtn.disabled = false;
    clearTimeout(timeoutId);
    setGlobalStatus('Refresh requested. Course list updated.', 'ok');
  } catch (error) {
    setGlobalStatus(`Refresh failed: ${error?.message || String(error)}`, 'error');
    refreshBtn.disabled = false;
    clearTimeout(timeoutId);
  }
});

document.getElementById('start-btn').addEventListener('click', async () => {
  const { uploadJob } = await chrome.storage.local.get('uploadJob');
  if (isUploadRunning(uploadJob)) {
    setGlobalStatus('An upload is already running. Please wait for it to finish.', 'info');
    return;
  }

  const checked = [...document.querySelectorAll('.course-cb:checked')].map((cb) => cb.dataset.courseId);
  if (!checked.length) {
    setGlobalStatus('Select at least one course.', 'error');
    return;
  }

  setGlobalStatus('Upload started…', 'info');
  syncActionButtons({ status: 'in_progress' });

  const response = await chrome.runtime.sendMessage({ type: 'START_UPLOAD', payload: { course_id: checked[0] } });
  if (response?.error || response?.ok === false) {
    setGlobalStatus(`Failed to start upload: ${response?.error || 'Unknown error'}`, 'error');
  }
  await renderAll();
});

document.getElementById('cancel-btn').addEventListener('click', async () => {
  const { uploadJob } = await chrome.storage.local.get('uploadJob');
  if (!uploadJob || isUploadRunning(uploadJob)) return;
  await chrome.runtime.sendMessage({ type: 'CANCEL_UPLOAD', payload: { course_id: uploadJob.courseId } });
  setGlobalStatus('Upload cancelled.', 'info');
  await renderAll();
});

document.getElementById('retry-btn').addEventListener('click', async () => {
  const { uploadJob } = await chrome.storage.local.get('uploadJob');
  if (!uploadJob || isUploadRunning(uploadJob)) return;
  await chrome.runtime.sendMessage({ type: 'RETRY_FILE', payload: { course_id: uploadJob.courseId } });
  setGlobalStatus('Retry requested…', 'info');
  await renderAll();
});

// Listen for progress updates from background
chrome.runtime.onMessage.addListener((message) => {
  if (!message) return;
  const p = message.payload || {};
  if (message.type === 'UPLOAD_PROGRESS') {
    setGlobalStatus(`${p.step} (${p.pct}%)`, 'info');
    renderAll();
  } else if (message.type === 'UPLOAD_DONE') {
    setGlobalStatus('Upload complete.', 'ok', p.repoUrl ? { href: p.repoUrl, label: 'Open GitHub repo' } : null);
    renderAll();
  } else if (message.type === 'UPLOAD_ERROR') {
    setGlobalStatus(`Upload failed: ${p.error || 'Unknown error'}`, 'error');
    renderAll();
  } else if (message.type === 'COURSES_UPDATED') {
    renderAll();
    document.getElementById('refresh-btn').disabled = false;
    const hasError = !!message.error;
    setGlobalStatus(hasError ? `Refresh failed: ${message.error}` : 'Courses refreshed!', hasError ? 'error' : 'ok');
  }
});

async function renderAll() {
  const { uploadJob } = await chrome.storage.local.get('uploadJob');
  syncActionButtons(uploadJob);
  await renderCourses(uploadJob);
  await renderUploadJobFiles(uploadJob);
}

async function renderCourses(uploadJobArg = null) {
  const { courses, uploadJob } = await chrome.storage.local.get(['courses', 'uploadJob']);
  const { repoMap = {} } = await chrome.storage.local.get('repoMap');
  const activeJob = uploadJobArg || uploadJob;
  const list = document.getElementById('course-list');

  if (!courses || courses.length === 0) {
    list.innerHTML = '<p class="empty">No courses found.<br>Visit your Gradescope dashboard first.</p>';
    return;
  }

  list.innerHTML = '';
  for (const course of courses) {
    const item = document.createElement('div');
    item.className = 'course-item';
    const isActiveUpload = activeJob?.status === 'in_progress' && activeJob.courseId === course.course_id;
    const isAnyUploadRunning = isUploadRunning(activeJob);
    const repoInfo = repoMap[course.course_id];
    const repoLink = repoInfo ? `<a href="${repoInfo.url}" target="_blank" class="repo-link">↗ repo</a>` : '';

    let statusLabel = '';
    let statusClass = `status-${course.status || 'idle'}`;
    if (isActiveUpload) {
      const progressKey = `progress_${course.course_id}`;
      chrome.storage.local.get(progressKey).then((data) => {
        const progress = data[progressKey];
        const statusEl = document.getElementById(`status-${course.course_id}`);
        if (statusEl && progress?.step) {
          statusEl.textContent = `${progress.step}${Number.isFinite(progress.pct) ? ` (${progress.pct}%)` : ''}`;
        }
      }).catch(() => {});
      statusLabel = 'Uploading…';
      statusClass = 'status-uploading';
    } else if (course.status === 'done') {
      statusLabel = 'Done';
      statusClass = 'status-done';
    } else if (course.status === 'error') {
      statusLabel = 'Failed';
      statusClass = 'status-error';
    }

    item.innerHTML = `
      <label class="course-label">
        <input type="checkbox" class="course-cb" data-course-id="${course.course_id}" ${isAnyUploadRunning ? 'disabled' : ''} />
        <span class="course-name">${course.short_name || 'Course ' + course.course_id}</span>
      </label>
      <span class="course-status ${statusClass}" id="status-${course.course_id}">${statusLabel}</span>
      ${repoLink}
    `;
    list.appendChild(item);
  }
}

async function renderUploadJobFiles(uploadJobArg = null) {
  const { uploadJob } = uploadJobArg ? { uploadJob: uploadJobArg } : await chrome.storage.local.get('uploadJob');
  const panel = document.getElementById('upload-job-status');
  if (!panel) return;

  if (!uploadJob || !uploadJob.files || uploadJob.files.length === 0) {
    panel.innerHTML = '<p class="empty">No active upload job.</p>';
    return;
  }

  const summary = document.createElement('div');
  summary.className = 'job-summary';
  const done = uploadJob.files.filter((file) => file.status === 'done' || file.status === 'skipped').length;
  const total = uploadJob.files.length;
  const failed = uploadJob.files.filter((file) => file.status === 'error').length;
  const skipped = uploadJob.files.filter((file) => file.status === 'skipped').length;
  summary.innerHTML = `<strong>Course ${uploadJob.courseId}</strong> • ${done}/${total} complete • ${failed} failed • ${skipped} skipped`;

  const list = document.createElement('div');
  list.className = 'job-file-list';
  uploadJob.files.forEach((file) => {
    const row = document.createElement('div');
    row.className = 'job-file-row';
    row.innerHTML = `<span class="job-file-path">${file.path}</span><span class="job-file-status status-${file.status}">${file.status}</span>`;
    list.appendChild(row);
  });

  panel.innerHTML = '';
  panel.appendChild(summary);
  panel.appendChild(list);

  if (uploadJob.status === 'error' && uploadJob.error) {
    const err = document.createElement('div');
    err.className = 'global-status status-error';
    err.textContent = `Error: ${uploadJob.error}`;
    panel.appendChild(err);
  }
}

function setGlobalStatus(msg, cls, link = null) {
  const el = document.getElementById('global-status');
  if (el) {
    el.textContent = '';
    const text = document.createTextNode(msg);
    el.appendChild(text);
    if (link?.href) {
      const a = document.createElement('a');
      a.href = link.href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = link.label || 'Open link';
      a.style.marginLeft = '6px';
      el.appendChild(a);
    }
    el.className = `global-status status-${cls}`;
  }
}

function isUploadRunning(uploadJob) {
  return !!uploadJob && uploadJob.status === 'in_progress';
}

function syncActionButtons(uploadJob) {
  const running = isUploadRunning(uploadJob);
  document.getElementById('refresh-btn').disabled = running;
  document.getElementById('start-btn').disabled = running;
  document.getElementById('cancel-btn').disabled = running;
  document.getElementById('retry-btn').disabled = running;
}
