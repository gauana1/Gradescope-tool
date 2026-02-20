// content-script.js
window.addEventListener('message', (event) => {
  // Only handle messages from inject.js with correct source
  if (event.data && event.data.source === 'gradescope-archiver-inject') {
    // No-op for now
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // No-op for now
});
