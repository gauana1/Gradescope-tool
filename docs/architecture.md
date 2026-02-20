# Architecture — Gradescope Archiver Chrome Extension

## The Four Isolated Worlds

A Chrome extension is not one program. It is four separate programs that cannot share variables or call each other's functions. They communicate only through narrow message-passing pipes.

```
┌─────────────────────────────────────────────────────────────────┐
│                         CHROME BROWSER                           │
│                                                                  │
│  ┌──────────────────────┐      ┌────────────────────────────┐   │
│  │    background.js     │      │       popup.html/js         │   │
│  │   (Service Worker)   │◄────►│  (shown when icon clicked)  │   │
│  │                      │      │                             │   │
│  │  • GitHub API calls  │      │  • course list UI           │   │
│  │  • chrome.storage    │      │  • upload buttons           │   │
│  │  • OAuth token mgmt  │      │  • progress display         │   │
│  │  • job queue         │      │  • reads state from storage │   │
│  │  • message routing   │      │                             │   │
│  └──────────┬───────────┘      └────────────────────────────┘   │
│             │                                                     │
│             │  chrome.tabs.sendMessage / chrome.runtime.onMessage │
│             │                                                     │
│  ┌──────────▼──────────────────────────────────────────────┐    │
│  │                   GRADESCOPE TAB                         │    │
│  │                                                          │    │
│  │  ┌────────────────────────────────────────────────────┐ │    │
│  │  │  content-script.js   (isolated JS sandbox)          │ │    │
│  │  │                                                      │ │    │
│  │  │  • reads/modifies DOM (can scrape HTML)              │ │    │
│  │  │  • CANNOT fetch Gradescope URLs (CORS blocks it)     │ │    │
│  │  │  • CANNOT see Gradescope's own JS variables          │ │    │
│  │  │  • talks to background via chrome.runtime.sendMessage│ │    │
│  │  │  • talks to inject.js via window.postMessage ONLY    │ │    │
│  │  │                                                      │ │    │
│  │  │         window.postMessage ▲▼ window.postMessage     │ │    │
│  │  │                                                      │ │    │
│  │  │  inject.js   (page's real JS world — world:"MAIN")   │ │    │
│  │  │                                                      │ │    │
│  │  │  • same JS sandbox as Gradescope's own scripts       │ │    │
│  │  │  • fetch() works WITH session cookies (same-origin)  │ │    │
│  │  │  • CANNOT use any chrome.* APIs                      │ │    │
│  │  │  • injected programmatically, NOT in manifest        │ │    │
│  │  └────────────────────────────────────────────────────┘ │    │
│  │                                                          │    │
│  │  gradescope.com HTML / CSS / JS                         │    │
│  └──────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

---

## Capability Matrix

| Capability | background.js | content-script.js | inject.js | popup.js |
|---|---|---|---|---|
| Read page DOM | ❌ | ✅ | ✅ | only popup's own DOM |
| fetch() Gradescope URLs | ❌ CORS | ❌ CORS | ✅ session cookies | ❌ CORS |
| fetch() GitHub API | ✅ | ❌ CORS | ❌ | ❌ CORS |
| chrome.storage | ✅ | ✅ | ❌ | ✅ |
| chrome.identity (OAuth) | ✅ | ❌ | ❌ | ❌ |
| chrome.scripting | ✅ | ❌ | ❌ | ❌ |
| Survives tab close | ✅* | ❌ | ❌ | ❌ |
| Survives popup close | ✅* | ✅ | ✅ | ❌ |

*background.js survives tab/popup close but Chrome can still kill it after ~30s inactivity. See long-uploads.md.

---

## Full Message Flow for a File Upload

```
1. User clicks "Upload" in popup.js
   │
   │  chrome.runtime.sendMessage({ type: "START_UPLOAD", payload: { course_id } })
   ▼
2. background.js receives START_UPLOAD
   • reads githubToken from chrome.storage.local
   • reads course metadata from chrome.storage.local
   • calls keepAlive() to hold a port open (prevents service worker death)
   • navigates to or finds the Gradescope course tab
   │
   │  chrome.tabs.sendMessage(tabId, { type: "SCRAPE_COURSE", payload: { course_id } })
   ▼
3. content-script.js receives SCRAPE_COURSE
   • querySelectorAll() on the DOM to find assignment rows and file links
   • for each file URL it needs to download:
   │
   │  window.postMessage({ source: "gradescope-archiver-inject", type: "FETCH_FILE", url })
   ▼
4. inject.js (running in page's real JS world)
   • does HEAD request first to check Content-Length
   • if > 100MB: postMessage FILE_TOO_LARGE and skip
   • otherwise: fetch(url) — browser sends Gradescope session cookies automatically
   • converts ArrayBuffer response to base64 string
   │
   │  window.postMessage({ source: "gradescope-archiver-inject", type: "FETCH_RESULT", b64, url })
   ▼
5. content-script.js receives FETCH_RESULT
   │
   │  chrome.runtime.sendMessage({ type: "FILE_DATA", payload: { filename, path, b64, mimeType } })
   ▼
6. background.js receives FILE_DATA
   • calls github-api.js: createBlob(b64, mimeType)
   • saves blob SHA + path to uploadJob in chrome.storage.local
   • marks file as "done" in job queue
   • calls reportProgress()
   [repeat steps 3–6 for each file]
   
   After all files:
   • createTree(blobs)
   • createCommit(treeSha, message)
   • updateRef(commitSha)
   │
   │  chrome.runtime.sendMessage({ type: "UPLOAD_DONE", payload: { repoUrl, sha } })
   ▼
7. popup.js (if open) receives UPLOAD_DONE
   • shows success banner with link to repo
   • (if popup was closed during upload, it reads final state from storage on next open)
```

---

## Why background.js Dies and What To Do About It

In Manifest V3, background.js is a **Service Worker** — the same technology used in Progressive Web Apps. Chrome unloads it after approximately 30 seconds of inactivity to save memory. It will restart when a new event arrives, but:

```js
// ❌ This variable is GONE after Chrome kills and restarts background.js
let uploadInProgress = true;
let currentFileIndex = 3;

// ✅ This survives because it's in persistent storage
await chrome.storage.local.set({ uploadInProgress: true, currentFileIndex: 3 });
```

This is why the job queue must live in `chrome.storage.local`, not in memory. On every restart, background.js reads storage to find out where it left off.

---

## File Map

```
extension/
├── manifest.json           # permissions, host_permissions, content_scripts
├── background.js           # service worker — orchestration, GitHub API, storage
├── content-script.js       # DOM scraping, inject.js relay
├── inject.js               # page-context fetches (world: "MAIN")
├── popup.html              # extension popup markup
├── popup.js                # popup logic — reads storage, sends messages
├── options.html            # GitHub OAuth settings page
├── options.js              # OAuth flow, token management
├── github-api.js           # pure GitHub Git Data API functions
├── scraper.js              # pure DOM parsing functions (no chrome.* calls)
└── tests/
    ├── github-api.test.js
    ├── scraper.test.js
    ├── message-handler.test.js
    └── fixtures/
        ├── course-list.html    # sample Gradescope HTML (PII removed)
        └── assignment-page.html
```
