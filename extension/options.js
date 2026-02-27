// options.js

window.addEventListener('DOMContentLoaded', async () => {
  const { githubToken, ghUser } = await chrome.storage.local.get(['githubToken', 'ghUser']);
  if (githubToken) setStatus('Token loaded. Paste a new one to replace it.', 'info');
  if (ghUser?.login) showUserPanel(ghUser);
});

document.getElementById('token-eye')?.addEventListener('click', () => {
  const inp = document.getElementById('token-input');
  inp.type = inp.type === 'password' ? 'text' : 'password';
});

document.getElementById('save-btn')?.addEventListener('click', async () => {
  const btn   = document.getElementById('save-btn');
  const inp   = document.getElementById('token-input');
  const token = inp.value.trim();

  if (!token) { setStatus('Paste a token first.', 'err'); return; }

  btn.disabled = true;
  btn.textContent = 'Validating…';
  inp.classList.remove('valid', 'invalid');
  setStatus('Checking token with GitHub…', 'info');

  try {
    const result = await chrome.runtime.sendMessage({ type: 'VALIDATE_TOKEN', payload: { token } });
    if (result?.ok) {
      inp.classList.add('valid');
      inp.value = '';
      await chrome.storage.local.set({ githubToken: token, ghUser: result.user });
      showUserPanel(result.user);
      setStatus(`✓ Token saved! Signed in as @${result.user?.login}`, 'ok');
    } else {
      inp.classList.add('invalid');
      setStatus(`✗ ${result?.error || 'Token invalid — ensure "repo" scope is checked.'}`, 'err');
      hideUserPanel();
    }
  } catch (err) {
    inp.classList.add('invalid');
    setStatus(`✗ ${err.message || 'Validation failed.'}`, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '✓ Save & Validate';
  }
});

document.getElementById('clear-btn')?.addEventListener('click', async () => {
  await chrome.storage.local.remove(['githubToken', 'ghUser']);
  const inp = document.getElementById('token-input');
  inp.value = '';
  inp.classList.remove('valid', 'invalid');
  hideUserPanel();
  setStatus('Token removed.', 'info');
});

function setStatus(msg, cls) {
  const el = document.getElementById('token-status');
  if (!el) return;
  el.textContent = msg;
  el.className = `status-msg ${cls}`;
}

function showUserPanel(user) {
  const panel  = document.getElementById('gh-user-panel');
  const avatar = document.getElementById('opt-avatar');
  const login  = document.getElementById('opt-login');
  if (!panel) return;
  if (avatar) avatar.src = user?.avatarUrl || '';
  if (login)  login.textContent = `@${user?.login || '—'}`;
  panel.classList.remove('hidden');
}

function hideUserPanel() {
  document.getElementById('gh-user-panel')?.classList.add('hidden');
}
