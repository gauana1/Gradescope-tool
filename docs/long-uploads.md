# Handling Long Downloads & Uploads

## The Problem

A course upload is not a single operation. It involves:

```
10 assignments × 5 files each × avg 5MB per file
= 50 fetches from Gradescope
= 50 GitHub blob API calls
= potentially 5–10 minutes of continuous work

Chrome can kill background.js (service worker) after ~30 seconds of inactivity.
The popup will be closed by the user mid-upload.
Any unhandled error loses all progress.
```

The solution is to treat the upload as a **persistent job queue** that survives service worker restarts, popup closures, and partial failures.

---

## Pattern 1: Persistent Job Queue

Never hold upload state in memory. Write everything to `chrome.storage.local` before you start, and update it after every completed step.

### Building the queue

```js
// background.js — called when user clicks Upload
async function startUpload(courseId) {
  // 1. Scrape all file URLs first (before downloading anything)
  const files = await scrapeAllFileUrls(courseId);

  // 2. Build the full job and persist it immediately
  const job = {
    courseId,
    repoName: `gradescope-${courseId}`,
    visibility: "private",
    status: "in_progress",
    startedAt: Date.now(),
    files: files.map(f => ({
      url: f.url,
      path: f.path,
      status: "pending",
      blobSha: null,
    }))
  };

  await chrome.storage.local.set({ uploadJob: job });

  // 3. Start processing
  await processQueue();
}
```

### Processing the queue

```js
// background.js — processes one file at a time
async function processQueue() {
  const { uploadJob } = await chrome.storage.local.get("uploadJob");
  if (!uploadJob || uploadJob.status !== "in_progress") return;

  // Find next pending file
  const idx = uploadJob.files.findIndex(f => f.status === "pending");
  if (idx === -1) {
    // All files done — commit
    await createCommit(uploadJob);
    return;
  }

  // Mark as in_progress
  uploadJob.files[idx].status = "in_progress";
  await chrome.storage.local.set({ uploadJob });

  try {
    // Trigger inject.js fetch via content-script
    const b64 = await fetchFileViaPageContext(uploadJob.files[idx].url);

    // Upload to GitHub
    const blobSha = await createBlob(b64);

    // Mark done and save SHA — do this BEFORE moving to next file
    uploadJob.files[idx].status = "done";
    uploadJob.files[idx].blobSha = blobSha;
    await chrome.storage.local.set({ uploadJob });

    await reportProgress(uploadJob);

    // Process next file (recursive but with storage checkpoint between each)
    await processQueue();

  } catch (err) {
    uploadJob.files[idx].status = "error";
    uploadJob.files[idx].error = err.message;
    await chrome.storage.local.set({ uploadJob });

    await reportError(uploadJob.courseId, err);
  }
}
```

### Resuming after a crash

```js
// background.js — runs on service worker startup
chrome.runtime.onStartup.addListener(resumeIfJobPending);
chrome.runtime.onInstalled.addListener(resumeIfJobPending);

async function resumeIfJobPending() {
  const { uploadJob } = await chrome.storage.local.get("uploadJob");
  if (uploadJob && uploadJob.status === "in_progress") {
    // Reset any in_progress files back to pending (they were interrupted)
    uploadJob.files
      .filter(f => f.status === "in_progress")
      .forEach(f => { f.status = "pending"; });
    await chrome.storage.local.set({ uploadJob });
    await processQueue();
  }
}
```

---

## Pattern 2: Keepalive Port

An open MessageChannel port tells Chrome "this service worker is actively communicating — don't kill it."

```js
// background.js
function keepAlive() {
  chrome.tabs.query({ url: "*://*.gradescope.com/*" }, (tabs) => {
    if (!tabs.length) return;
    try {
      const port = chrome.tabs.connect(tabs[0].id, { name: "keepalive" });
      port.onDisconnect.addListener(() => {
        // Port closed — reconnect if job is still running
        chrome.storage.local.get("uploadJob").then(({ uploadJob }) => {
          if (uploadJob?.status === "in_progress") keepAlive();
        });
      });
    } catch (e) {
      // Tab may have navigated — try again shortly
      setTimeout(keepAlive, 5000);
    }
  });
}
```

```js
// content-script.js — just accept the connection, no logic needed
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "keepalive") {
    // Holding the port open is all that's needed
    port.onDisconnect.addListener(() => {});
  }
});
```

Call `keepAlive()` at the start of `startUpload()` and you're protected for the duration of the job.

---

## Pattern 3: File Size Check Before Downloading

Always check the file size BEFORE attempting a download. GitHub's blob API rejects files over 100MB and it wastes time to download a large file only to fail at the upload step.

```js
// inject.js — runs in page context
async function fetchFile(url) {
  // Step 1: HEAD request to check size
  let size = 0;
  try {
    const head = await fetch(url, { method: "HEAD" });
    size = parseInt(head.headers.get("Content-Length") || "0", 10);
  } catch (e) {
    // Some servers don't support HEAD — proceed and check after
  }

  const MAX_BYTES = 100 * 1024 * 1024; // 100 MB

  if (size > MAX_BYTES) {
    window.postMessage({
      source: "gradescope-archiver-inject",
      type: "FILE_TOO_LARGE",
      url,
      sizeBytes: size,
    });
    return;
  }

  // Step 2: Full GET request
  const response = await fetch(url);
  const buffer = await response.arrayBuffer();

  // Double-check after download (HEAD may have been missing Content-Length)
  if (buffer.byteLength > MAX_BYTES) {
    window.postMessage({
      source: "gradescope-archiver-inject",
      type: "FILE_TOO_LARGE",
      url,
      sizeBytes: buffer.byteLength,
    });
    return;
  }

  // Step 3: Convert to base64
  const b64 = arrayBufferToBase64(buffer);
  const mimeType = response.headers.get("Content-Type") || "application/octet-stream";

  window.postMessage({
    source: "gradescope-archiver-inject",
    type: "FETCH_RESULT",
    url,
    b64,
    mimeType,
    error: null,
  });
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
```

---

## Pattern 4: Progress Reporting (popup may be closed)

Progress must live in storage, not just in-memory messages. The popup may be closed and reopened mid-upload.

```js
// background.js
async function reportProgress(uploadJob) {
  const done = uploadJob.files.filter(f => f.status === "done").length;
  const total = uploadJob.files.length;
  const pct = Math.round((done / total) * 100);

  // Always write to storage — popup reads this on open
  await chrome.storage.local.set({
    [`progress_${uploadJob.courseId}`]: {
      step: `Uploading files (${done}/${total})`,
      pct,
      updatedAt: Date.now(),
    }
  });

  // Also try to notify popup if it's currently open (may fail silently if closed)
  chrome.runtime.sendMessage({
    type: "UPLOAD_PROGRESS",
    payload: { course_id: uploadJob.courseId, step: `Uploading files (${done}/${total})`, pct }
  }).catch(() => {}); // Popup being closed throws — ignore it
}
```

```js
// popup.js — on open, always read from storage first
async function initPopup() {
  const { uploadJob } = await chrome.storage.local.get("uploadJob");

  if (uploadJob?.status === "in_progress") {
    const stored = await chrome.storage.local.get(`progress_${uploadJob.courseId}`);
    const progress = stored[`progress_${uploadJob.courseId}`];
    if (progress) showProgressBar(progress.pct, progress.step);
  }

  // Then listen for live updates while popup is open
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "UPLOAD_PROGRESS") {
      showProgressBar(msg.payload.pct, msg.payload.step);
    }
    if (msg.type === "UPLOAD_DONE") {
      showSuccess(msg.payload.repoUrl);
    }
    if (msg.type === "UPLOAD_ERROR") {
      showError(msg.payload.error, msg.payload.retryable);
    }
  });
}
```

---

## Full Upload Timeline

```
User clicks Upload
      │
      ▼
background.js:
  1. keepAlive() — open port to prevent service worker death
  2. scrapeAllFileUrls() — navigate course pages, collect all file links
  3. Build job queue → chrome.storage.local.set({ uploadJob })
  4. processQueue() loop:
     
     For each pending file:
       a. window.postMessage → inject.js: fetch this URL
       b. HEAD check: skip if > 100MB
       c. fetch() with session cookies
       d. postMessage base64 back → content-script → background
       e. createBlob() via GitHub API
       f. mark file done in storage
       g. reportProgress() → storage + sendMessage
     
     After all files done:
       h. createTree(allBlobShas)
       i. createCommit(treeSha, "Archive course files")
       j. updateRef("refs/heads/main", commitSha)
       k. mark job complete in storage
       l. sendMessage UPLOAD_DONE

popup.js (open at any point):
  • reads progress from storage on open
  • receives live messages if open during upload
  • shows repo URL when done
```

---

## Error Handling Strategy

```
Network error on Gradescope fetch:
  → mark file as "error" in job queue
  → continue with remaining files
  → report partial success at end with list of failed files

GitHub API rate limit (403 with retry-after header):
  → read Retry-After header
  → set chrome.alarm for that many seconds
  → resume processQueue() from alarm handler

GitHub API blob rejected (file too large, content policy):
  → mark file as "skipped"
  → log reason
  → continue

All files errored:
  → mark job as "error"
  → show error UI with retry button
  → retry button calls processQueue() which picks up pending/error files
```
