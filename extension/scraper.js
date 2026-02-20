// scraper.js
// Pure DOM→JSON module. No network, no chrome.*, no DOM mutation.

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
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
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
    return s;
  }

  return (parsedCourses || []).map((c) => {
    const url = c.url || '';
    let course_id = '';
    const match = url.match(/\/courses\/(\d+)/);
    course_id = match ? match[1] : '';

    const full_name = (c.full_name || '').trim();
    const cleanedShort = cleanShortName(c.short_name);
    const rename = slugify(cleanedShort || full_name) || (course_id ? `course-${course_id}` : 'course');
    const github_repo = course_id ? `gradescope-${course_id}-${rename}` : `gradescope-${rename}`;

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

    assignments.push({
      name: safeText(linkEl),
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

  return links;
}

if (typeof window !== 'undefined') {
  window.gradescopeScraper = { parseCourseList, parseAssignments, parseFileLinks, normalizeCourses };
  console.log('gradescopeScraper attached:', !!window.gradescopeScraper);
}

// Also export for Jest / Node environments
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseCourseList, parseAssignments, parseFileLinks, normalizeCourses, normalizeHref, safeText };
}
