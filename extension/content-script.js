// content-script.js
// content-script.js
// Listen for postMessage from inject.js (page-context fetcher)
window.addEventListener('message', (event) => {
  // Debug: log incoming messages
  try {
    // console.debug for less noisy logs in normal usage
    // console.debug('content-script received postMessage', event.data && event.data.source, event.data && event.data.type);
  } catch (e) {}

  // Bridge: allow the page world to request parsers from this content script.
  // Page can postMessage({ source: 'gradescope-archiver-page', type: 'RUN_PARSE_COURSE_LIST' })
  if (event.data && event.data.source === 'gradescope-archiver-page') {
    try {
      console.debug('content-script: handling page request', event.data.type);
      if (event.data.type === 'RUN_PARSE_COURSE_LIST') {
        const hasScraper = !!(window.gradescopeScraper && typeof window.gradescopeScraper.parseCourseList === 'function');
        console.debug('content-script: hasScraper', hasScraper);
        const parsed = hasScraper ? window.gradescopeScraper.parseCourseList(document) : null;
        const normalized = (parsed && window.gradescopeScraper.normalizeCourses)
          ? window.gradescopeScraper.normalizeCourses(parsed)
          : null;

        // Notify background with standardized course objects so popup/background can persist
        try {
          if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
            chrome.runtime.sendMessage({ type: 'COURSES_FOUND', payload: normalized });
          }
        } catch (e) {
          console.debug('content-script: chrome.runtime not available to send COURSES_FOUND');
        }

        window.postMessage({ source: 'gradescope-archiver-page', type: 'PARSE_RESULT', requestId: event.data && event.data.requestId, payload: { parsed, normalized } }, '*');
      }
      // Add other page-triggered actions here as needed
      } catch (err) {
        console.error('content-script: parse error', err);
        window.postMessage({ source: 'gradescope-archiver-page', type: 'PARSE_ERROR', requestId: event.data && event.data.requestId, error: String(err) }, '*');
      }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // No-op for now
});
