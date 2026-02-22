const INJECT_SOURCE = 'gradescope-archiver-inject';

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== INJECT_SOURCE) return;

  if (data.type === 'FETCH_RESULT') {
    chrome.runtime.sendMessage({
      type: 'FILE_DATA',
      payload: {
        filename: data.filename,
        path: data.path,
        b64: data.b64,
        mimeType: data.mimeType,
        url: data.url,
      },
    }).catch(() => {});
    return;
  }

  if (data.type === 'FILE_TOO_LARGE') {
    chrome.runtime.sendMessage({
      type: 'FILE_TOO_LARGE',
      payload: {
        filename: data.filename,
        path: data.path,
        url: data.url,
        sizeBytes: data.sizeBytes,
      },
    });
    return;
  }

  if (data.type === 'FETCH_PROGRESS') {
    chrome.runtime.sendMessage({
      type: 'FETCH_PROGRESS',
      payload: {
        path: data.path,
        url: data.url,
        pct: data.pct,
        bytesReceived: data.bytesReceived,
        totalBytes: data.totalBytes,
      },
    });
    return;
  }

  if (data.type === 'FETCH_ERROR') {
    chrome.runtime.sendMessage({
      type: 'FETCH_ERROR',
      payload: {
        path: data.path,
        url: data.url,
        error: data.error,
      },
    });
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (!message || !message.type) return;

  if (message.type === 'ARCHIVER_DEBUG') {
    return;
  }

  if (message.type === 'SCRAPE_COURSES') {
    const scraper = window.gradescopeScraper;
    if (!scraper || typeof scraper.parseCourseList !== 'function') {
      chrome.runtime.sendMessage({ type: 'COURSES_FOUND', payload: [] });
      return;
    }

    (async () => {
      let courses = scraper.parseCourseList(document) || [];

      if (!courses.length) {
        const fallbackUrls = [
          `${window.location.origin}/`,
          `${window.location.origin}/courses`,
        ];

        for (const url of fallbackUrls) {
          try {
            const response = await fetch(url, { credentials: 'include' });
            if (!response.ok) {
              continue;
            }
            const html = await response.text();
            const parsed = new DOMParser().parseFromString(html, 'text/html');
            courses = scraper.parseCourseList(parsed) || [];
            if (courses.length) break;
          } catch (_) {
          }
        }
      }

      const normalized = scraper.normalizeCourses
        ? scraper.normalizeCourses(courses)
        : courses;
      chrome.runtime.sendMessage({ type: 'COURSES_FOUND', payload: normalized });
    })();
    return;
  }

  if (message.type === 'FETCH_FILE') {
    const payload = message.payload || {};
    window.postMessage({
      source: INJECT_SOURCE,
      type: 'FETCH_FILE',
      url: payload.url,
      path: payload.path,
      filename: payload.filename,
      timeoutMs: payload.timeoutMs,
    }, '*');
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (!port || port.name !== 'gradescope-upload-keepalive') return;
  port.onDisconnect.addListener(() => {
    chrome.runtime.sendMessage({
      type: 'KEEPALIVE_DISCONNECTED',
      payload: { tabId: port.sender?.tab?.id || null },
    }).catch(() => {
    });
  });
});

chrome.runtime.sendMessage({ type: 'INJECT_INJECT_JS' });

chrome.storage.local.get('courses', (data) => {
  if (!data.courses || data.courses.length === 0) {
    chrome.runtime.sendMessage({ type: 'REFRESH_COURSES' });
  }
});
