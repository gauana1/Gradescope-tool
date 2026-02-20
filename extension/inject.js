// inject.js
window.addEventListener('message', (event) => {
  if (event.data && event.data.source === 'gradescope-archiver-inject') {
    // No-op for now
  }
});
