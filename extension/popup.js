// popup.js
window.addEventListener('DOMContentLoaded', async () => {
  await renderCourses();
});

document.getElementById('refresh-btn').addEventListener('click', async () => {
  setGlobalStatus('Refreshing courses…', 'info');
  document.getElementById('refresh-btn').disabled = true;
  chrome.runtime.sendMessage({ type: 'REFRESH_COURSES' });
});

document.getElementById('upload-btn').addEventListener('click', async () => {
  const checked = [...document.querySelectorAll('.course-cb:checked')];
  const course_ids = checked.map(cb => cb.dataset.courseId);
  if (!course_ids.length) {
    setGlobalStatus('Select at least one course.', 'error');
    return;
  }
  setGlobalStatus('Upload started…', 'info');
  document.getElementById('upload-btn').disabled = true;
  chrome.runtime.sendMessage({ type: 'START_UPLOAD', payload: { course_ids } });
});

// Listen for progress updates from background
chrome.runtime.onMessage.addListener((message) => {
  if (!message) return;
  const p = message.payload || {};
  if (message.type === 'UPLOAD_PROGRESS') {
    setCourseStatus(p.course_id, `${p.step} (${p.pct}%)`, 'uploading');
  } else if (message.type === 'UPLOAD_DONE') {
    setCourseStatus(
      p.course_id,
      `✓ <a href="${p.repoUrl}" target="_blank">View repo</a>`,
      'done'
    );
    setGlobalStatus('Upload complete!', 'ok');
    document.getElementById('upload-btn').disabled = false;
  } else if (message.type === 'UPLOAD_ERROR') {
    if (p.course_id) {
      setCourseStatus(p.course_id, `✗ ${p.error}`, 'error');
    } else {
      setGlobalStatus(`Error: ${p.error}`, 'error');
    }
    document.getElementById('upload-btn').disabled = false;
  } else if (message.type === 'COURSES_UPDATED') {
    renderCourses();
    document.getElementById('refresh-btn').disabled = false;
    setGlobalStatus('Courses refreshed!', 'ok');
  }
});

async function renderCourses() {
  const { courses } = await chrome.storage.local.get('courses');
  const { repoMap = {} } = await chrome.storage.local.get('repoMap');
  const list = document.getElementById('course-list');

  if (!courses || courses.length === 0) {
    list.innerHTML = '<p class="empty">No courses found.<br>Visit your Gradescope dashboard first.</p>';
    return;
  }

  list.innerHTML = '';
  for (const course of courses) {
    const item = document.createElement('div');
    item.className = 'course-item';
    const isDone = course.status === 'done';
    const repoInfo = repoMap[course.course_id];
    const repoLink = repoInfo ? `<a href="${repoInfo.url}" target="_blank" class="repo-link">↗ repo</a>` : '';
    item.innerHTML = `
      <label class="course-label">
        <input type="checkbox" class="course-cb" data-course-id="${course.course_id}" ${isDone ? 'disabled' : ''} />
        <span class="course-name">${course.short_name || 'Course ' + course.course_id}</span>
      </label>
      <span class="course-status status-${course.status || 'idle'}" id="status-${course.course_id}">${isDone ? 'Done' : ''}</span>
      ${repoLink}
    `;
    list.appendChild(item);
  }
}

function setCourseStatus(course_id, html, cls) {
  const el = document.getElementById(`status-${course_id}`);
  if (el) {
    el.innerHTML = html;
    el.className = `course-status status-${cls}`;
  }
}

function setGlobalStatus(msg, cls) {
  const el = document.getElementById('global-status');
  if (el) {
    el.textContent = msg;
    el.className = `global-status status-${cls}`;
  }
}
