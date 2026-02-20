// background.js
chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
  try {
    if (message && message.type === 'COURSES_FOUND') {
      const courses = message.payload || [];
      await chrome.storage.local.set({ courses });
      console.debug('background: persisted', courses.length, 'courses');
      // TODO: notify popup if open
      return true;
    }
  } catch (e) {
    console.error('background: onMessage error', e);
  }
});
