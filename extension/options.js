// options.js
window.addEventListener('DOMContentLoaded', async () => {
  const { githubToken } = await chrome.storage.local.get('githubToken');
  if (githubToken) {
    document.getElementById('github-token').placeholder = 'Token saved (hidden)';
    setStatus('A token is already saved.', 'ok');
  }
});

document.getElementById('save-btn').addEventListener('click', async () => {
  const token = document.getElementById('github-token').value.trim();
  if (!token) {
    setStatus('Please enter a token.', 'error');
    return;
  }
  await chrome.storage.local.set({ githubToken: token });
  document.getElementById('github-token').value = '';
  document.getElementById('github-token').placeholder = 'Token saved (hidden)';
  setStatus('Token saved!', 'ok');
});

document.getElementById('clear-btn').addEventListener('click', async () => {
  await chrome.storage.local.remove('githubToken');
  document.getElementById('github-token').value = '';
  document.getElementById('github-token').placeholder = 'GitHub Personal Access Token';
  setStatus('Token cleared.', 'info');
});

document.getElementById('oauth-btn').addEventListener('click', () => {
  setStatus('OAuth not yet configured. Use a Personal Access Token (repo scope) for now.', 'error');
});

function setStatus(msg, cls) {
  const el = document.getElementById('status');
  if (el) {
    el.textContent = msg;
    el.className = `status-${cls}`;
  }
}
