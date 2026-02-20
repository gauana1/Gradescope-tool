# Prompting Guide — Getting Good Output from Copilot Agent

## The Core Rule

Always specify three things in every prompt:
1. **Which file** the code goes in
2. **Which communication mechanism** connects it to other worlds
3. **Which direction** data flows

Copilot knows Chrome extension architecture. It just needs anchoring — without it, it will confidently generate code in the wrong world, using the wrong fetch mechanism, storing state in the wrong place.

---

## Before / After Examples

### Fetching a Gradescope file

❌ **Too vague — will get CORS-broken code:**
> "Write a function to download a file from Gradescope"

✅ **Specific — will get working code:**
> "Write a function in `inject.js` that runs in page context (world: MAIN). It receives a URL via `window.postMessage` with `source: 'gradescope-archiver-inject'` and `type: 'FETCH_FILE'`. It should: (1) do a HEAD request to check Content-Length, (2) skip with `FILE_TOO_LARGE` postMessage if > 100MB, (3) fetch the full file, (4) convert ArrayBuffer to base64, (5) postMessage back with `type: 'FETCH_RESULT'` and fields `url`, `b64`, `mimeType`. Use the arrayBufferToBase64 helper."

---

### GitHub upload

❌ **Too vague — may put GitHub calls in wrong file:**
> "Write the GitHub upload code"

✅ **Specific:**
> "Write a module `github-api.js` with pure async functions (no chrome.* calls, fetch only): `createRepo(token, name, isPrivate)`, `createBlob(token, owner, repo, b64, encoding='base64')`, `createTree(token, owner, repo, blobs)` where blobs is `[{path, sha}]`, `createCommit(token, owner, repo, treeSha, parentSha, message)`, `updateRef(token, owner, repo, commitSha)`. Each function throws a descriptive Error on non-2xx response. Do not import or use chrome.* APIs — the token is passed in as a parameter."

---

### Message routing in background.js

❌ **Too vague:**
> "Connect everything together"

✅ **Specific:**
> "Write the `chrome.runtime.onMessage.addListener` handler in `background.js`. It should route these message types using the exact shapes in `.github/copilot-instructions.md`: `COURSES_FOUND` (save to storage under key 'courses'), `FILE_DATA` (call createBlob and update uploadJob in storage), `START_UPLOAD` (call startUpload function), `FILE_TOO_LARGE` (mark file as skipped in uploadJob). Each case should be its own async handler function. Read githubToken from chrome.storage.local at the start of each handler that needs it — do not assume it's in memory."

---

### Content script scraping

❌ **Too vague:**
> "Scrape the Gradescope course list"

✅ **Specific:**
> "Write `parseCourseList(document)` in `scraper.js` as a pure function (no chrome.* calls, no fetch). It takes a DOM document object and returns an array of course objects with fields: `course_id` (from the href `/courses/123`), `full_name` (text content of `.courseBox--shortname` and `.courseBox--name` combined). Port the selector logic from `gradescope_lib.py`'s `get_courses` method. This function must be importable in Jest tests with a fixture HTML document."

---

### Progress reporting

❌ **Too vague:**
> "Show upload progress"

✅ **Specific:**
> "Write the `reportProgress(uploadJob)` function in `background.js` following the pattern in `docs/long-uploads.md`. It should: (1) compute pct from done/total files, (2) write `progress_{courseId}` to chrome.storage.local, (3) call chrome.runtime.sendMessage with type UPLOAD_PROGRESS — catching and ignoring the error if popup is closed. Then write the `initPopup()` function in `popup.js` that on open reads the current progress from storage and renders it, then sets up a chrome.runtime.onMessage listener for live updates."

---

### Job queue setup

❌ **Too vague:**
> "Handle long uploads"

✅ **Specific:**
> "Following the persistent job queue pattern in `docs/long-uploads.md`, write `startUpload(courseId)` and `processQueue()` in `background.js`. `startUpload` should: get all file URLs (call `scrapeAllFileUrls`), build the uploadJob object with the shape from copilot-instructions.md, save it to chrome.storage.local, then call processQueue. `processQueue` should: read uploadJob from storage, find the first pending file, mark it in_progress in storage, trigger inject.js fetch via content-script message, receive b64 back, call createBlob, mark done in storage, call reportProgress, then recursively call processQueue. On error: mark file as error in storage, call reportError, do NOT re-throw."

---

### Keepalive

❌ **Too vague:**
> "Prevent the background from dying"

✅ **Specific:**
> "Write the `keepAlive()` function in `background.js` exactly as described in `docs/long-uploads.md`. It should: query for a Gradescope tab, connect a port named 'keepalive', and on disconnect check storage — if uploadJob.status is still 'in_progress', call keepAlive() again. Also write the corresponding `onConnect` listener in `content-script.js` that accepts the keepalive port and does nothing else."

---

### OAuth flow

❌ **Too vague:**
> "Add GitHub login"

✅ **Specific:**
> "Write `initiateGitHubOAuth()` in `options.js` using `chrome.identity.launchWebAuthFlow`. The redirect URL must be `chrome.identity.getRedirectURL()`. The auth URL should go to `https://github.com/login/oauth/authorize` with `client_id` read from a constant at top of file, `scope: 'repo'`, and `redirect_uri`. After the flow returns, extract the `code` param from the redirect URL, exchange it for a token by calling `background.js` via `chrome.runtime.sendMessage({type:'EXCHANGE_OAUTH_CODE', code})`, and display the result. The token exchange must happen in background.js, not options.js, because the client_secret must never be in content scripts."

---

## Prompting for Tests

❌ **Too vague:**
> "Write tests for the GitHub API"

✅ **Specific:**
> "Write Jest tests in `tests/github-api.test.js` for the functions in `github-api.js`. Mock `fetch` using `jest.fn()`. Test: (1) `createRepo` sends POST to `/user/repos` with correct JSON body and Authorization header, (2) `createBlob` sends correct base64 content, (3) `createCommit` throws when fetch returns 422. Do not use jest-chrome — github-api.js has no chrome.* calls so no mocking needed."

---

## Useful Phrases to Include in Any Prompt

- `"...as a pure function (no chrome.* calls)"` — makes functions testable
- `"...read token from chrome.storage.local at call time, not from a module variable"` — prevents stale state
- `"...catch and ignore the error if popup is closed"` — prevents unhandled rejection noise
- `"...mark in storage before proceeding"` — ensures crash-safe checkpointing
- `"...following the message shapes in .github/copilot-instructions.md"` — enforces consistent field names
- `"...injected with world: 'MAIN', not listed in manifest"` — keeps inject.js correctly scoped

---

## When to Paste Docs into Your Prompt

For complex prompts, paste the relevant section from docs/ directly into your prompt:

- Building the job queue → paste the queue shape from copilot-instructions.md
- Writing inject.js → paste the postMessage envelope shape
- Writing any background.js orchestration → paste the full message flow diagram from architecture.md
- Any Gradescope fetch logic → paste the CORS checklist from cors-explained.md

Copilot works best when the constraints are right there in the prompt, not just referenced by filename.
