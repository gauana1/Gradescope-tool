// content-script.js

// Listen for postMessage from inject.js (page-context fetcher)
window.addEventListener('message', (event) => {

  if (event.data && event.data.source === 'gradescope-archiver-page') {
    try {
      if (event.data.type === 'RUN_PARSE_COURSE_LIST') {
        const hasScraper = !!(window.gradescopeScraper && typeof window.gradescopeScraper.parseCourseList === 'function');
        const parsed = hasScraper ? window.gradescopeScraper.parseCourseList(document) : null;
        const normalized = (parsed && window.gradescopeScraper.normalizeCourses)
          ? window.gradescopeScraper.normalizeCourses(parsed)
          : null;

        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage({ type: 'COURSES_FOUND', payload: normalized });
        }

        window.postMessage({
          source: 'gradescope-archiver-page',
          type: 'PARSE_RESULT',
          requestId: event.data.requestId,
          payload: { parsed, normalized },
        }, '*');
      }
    } catch (err) {
      console.error('content-script: parse error', err);
      window.postMessage({
        source: 'gradescope-archiver-page',
        type: 'PARSE_ERROR',
        requestId: event.data.requestId,
        error: String(err),
      }, '*');
    }
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'SCRAPE_COURSES') {
    if (window.gradescopeScraper && window.gradescopeScraper.parseCourseList) {
      const courses = window.gradescopeScraper.parseCourseList(document);
      const normalized = window.gradescopeScraper.normalizeCourses
        ? window.gradescopeScraper.normalizeCourses(courses)
        : courses;
      chrome.runtime.sendMessage({ type: 'COURSES_FOUND', payload: normalized });
    }
  }
});

// Inject scraper.js and inject.js into the page MAIN world on load
chrome.runtime.sendMessage({ type: 'INJECT_INJECT_JS' });

// Auto-populate courses if storage is empty
chrome.storage.local.get('courses', (data) => {
  if (!data.courses || data.courses.length === 0) {
    chrome.runtime.sendMessage({ type: 'REFRESH_COURSES' });
  }
});
