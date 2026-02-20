// inject.js
// Runs in the page MAIN world. Exposes `window.gradescopeArchiver` with Promise APIs
// that forward requests to the extension content script via postMessage.
console.log('inject.js loaded');
(function () {
  if (window.gradescopeArchiver) return;

  const pending = new Map();

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || (e.data.source !== 'gradescope-archiver-page' && e.data.source !== 'gradescope-archiver-inject')) return;
    const { type, requestId, payload, error } = e.data;
    if (!requestId) return;
    const entry = pending.get(requestId);
    if (!entry) return;
    if (type === 'PARSE_RESULT') {
      entry.resolve(payload);
    } else if (type === 'PARSE_ERROR') {
      entry.reject(new Error(error || 'parse error'));
    }
    pending.delete(requestId);
  });

  function makeRequest(type, data) {
    const requestId = 'r' + Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      window.postMessage(Object.assign({ source: 'gradescope-archiver-page', type, requestId }, data || {}), '*');
      // timeout
      setTimeout(() => {
        if (pending.has(requestId)) {
          pending.delete(requestId);
          reject(new Error('timeout'));
        }
      }, 15000);
    });
  }

  window.gradescopeArchiver = {
    parseCourseList: function () {
      return makeRequest('RUN_PARSE_COURSE_LIST');
    }
  };
})();
