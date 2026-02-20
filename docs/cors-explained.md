# CORS — What It Is and Why It Matters for This Extension

## What CORS Is

**Cross-Origin Resource Sharing** is a browser security rule. It says: a webpage can only freely talk to its own server. If code from `gradescope.com` tries to fetch from `github.com`, the browser checks whether GitHub allows it.

```
Same-origin request (always works):
  gradescope.com page → fetch("https://gradescope.com/courses/123")  ✅
  Same domain. Browser allows it. No questions asked.

Cross-origin request (needs permission):
  gradescope.com page → fetch("https://github.com/api/v3/repos")
       │
       ▼
  Browser checks GitHub's response headers for:
  Access-Control-Allow-Origin: *   or   Access-Control-Allow-Origin: gradescope.com
       │
  found ✅                          not found ❌
  JS can read the response          Browser BLOCKS the response
```

**Important:** The request usually goes out. The server receives it. CORS only controls whether the browser lets your JavaScript *read the response*. Gradescope's server sees the request — it just doesn't include the CORS header that would allow extension code to read the reply.

---

## Why Each World Can or Cannot Fetch What

### inject.js → Gradescope ✅ Works

inject.js runs in `world: "MAIN"` — the page's own JavaScript sandbox. The browser treats it as if Gradescope's own code is making the request.

```
Browser sees:  origin = gradescope.com
Gradescope:    same-origin request → cookies sent automatically → response allowed
```

This is identical to opening Chrome DevTools on gradescope.com and typing `fetch("/courses/123")` in the console. It works because you ARE the page.

### content-script.js → Gradescope ❌ CORS blocked

Content scripts run in an isolated sandbox. Despite living inside the Gradescope tab visually, the browser treats their requests as coming from the extension origin.

```
Browser sees:  origin = chrome-extension://abcdef123
Gradescope:    unknown origin → no CORS header → browser blocks response
```

### background.js → Gradescope ❌ CORS blocked + no session

Even if CORS weren't an issue, background.js has no access to the user's Gradescope session cookies. Any fetch to Gradescope would get a login redirect, not the actual page content.

### background.js → GitHub API ✅ Works

GitHub's REST API explicitly allows all origins:
```
Access-Control-Allow-Origin: *
```

GitHub designed their API to be called from any origin, including browser extensions. That's why GitHub calls live in background.js — it's the only world that can make cross-origin requests to external APIs AND handle the auth token securely.

---

## The Solution: inject.js as the Fetch Proxy

Because only inject.js can fetch Gradescope files, it acts as a proxy for the rest of the extension:

```
background.js needs file at: https://gradescope.com/submissions/123/file.pdf
                    │
                    │  can't fetch it directly (CORS + no cookies)
                    │
                    ▼
content-script.js relays the request via window.postMessage
                    │
                    ▼
inject.js fetches the URL ← browser sends session cookies, response comes back
inject.js converts to base64
inject.js sends base64 back via window.postMessage
                    │
                    ▼
content-script.js receives base64, relays to background via chrome.runtime.sendMessage
                    │
                    ▼
background.js has the file data, sends to GitHub API ✅
```

---

## Checklist: Where to Put Each Type of Request

| Request | Where to put it |
|---------|----------------|
| `fetch("https://gradescope.com/...")` | inject.js ONLY |
| `fetch("https://api.github.com/...")` | background.js ONLY |
| DOM scraping (`document.querySelector`) | content-script.js or inject.js |
| `chrome.identity.launchWebAuthFlow` | background.js or options.js |

---

## What "Host Permissions" in manifest.json Actually Does

```json
"host_permissions": [
  "https://*.gradescope.com/*",
  "https://api.github.com/*"
]
```

This grants background.js permission to call `fetch()` on those domains *without* the browser blocking on CORS. It does NOT give content-script.js the same ability — content scripts are still subject to CORS even with host permissions declared. It also does NOT provide session cookies to background.js — it only lifts the CORS restriction on the service worker side.

So for GitHub: host_permissions + fetch in background.js = works.
For Gradescope: host_permissions alone is not enough — you still need inject.js for the session cookies.
