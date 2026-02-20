# Copilot Instructions — Gradescope Archiver Chrome Extension

## What We're Building
A Chrome Extension (Manifest V3, no native helper) that:
1. Scrapes Gradescope course/assignment pages while the user is logged in
2. Downloads files via page-context fetches (bypassing CORS)
3. Creates a GitHub repo and commits all files via the Git Data API

---

## Architecture Rules (NEVER violate these)

### Manifest
- Use **Manifest V3** only
- `background` key must use `"service_worker": "background.js"` — NOT `"page"`
- No `"persistent": true`
- `inject.js` must NOT be listed in `content_scripts` — it is injected programmatically only

### Service Worker — background.js
- Use `fetch()` only — NO `XMLHttpRequest`
- NO module-level mutable state (service worker is killed by Chrome after ~30s of inactivity)
- ALL persistent state goes in `chrome.storage.local`
- Use `chrome.alarms` or a keepalive port for long-running upload jobs
- GitHub API calls happen HERE only — nowhere else

### Content Scripts — content-script.js
- Can read/write DOM
- CANNOT make cross-origin requests (CORS blocks them)
- CANNOT access the page's JS variables
- Communicates with background ONLY via `chrome.runtime.sendMessage` / `onMessage`
- Communicates with inject.js ONLY via `window.postMessage`

### Page Context — inject.js
- Injected via `chrome.scripting.executeScript` with `world: "MAIN"`
- Runs in the same JS world as Gradescope's own scripts — can fetch() with session cookies
- CANNOT use any `chrome.*` APIs
- Communicates with content-script ONLY via `window.postMessage`
- Always tag messages with `source: "gradescope-archiver-inject"` to avoid collisions

### Popup — popup.js
- Killed when user closes popup — NEVER store state in popup JS variables
- On open, always read current state from `chrome.storage.local`
- Also listen for live `chrome.runtime.onMessage` updates if popup stays open

---

## Message Flow (do not deviate)

```
popup.js
  → chrome.runtime.sendMessage({type:"START_UPLOAD", ...})
background.js
  → chrome.scripting.executeScript (injects content-script if needed)
  → chrome.tabs.sendMessage({type:"SCRAPE_COURSE", ...})
content-script.js
  → window.postMessage({source:"gradescope-archiver-inject", type:"FETCH_FILE", url:"..."})
inject.js
  → fetch(url)  ← works because same-origin session cookies apply
  → window.postMessage({source:"gradescope-archiver-inject", type:"FETCH_RESULT", b64:"..."})
content-script.js
  → chrome.runtime.sendMessage({type:"FILE_DATA", b64:"...", filename:"..."})
background.js
  → GitHub Git Data API (createBlob → createTree → createCommit → updateRef)
  → chrome.runtime.sendMessage({type:"UPLOAD_DONE", repoUrl:"...", sha:"..."})
popup.js
  ← displays result
```

---

## File Responsibilities

| File | Owns |
|------|------|
| `manifest.json` | Permissions, CSP, host_permissions, content_scripts registration |
| `background.js` | GitHub API, chrome.storage, job queue, message routing, OAuth token mgmt |
| `content-script.js` | DOM scraping, inject.js relay, message bridge to background |
| `inject.js` | Authenticated fetch() in page context, postMessage relay only |
| `popup.html` / `popup.js` | Course list UI, upload triggers, progress display |
| `options.html` / `options.js` | GitHub OAuth flow, token save/clear |
| `github-api.js` | Pure functions: createRepo, createBlob, createTree, createCommit, updateRef |
| `scraper.js` | Pure functions: parseCourseList, parseAssignments, parseFileLinks |

---

## Data Shapes (use EXACTLY these field names)

### Course object — stored under key `courses` in chrome.storage.local
```json
{
  "course_id": "123456",
  "full_name": "CS 101 - Introduction to Programming",
  "rename": "cs101",
  "github_repo": "gradescope-cs101",
  "last_synced": "2024-01-15T10:30:00Z",
  "status": "idle"
}
```
`status` values: `idle` | `uploading` | `done` | `error`

### Upload job — stored under key `uploadJob` in chrome.storage.local
```json
{
  "courseId": "123456",
  "repoName": "gradescope-cs101",
  "visibility": "private",
  "status": "in_progress",
  "files": [
    { "url": "/submissions/1/file.pdf", "path": "hw1/file.pdf", "status": "done" },
    { "url": "/submissions/2/notes.pdf", "path": "hw1/notes.pdf", "status": "pending" }
  ]
}
```
File status values: `pending` | `in_progress` | `done` | `error` | `skipped`

### chrome.runtime.sendMessage types
```js
{ type: "COURSES_FOUND",    payload: [ /* course objects */ ] }
{ type: "START_UPLOAD",     payload: { course_id: "123456" } }
{ type: "UPLOAD_PROGRESS",  payload: { course_id, step: "Creating blobs", pct: 42 } }
{ type: "UPLOAD_DONE",      payload: { course_id, repoUrl, sha } }
{ type: "UPLOAD_ERROR",     payload: { course_id, error, retryable: true } }
{ type: "SCRAPE_COURSE",    payload: { course_id } }
{ type: "FILE_DATA",        payload: { filename, path, b64, mimeType } }
{ type: "FILE_TOO_LARGE",   payload: { filename, url, sizeBytes } }
```

### window.postMessage envelope (inject.js ↔ content-script.js)
```js
// content-script → inject
{ source: "gradescope-archiver-inject", type: "FETCH_FILE",   url: "https://gradescope.com/..." }

// inject → content-script
{ source: "gradescope-archiver-inject", type: "FETCH_RESULT", url, b64, mimeType, error: null }
{ source: "gradescope-archiver-inject", type: "FILE_TOO_LARGE", url, sizeBytes }
```

---

## GitHub OAuth Rules
- Use `chrome.identity.launchWebAuthFlow` — NOT a localhost redirect server
- OAuth app redirect URI must be exactly: `https://<extension-id>.chromiumapp.org/`
- Scopes: `repo` only
- Store token under key `githubToken` in `chrome.storage.local`
- Never log or expose the token in console output or UI
- Token retrieval: `const { githubToken } = await chrome.storage.local.get('githubToken')`

---

## Long Upload Rules
- Build full job queue in `chrome.storage.local` BEFORE starting any fetches
- Process files sequentially, one at a time
- Mark each file `done` in storage immediately after its blob is created
- Use keepalive port to prevent service worker termination during uploads (see docs/long-uploads.md)
- Detect file size via HEAD request BEFORE downloading — skip and report files > 100 MB
- After all blobs collected: createTree → createCommit → updateRef in one sequence
- Report progress via storage AND sendMessage so popup works whether open or closed

---

## Known Pitfalls (AVOID these patterns)

- ❌ DO NOT `fetch()` Gradescope URLs from content-script or background — CORS will block
- ❌ DO NOT use `chrome.tabs.executeScript` (MV2) — use `chrome.scripting.executeScript` (MV3)
- ❌ DO NOT store raw ArrayBuffers in chrome.storage — convert to base64 string first
- ❌ DO NOT assume service worker is alive between messages — always re-read state from storage
- ❌ DO NOT use `window.location` or `document` in background.js — it has no DOM
- ❌ DO NOT list inject.js in manifest content_scripts — inject programmatically with `world:"MAIN"`
- ❌ DO NOT use `alert()` or `confirm()` in content scripts or background
- ❌ DO NOT store Gradescope cookies or session data anywhere
- ❌ DO NOT use `XMLHttpRequest` anywhere — `fetch()` only
- ❌ DO NOT use `localStorage` or `sessionStorage` — use `chrome.storage.local`

---

## Tests
- Test files go in `/tests/` using Jest with `jest-chrome` for mocked Chrome APIs
- Test files: `github-api.test.js`, `scraper.test.js`, `message-handler.test.js`
- Fixture HTML files go in `/tests/fixtures/` (real Gradescope HTML with PII removed)
- No e2e tests requiring a real browser — mock all Chrome APIs
- Parser functions must be pure (no chrome.* calls) so they can be tested directly

---

## Reference Docs
- Full architecture explanation: `docs/architecture.md`
- CORS deep dive: `docs/cors-explained.md`
- Long upload patterns: `docs/long-uploads.md`
- Prompting guide: `docs/prompting-guide.md`
- Project plan: `docs/plan.md`
- Python source to port selectors from: `gradescope_lib.py`, `gradescope_archiver.py`
