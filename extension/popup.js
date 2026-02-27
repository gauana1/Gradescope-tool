// popup.js — Gradescope Archiver

// ─── Onboarding ────────────────────────────────────────────────────────────

let obCurrentStep = 0;

async function initPopup() {
  const { githubToken, ghUser } = await chrome.storage.local.get(['githubToken', 'ghUser']);
  if (!githubToken) {
    showScreen('onboarding');
    goToStep(0);
  } else {
    showScreen('main');
    renderGhChip(ghUser || null);
    await renderAll();
  }
}

function showScreen(id) {
  document.getElementById('onboarding').classList.toggle('hidden', id !== 'onboarding');
  document.getElementById('main').classList.toggle('hidden', id !== 'main');
}

function goToStep(n) {
  [0, 1, 2].forEach((i) => {
    document.getElementById(`ob-step-${i}`)?.classList.toggle('hidden', i !== n);
    const dot = document.getElementById(`dot-${i}`);
    if (dot) {
      dot.classList.toggle('active', i === n);
      dot.classList.toggle('done', i < n);
    }
  });
  obCurrentStep = n;
}

document.getElementById('ob-next-0')?.addEventListener('click', () => goToStep(1));
document.getElementById('ob-back-1')?.addEventListener('click', () => goToStep(0));

document.getElementById('ob-pat-eye')?.addEventListener('click', () => {
  const inp = document.getElementById('ob-pat-input');
  inp.type = inp.type === 'password' ? 'text' : 'password';
});

document.getElementById('ob-validate-btn')?.addEventListener('click', async () => {
  const btn   = document.getElementById('ob-validate-btn');
  const inp   = document.getElementById('ob-pat-input');
  const fb    = document.getElementById('ob-pat-feedback');
  const token = inp.value.trim();

  if (!token) { setFeedback(fb, '⚠ Paste your token first.', 'err'); inp.classList.add('invalid'); return; }

  btn.disabled = true;
  btn.textContent = 'Validating…';
  inp.classList.remove('valid', 'invalid');
  setFeedback(fb, '', '');

  try {
    const result = await chrome.runtime.sendMessage({ type: 'VALIDATE_TOKEN', payload: { token } });
    if (result?.ok) {
      inp.classList.add('valid');
      inp.value = '';
      await chrome.storage.local.set({ githubToken: token, ghUser: result.user });

      const avatarEl = document.getElementById('ob-avatar');
      const loginEl  = document.getElementById('ob-gh-login');
      if (avatarEl && result.user?.avatarUrl) avatarEl.src = result.user.avatarUrl;
      if (loginEl  && result.user?.login)     loginEl.textContent = `@${result.user.login}`;

      setFeedback(fb, '✓ Token valid!', 'ok');
      setTimeout(() => goToStep(2), 600);
    } else {
      inp.classList.add('invalid');
      setFeedback(fb, `✗ ${result?.error || 'Token invalid — check it has "repo" scope.'}`, 'err');
    }
  } catch (err) {
    inp.classList.add('invalid');
    setFeedback(fb, `✗ ${err.message || 'Validation failed'}`, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Validate Token';
  }
});

document.getElementById('ob-open-gs')?.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://www.gradescope.com/', active: true });
});

document.getElementById('ob-finish')?.addEventListener('click', async () => {
  const { ghUser } = await chrome.storage.local.get('ghUser');
  showScreen('main');
  renderGhChip(ghUser || null);
  await renderAll();
  triggerRefresh(true);
});

function setFeedback(el, msg, cls) {
  if (!el) return;
  el.textContent = msg;
  el.className = `ob-feedback${cls ? ' ' + cls : ''}`;
}

// ─── GitHub chip ───────────────────────────────────────────────────────────

function renderGhChip(ghUser) {
  const chip   = document.getElementById('gh-chip');
  const avatar = document.getElementById('gh-avatar');
  const login  = document.getElementById('gh-login');
  if (!chip) return;
  if (ghUser?.login) {
    if (avatar) avatar.src = ghUser.avatarUrl || '';
    if (login)  login.textContent = ghUser.login;
    chip.classList.remove('hidden');
  } else {
    chip.classList.add('hidden');
  }
}

// ─── Main screen actions ───────────────────────────────────────────────────

document.getElementById('settings-btn')?.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

document.getElementById('banner-setup-link')?.addEventListener('click', (e) => {
  e.preventDefault();
  showScreen('onboarding');
  goToStep(1);
});

document.getElementById('refresh-btn')?.addEventListener('click', () => triggerRefresh(false));

async function triggerRefresh(silent = false) {
  const btn = document.getElementById('refresh-btn');
  if (btn) btn.disabled = true;
  if (!silent) setStatus('Refreshing courses…', 'info');

  const timeoutId = setTimeout(() => {
    if (btn) btn.disabled = false;
    if (!silent) setStatus('Refresh timed out. Visit Gradescope first.', 'err');
  }, 15000);

  try {
    const res = await chrome.runtime.sendMessage({ type: 'REFRESH_COURSES' });
    clearTimeout(timeoutId);
    if (btn) btn.disabled = false;
    if (!res?.ok) {
      setStatus(res?.error || 'Refresh failed.', 'err');
    } else if (!silent) {
      setStatus('', '');
    }
    await renderAll();
  } catch (err) {
    clearTimeout(timeoutId);
    if (btn) btn.disabled = false;
    setStatus(err.message || 'Refresh failed', 'err');
  }
}

document.getElementById('start-btn')?.addEventListener('click', async () => {
  const { uploadJob } = await chrome.storage.local.get('uploadJob');
  if (isRunning(uploadJob)) { setStatus('Upload already running — please wait.', 'info'); return; }

  const checked = [...document.querySelectorAll('.course-cb:checked')].map((cb) => cb.dataset.courseId);
  if (!checked.length) { showToast('Select at least one course first.'); return; }

  setStatus('Starting archive…', 'info');
  syncButtons({ status: 'in_progress' });

  const res = await chrome.runtime.sendMessage({ type: 'START_UPLOAD', payload: { course_id: checked[0] } });
  if (res?.error || res?.ok === false) {
    setStatus(res?.error || 'Failed to start upload.', 'err');
    syncButtons(null);
  }
  await renderAll();
});

document.getElementById('cancel-btn')?.addEventListener('click', async () => {
  const { uploadJob } = await chrome.storage.local.get('uploadJob');
  if (!uploadJob) return;
  await chrome.runtime.sendMessage({ type: 'CANCEL_UPLOAD', payload: { course_id: uploadJob.courseId } });
  setStatus('Upload cancelled.', 'info');
  await renderAll();
});

document.getElementById('retry-btn')?.addEventListener('click', async () => {
  const { uploadJob } = await chrome.storage.local.get('uploadJob');
  if (!uploadJob) return;
  await chrome.runtime.sendMessage({ type: 'RETRY_FILE', payload: { course_id: uploadJob.courseId } });
  setStatus('Retrying…', 'info');
  await renderAll();
});

// ─── Background message listener ──────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  const p = msg.payload || {};
  if (msg.type === 'UPLOAD_PROGRESS') {
    setStatus(`${p.step}${Number.isFinite(p.pct) ? ` (${p.pct}%)` : ''}`, 'info');
    updateProgressBar(p.pct);
    renderAll();
  } else if (msg.type === 'UPLOAD_DONE') {
    setStatus('Archive complete! ✓', 'ok');
    updateProgressBar(100);
    if (p.repoUrl) {
      showToast('Uploaded! Opening GitHub repo…');
      setTimeout(() => chrome.tabs.create({ url: p.repoUrl, active: true }), 800);
    }
    renderAll();
  } else if (msg.type === 'UPLOAD_ERROR') {
    setStatus(`Error: ${p.error || 'Unknown error'}`, 'err');
    renderAll();
  } else if (msg.type === 'COURSES_UPDATED') {
    renderAll();
    const btn = document.getElementById('refresh-btn');
    if (btn) btn.disabled = false;
    if (!msg.error) setStatus('Courses updated ✓', 'ok');
  }
});

// ─── Render helpers ────────────────────────────────────────────────────────

async function renderAll() {
  const { uploadJob, githubToken } = await chrome.storage.local.get(['uploadJob', 'githubToken']);
  const banner = document.getElementById('token-banner');
  if (banner) banner.classList.toggle('hidden', !!githubToken);
  syncButtons(uploadJob);
  await renderCourses(uploadJob);
  renderJobPanel(uploadJob);
}

async function renderCourses(activeJob) {
  const { courses, repoMap } = await chrome.storage.local.get(['courses', 'repoMap']);
  const list = document.getElementById('course-list');
  if (!list) return;

  if (!courses?.length) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🎓</div>
        <div class="empty-title">No courses yet</div>
        <p>Visit your <a href="https://www.gradescope.com" target="_blank">Gradescope dashboard</a> and press <strong>Refresh</strong>.</p>
      </div>`;
    const startBtn = document.getElementById('start-btn');
    if (startBtn) startBtn.disabled = true;
    return;
  }

  const running = isRunning(activeJob);
  list.innerHTML = '';
  for (const c of courses) {
    const isActive = running && activeJob?.courseId === c.course_id;
    const repo     = repoMap?.[c.course_id];
    const status   = isActive ? 'uploading' : (c.status || 'idle');
    const statusLabels = { idle: '', uploading: 'Archiving…', done: 'Done', error: 'Error' };

    const item = document.createElement('div');
    item.className = 'course-item';
    item.innerHTML = `
      <input type="checkbox" class="course-cb" data-course-id="${c.course_id}" ${running ? 'disabled' : ''} />
      <div class="course-info">
        <div class="course-name">${escHtml(c.short_name || c.full_name || 'Course ' + c.course_id)}</div>
        ${c.term ? `<div class="course-meta">${escHtml(c.term)}</div>` : ''}
      </div>
      <div class="course-actions">
        ${repo ? `<a href="${repo.url}" target="_blank" title="Open GitHub repo" style="font-size:12px">↗</a>` : ''}
        ${status !== 'idle' ? `<span class="badge badge-${status}">${statusLabels[status] || status}</span>` : ''}
      </div>`;
    list.appendChild(item);
  }

  const startBtn = document.getElementById('start-btn');
  if (startBtn) startBtn.disabled = running;

  list.querySelectorAll('.course-cb').forEach((cb) => {
    cb.addEventListener('change', updateStartBtnState);
  });
  updateStartBtnState();
}

function updateStartBtnState() {
  const anyChecked = !!document.querySelector('.course-cb:checked');
  const btn = document.getElementById('start-btn');
  // Always reflect checkbox state — no guard so checking a box can re-enable the button
  if (btn) btn.disabled = !anyChecked;
}

function renderJobPanel(uploadJob) {
  const panel = document.getElementById('job-panel');
  const sec   = document.getElementById('secondary-actions');
  if (!panel) return;

  if (!uploadJob?.files?.length) {
    panel.classList.add('hidden');
    if (sec) sec.classList.add('hidden');
    return;
  }

  panel.classList.remove('hidden');
  if (sec) sec.classList.remove('hidden');

  const total  = uploadJob.files.length;
  const done   = uploadJob.files.filter((f) => f.status === 'done' || f.status === 'skipped').length;
  const errors = uploadJob.files.filter((f) => f.status === 'error').length;
  const pct    = total ? Math.round((done / total) * 100) : 0;

  const titleEl = document.getElementById('job-title');
  const statsEl = document.getElementById('job-stats');
  const fillEl  = document.getElementById('progress-fill');
  const filesEl = document.getElementById('job-files');

  if (titleEl) titleEl.textContent = `Archiving course ${uploadJob.courseId}`;
  if (statsEl) statsEl.textContent = `${done}/${total} files${errors ? ` · ${errors} errors` : ''}`;
  if (fillEl)  fillEl.style.width = `${pct}%`;

  if (filesEl) {
    const iconMap = { done: '✓', error: '✗', in_progress: '⋯', skipped: '–', pending: '·' };
    filesEl.innerHTML = uploadJob.files.map((f) => `
      <div class="job-file-row">
        <span class="jfr-icon">${iconMap[f.status] || '·'}</span>
        <span class="jfr-path">${escHtml(f.path)}</span>
        <span class="jfr-status ${f.status}">${f.status}</span>
      </div>`).join('');
    const activeRow = filesEl.querySelector('.jfr-status.in_progress, .jfr-status.pending');
    if (activeRow) activeRow.scrollIntoView({ block: 'nearest' });
  }
}

function updateProgressBar(pct) {
  const fill = document.getElementById('progress-fill');
  if (fill && Number.isFinite(pct)) fill.style.width = `${pct}%`;
}

function syncButtons(uploadJob) {
  const running = isRunning(uploadJob);
  const r = document.getElementById('refresh-btn');
  const s = document.getElementById('start-btn');
  const c = document.getElementById('cancel-btn');
  const t = document.getElementById('retry-btn');
  if (r) r.disabled = running;
  if (s) s.disabled = running;
  if (c) c.disabled = !running;
  if (t) t.disabled = isRunning(uploadJob) || (uploadJob?.status !== 'error');
}

function setStatus(msg, cls) {
  const el = document.getElementById('global-status');
  if (!el) return;
  el.textContent = msg;
  el.className = `status-bar ${cls}`;
}

function isRunning(job) { return !!job && job.status === 'in_progress'; }

function showToast(msg, duration = 2500) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), duration);
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Module scripts run after DOM is parsed; call directly rather than
// relying on DOMContentLoaded which may have already fired in extension popups.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initPopup);
} else {
  initPopup();
}
