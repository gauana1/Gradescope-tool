// scraper.js
// Pure DOM→JSON module. No network, no chrome.*, no DOM mutation.

if (!(typeof window !== 'undefined' && window.__gradescopeArchiverScraperLoaded)) {
if (typeof window !== 'undefined') {
  window.__gradescopeArchiverScraperLoaded = true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a raw href attribute into an absolute URL string.
 *   - Already absolute (http/https) → returned as-is
 *   - Protocol-relative (//) → prepend "https:"
 *   - Root-relative (/) → prepend baseUrl origin
 */
function normalizeHref(href, baseUrl) {
  if (!href) return '';
  href = href.trim();
  if (href.startsWith('http://') || href.startsWith('https://')) return href;
  if (href.startsWith('//')) return 'https:' + href;
  if (href.startsWith('/')) {
    try {
      const origin = new URL(baseUrl).origin;
      return origin + href;
    } catch (_) {
      return 'https://www.gradescope.com' + href;
    }
  }
  return href;
}

/**
 * Safely extract trimmed textContent from an element, returning '' on null.
 */
function safeText(el) {
  return el?.textContent?.trim() ?? '';
}

// ---------------------------------------------------------------------------
// parseCourseList
// Ports: get_courses() in gradescope_lib.py
// ---------------------------------------------------------------------------

/**
 * Parse the Gradescope home/courses page and return a list of course objects.
 *
 * @param {Document|Element} root
 * @returns {{ url: string, full_name: string, short_name: string, term: string }[]}
 */
function parseCourseList(root) {
  const BASE = 'https://www.gradescope.com';
  const seen = new Set();
  const courses = [];

  // Try new structure first: h3.courseBox--shortname inside a.coursebox
  const nameEls = root.querySelectorAll('h3.courseBox--shortname');
  for (const nameEl of nameEls) {
    const short_name = safeText(nameEl) || '';
    if (!short_name) continue;

    // Find the associated link
    let card = nameEl.closest('a.coursebox');
    if (!card) {
      card = nameEl.closest('a');
    }
    if (!card) continue;

    const href = card.getAttribute('href');
    if (!href || !href.includes('/courses/')) continue;
    if (href.includes('/assignments/') || href.includes('/submissions/')) continue;

    const url = normalizeHref(href, BASE);
    if (seen.has(url)) continue;
    seen.add(url);

    const full_name = safeText(card.querySelector('.courseBox--name')) || '';
    const term = safeText(card.querySelector('.courseBox--term')) || '';
    courses.push({ url, full_name, short_name, term });
  }

  // Fallback: old selector if no h3 found
  if (courses.length === 0) {
    const cards = root.querySelectorAll('a[href*="/courses/"]');
    for (const card of cards) {
      const href = card.getAttribute('href');
      if (!href || !href.includes('/courses/')) continue;
      if (href.includes('/assignments/') || href.includes('/submissions/')) continue;

      const url = normalizeHref(href, BASE);
      if (seen.has(url)) continue;
      seen.add(url);

      // Fallback parsing
      const text = safeText(card);
      const lines = text.split('\n').map(l => l.trim()).filter(l => l && !l.match(/\d+ assignments?$/));
      const short_name = lines[0] || '';
      if (!short_name) continue;

      courses.push({ url, full_name: lines[1] || '', short_name, term: lines[2] || '' });
    }
  }

  return courses;
}

/**
 * Normalize parsed course entries into the extension's Course object shape.
 * Returns objects with fields: course_id, full_name, rename, github_repo, last_synced, status
 */
function normalizeCourses(parsedCourses) {
  function slugify(s) {
    return (s || '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
  }

  function cleanShortName(s) {
    if (!s) return s;
    // Remove semester prefixes like 26W-, 25F-, 24S-, etc.
    s = s.replace(/^\d{2}[A-Z]-/g, '');
    // Remove section suffixes like -LEC-1, -LAB-4, -LEC_2, etc.
    s = s.replace(/-(LEC|LAB|DIS|SEM|LEC_)[\d-]+/gi, '');
    // Remove semester words like Winter 2026, Fall 2024, etc.
    s = s.replace(/\s+(Winter|Fall|Spring|Summer)\s+\d{4}/gi, '');
    // Replace - with space
    s = s.replace(/-/g, ' ');
    // Remove extra spaces and trim
    s = s.replace(/\s+/g, ' ').trim();
    // Uppercase to match popup display
    s = s.toUpperCase();
    return s;
  }

  return (parsedCourses || []).map((c) => {
    const url = c.url || '';
    let course_id = '';
    const match = url.match(/\/courses\/(\d+)/);
    course_id = match ? match[1] : '';

    const full_name = (c.full_name || '').trim();
    const cleanedShort = cleanShortName(c.short_name || '').replace(new RegExp(`^${course_id}\\s*`), '').trim();
    let rename = cleanedShort.replace(/[\s/]+/g, '-') || slugify(full_name) || (course_id ? `course-${course_id}` : 'course');
    // Ensure uppercase to match popup casing
    rename = rename.toUpperCase();
    // Prefix with gradescope- so repo names are clearly identifiable
    const github_repo = `gradescope-${rename}`;

    return {
      course_id,
      full_name,
      short_name: cleanedShort,
      rename,
      github_repo,
      last_synced: null,
      status: 'idle',
      url,
    };
  });
}

// ---------------------------------------------------------------------------
// parseAssignments
// Ports: download_course() in gradescope_lib.py
// ---------------------------------------------------------------------------

const SCORE_RE = /\d+(\.\d+)?\s*\/\s*\d+(\.\d+)?/;

/**
 * Parse a Gradescope course page and return assignments that are graded.
 *
 * @param {Document|Element} root
 * @returns {{ name: string, url: string, statusText: string }[]}
 */
function parseAssignments(root) {
  const BASE = 'https://www.gradescope.com';
  const seen = new Set();
  const assignments = [];

  const rows = root.querySelectorAll('table tbody tr');
  for (const row of rows) {
    const statusCell = row.querySelector('td:nth-child(2)');
    if (!statusCell) continue;

    const statusText = safeText(statusCell);
    const isGraded = statusText.includes('Graded') || SCORE_RE.test(statusText);
    if (!isGraded) continue;

    const linkEl = row.querySelector('a[href*="/assignments/"]');
    if (!linkEl) continue;

    const href = linkEl.getAttribute('href');
    if (!href) continue;

    const url = normalizeHref(href, BASE);
    if (seen.has(url)) continue;
    seen.add(url);

    const name = safeText(linkEl);
    assignments.push({
      name,
      url,
      statusText,
    });
  }

  return assignments;
}

// ---------------------------------------------------------------------------
// parseFileLinks
// Ports: _try_direct_downloads() in gradescope_lib.py
// ---------------------------------------------------------------------------

const FILE_SELECTORS = [
  'a[href*="/download_submission"]',
  'a[href*="/download"]',
  'a[download]',
  'a[href$=".zip"]',
  'a[href$=".tar.gz"]',
  'a[href$=".tar"]',
  'a[href$=".tgz"]',
  'a[href$=".py"]',
  'a[href$=".java"]',
  'a[href$=".cpp"]',
  'a[href$=".c"]',
  'a[href$=".h"]',
  'a[href$=".txt"]',
  'a[href$=".pdf"]',
];

/**
 * Parse an assignment page and return downloadable file links.
 *
 * @param {Document|Element} root
 * @param {string} [baseUrl]
 * @returns {{ href: string, text: string, filenameHint: string }[]}
 */
function parseFileLinks(root, baseUrl = 'https://www.gradescope.com') {
  const seen = new Set();
  const links = [];

  function collect(el) {
    const raw = el.getAttribute('href');
    if (!raw) return;
    const href = normalizeHref(raw, baseUrl);
    if (seen.has(href)) return;
    seen.add(href);

    const text = safeText(el);
    const downloadAttr = el.getAttribute('download');
    let filenameHint = '';
    if (downloadAttr && downloadAttr.trim()) {
      filenameHint = downloadAttr.trim();
    } else {
      try {
        const pathname = new URL(href).pathname;
        filenameHint = pathname.split('/').filter(Boolean).pop() || '';
      } catch (_) {
        filenameHint = '';
      }
    }

    links.push({ href, text, filenameHint });
  }

  // Selector-based collection
  for (const selector of FILE_SELECTORS) {
    try {
      root.querySelectorAll(selector).forEach(collect);
    } catch (_) { /* invalid selector in some envs — skip */ }
  }

  // Text-based: "Download Graded Copy" (case-insensitive)
  root.querySelectorAll('a').forEach((el) => {
    if (safeText(el).toLowerCase().includes('download graded copy')) {
      collect(el);
    }
  });

  // PDF viewer wrappers often embed the real PDF via <iframe>, <embed>, or <object>.
  // Prefer those (they point directly to the .pdf resource used by the viewer).
  try {
    const viewerSelectors = ['iframe[src$=".pdf"]', 'embed[src$=".pdf"]', 'object[data$=".pdf"]', 'embed[type="application/pdf"]'];
    for (const sel of viewerSelectors) {
      root.querySelectorAll(sel).forEach((el) => {
        const src = el.getAttribute('src') || el.getAttribute('data') || '';
        if (src) {
          // Create a temporary anchor to normalize URL
          const a = document.createElement('a');
          a.href = src;
          const tmp = root.ownerDocument?.createElement('a');
          const href = normalizeHref(src, baseUrl);
          if (!seen.has(href)) {
            seen.add(href);
            const filenameHint = (href.split('/').filter(Boolean).pop() || '').split('?')[0];
            links.push({ href, text: safeText(el) || 'pdf-embed', filenameHint });
          }
        }
      });
    }
  } catch (_) {
    // ignore
  }

  // Heuristic: some pages embed submission JSON or URLs inside <script> tags.
  // Scan inline scripts for /submissions/<id> references and for nearby
  // indicators like "graded":true or "pdf_ready":true. Prefer download
  // endpoints when found (e.g. /submissions/<id>/download).
  try {
    root.querySelectorAll('script:not([src])').forEach((s) => {
      const txt = safeText(s) || '';
      if (!txt) return;
      // Find submission URL patterns
      const re = /(https?:\/\/[^"'\s<>]*\/submissions\/\d+[^"'\s<>]*|\/courses\/\d+\/assignments\/\d+\/submissions\/\d+[^"'\s<>]*|\/submissions\/\d+[^"'\s<>]*)/g;
      let m;
      while ((m = re.exec(txt)) !== null) {
        const rawMatch = m[1];
        const sidMatch = rawMatch.match(/\/submissions\/(\d+)/);
        if (!sidMatch) continue;
        const sid = sidMatch[1];
        // Look in a small window around the match for graded/pdf flags
        const ctxStart = Math.max(0, m.index - 200);
        const ctx = txt.slice(ctxStart, Math.min(txt.length, m.index + 200)).toLowerCase();
        const isGraded = ctx.includes('\"graded\":true') || ctx.includes('"graded":true') || ctx.includes('pdf_ready') || ctx.includes('pdf_ready":true');
        if (!isGraded) continue;

        const normalized = normalizeHref(rawMatch, baseUrl);
        if (!seen.has(normalized)) {
          seen.add(normalized);
          // Try to extract a nicer filename from the URL or context
          let filenameHint = `submission-${sid}.pdf`;
          try {
            const urlObj = new URL(normalized);
            const pathname = urlObj.pathname;
            const segments = pathname.split('/').filter(Boolean);
            const lastSegment = segments[segments.length - 1];
            if (lastSegment && (lastSegment.endsWith('.pdf') || lastSegment.endsWith('.zip'))) {
              filenameHint = lastSegment;
            }
          } catch (_) {
          }
          links.push({ href: normalized, text: 'graded-submission', filenameHint });
        }

        if (!normalized.includes('?download=1')) {
          const withDownload = `${normalizeHref(`/submissions/${sid}`, baseUrl)}?download=1`;
          if (!seen.has(withDownload)) {
            seen.add(withDownload);
            links.push({ href: withDownload, text: 'graded-submission', filenameHint: `submission-${sid}.pdf` });
          }
        }
      }
    });
  } catch (_) {
    // Ignore script parsing errors
  }

  return links;
}

/**
 * Enumerate course file URLs by combining parseAssignments + parseFileLinks.
 * This helper is pure and expects HTML for assignment pages to be provided.
 *
 * @param {Document|Element} courseRoot
 * @param {(assignmentUrl: string) => string|null|undefined} getAssignmentHtml
 * @returns {{ assignmentUrl: string, url: string, path: string, filename: string }[]}
 */
function enumerateCourseFiles(courseRoot, getAssignmentHtml) {
  const assignments = parseAssignments(courseRoot);
  const dedupe = new Set();
  const files = [];
  const ownerDoc = courseRoot?.ownerDocument || courseRoot;
  const domParserCtor = typeof DOMParser !== 'undefined'
    ? DOMParser
    : ownerDoc?.defaultView?.DOMParser;
  if (!domParserCtor) return files;

  assignments.forEach((assignment) => {
    const assignmentUrl = assignment.url;
    const html = typeof getAssignmentHtml === 'function' ? getAssignmentHtml(assignmentUrl) : null;
    if (!html) return;

    const parsed = new domParserCtor().parseFromString(html, 'text/html');
    const links = parseFileLinks(parsed, assignmentUrl);
    const assignmentId = assignmentUrl.split('/assignments/')[1]?.split('/')[0] || 'assignment';
    const assignmentFolder = (assignment.name || assignmentId).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 50);  // Sanitize name for folder

    links.forEach((link) => {
      const url = link.href;
      if (!url || dedupe.has(url)) return;
      dedupe.add(url);

      const safeName = (link.filenameHint || 'file').replace(/[^a-zA-Z0-9._-]+/g, '_');
      files.push({
        assignmentUrl,
        url,
        filename: safeName,
        path: `${assignmentFolder}/${safeName}`,
      });
    });
  });

  return files;
}

if (typeof window !== 'undefined') {
  window.gradescopeScraper = { parseCourseList, parseAssignments, parseFileLinks, normalizeCourses, enumerateCourseFiles };
}

// Also export for Jest / Node environments
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseCourseList, parseAssignments, parseFileLinks, normalizeCourses, normalizeHref, safeText, enumerateCourseFiles };
}

}
