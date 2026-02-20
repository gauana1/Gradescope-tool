# Plan: Chrome Extension Port (Pure-Extension, Core Features)

## TL;DR
Build a Chrome extension (no native helper) that uses content scripts to scrape Gradescope while the user is logged in, and uses GitHub OAuth + the Git Data API to create repositories and push course files.

**Success criteria:** User selects a course in the extension UI, clicks "Upload course", and the extension creates a GitHub repo and commits the course files.

**Major constraints:** CORS/SSO, per-file GitHub size limits, and limited filesystem access.

---

## Steps

### 1. Project Skeleton
Add `manifest.json`, `background.js` (service worker), `popup.html/js`, `options.html/js`, `content-script.js`, and `inject.js` (page context fetches).

Permissions to request: Gradescope hosts, `https://api.github.com/*`, `storage`, `identity`, `downloads`.

### 2. Auth
- **GitHub:** implement OAuth via `chrome.identity.launchWebAuthFlow`; request `repo` scope; save token in `chrome.storage.local`
- **Gradescope:** rely on the user's existing browser session — do not store Gradescope cookies

### 3. Course Discovery
- `content-script.js` runs on Gradescope course-list pages, scrapes course metadata (selectors from `gradescope_lib.py`) and sends to `background.js`
- Popup shows courses with checkboxes and action buttons ("Upload course", "Upload assignment")

### 4. Authenticated Downloads
- For each file link, inject `inject.js` in page context to `fetch()` the resource — same-origin cookies/SSO apply
- Convert responses to base64 and transfer to `background.js` via chrome.runtime messaging
- Fallback: open link in new tab and ask user to download & re-upload if programmatic fetch is blocked

### 5. GitHub Upload
- `background.js` implements Git Data API flow:
  1. `POST /user/repos` — create repo
  2. `POST /repos/:owner/:repo/git/blobs` — create blob per file
  3. Create tree from all blobs
  4. Create commit
  5. Update ref to point to commit
- Batch files into a single commit. Detect files > 100MB and surface an error.

### 6. Local Metadata
Store a `courses` mapping in `chrome.storage.local` mirroring `courses.json` fields:
`course_id`, `full_name`, `rename`, `github_repo`, `last_synced`

### 7. UI/UX
- Popup lists courses and status
- Upload confirmation modal with repo name, visibility options, and final "Upload" button
- Progress display, retry handling, and final repo URL on success

### 8. Safety & Destructive Ops
- Do not auto-implement bulk-delete (`--nuke-all`)
- If added later: require re-auth and multi-step confirmation

### 9. Edge Cases
- CORS failures → clear error messaging
- Large files (> 100MB) → skip and report, continue with others
- GitHub rate limits → read Retry-After header, wait, resume
- Partial failures → retry UI per file

### 10. Tests & Packaging
- Local install instructions (Load Unpacked)
- Unit tests for GitHub helpers (mocked fetch)
- Integration checklist for manual QA

---

## Verification — Success Criteria

### Manual Test Flow
1. User logged into Gradescope in Chrome
2. Install extension (Load unpacked)
3. Authenticate GitHub via extension options (OAuth); token stored
4. Open extension popup: visible list of courses detected on Gradescope pages
5. User selects a course and clicks "Upload course"
6. Extension scrapes course pages, downloads assignment files via injected page fetches, creates a GitHub repo, and commits files
7. On completion: extension shows success, commit SHA, and a link to the new repo
8. Repo contains expected folder structure: `course/assignment/file`

### Failure Tests
- Upload with > 100MB file → extension reports file-size error and aborts that file, but completes others
- Network / GitHub errors → retryable error UI shown

### Automated Tests
- Unit tests for GitHub API functions (mocked)
- Simulated content-script messages to background uploader with sample blobs

---

## Decisions

| Decision | Choice | Reason |
|---|---|---|
| Approach | Pure extension (no native helper) | Allows Web Store publishing |
| Git integration | GitHub OAuth + REST/Git Data API | No `git`/`gh` CLI needed |
| Scope | Core features first | Postpone `nuke-all` and archive extraction |
| Auth storage | `chrome.storage.local` for GitHub token only | Don't store Gradescope session |
| Destructive ops | Require re-auth and multi-step confirmation | Safety |

---

## Files to Consult / Reuse

| File | Purpose |
|---|---|
| `gradescope_lib.py` | Scraping logic and CSS selectors to port |
| `gradescope_archiver.py` | CLI orchestration and high-level flows |
| `gradescope_course_manager.py` | Course metadata model |
| `gradescope_auth.json` | Example Playwright storage_state (reference only — do not use auth data) |
