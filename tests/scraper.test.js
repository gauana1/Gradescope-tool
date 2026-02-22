const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const { parseCourseList, parseAssignments, parseFileLinks, normalizeCourses, normalizeHref, safeText, enumerateCourseFiles } = require('../extension/scraper');

function loadFixture(name) {
  const html = fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
  return new JSDOM(html).window.document;
}

// ---------------------------------------------------------------------------
// normalizeHref
// ---------------------------------------------------------------------------
describe('normalizeHref', () => {
  const base = 'https://www.gradescope.com';

  test('leaves absolute https URL unchanged', () => {
    expect(normalizeHref('https://example.com/foo', base)).toBe('https://example.com/foo');
  });
  test('leaves absolute http URL unchanged', () => {
    expect(normalizeHref('http://example.com/foo', base)).toBe('http://example.com/foo');
  });
  test('converts protocol-relative to https', () => {
    expect(normalizeHref('//cdn.example.com/foo', base)).toBe('https://cdn.example.com/foo');
  });
  test('converts root-relative href using base origin', () => {
    expect(normalizeHref('/courses/123', base)).toBe('https://www.gradescope.com/courses/123');
  });
  test('returns empty string for falsy input', () => {
    expect(normalizeHref('', base)).toBe('');
    expect(normalizeHref(null, base)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// safeText
// ---------------------------------------------------------------------------
describe('safeText', () => {
  test('returns trimmed textContent', () => {
    const doc = new JSDOM('<span>  hello  </span>').window.document;
    expect(safeText(doc.querySelector('span'))).toBe('hello');
  });
  test('returns empty string for null', () => {
    expect(safeText(null)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// parseCourseList
// ---------------------------------------------------------------------------
describe('parseCourseList', () => {
  let doc;
  beforeAll(() => { doc = loadFixture('course-list.html'); });

  test('returns exactly 2 unique valid courses', () => {
    const courses = parseCourseList(doc);
    expect(courses).toHaveLength(2);
  });
  test('first course has correct fields', () => {
    const [c] = parseCourseList(doc);
    expect(c.url).toBe('https://www.gradescope.com/courses/111111');
    expect(c.full_name).toBe('Introduction to Programming');
    expect(c.short_name).toBe('CS 101');
    expect(c.term).toBe('Fall 2024');
  });
  test('deduplicates cards with same URL', () => {
    const urls = parseCourseList(doc).map(c => c.url);
    const unique = new Set(urls);
    expect(urls.length).toBe(unique.size);
  });
  test('skips cards with /assignments/ in href', () => {
    const urls = parseCourseList(doc).map(c => c.url);
    expect(urls.some(u => u.includes('/assignments/'))).toBe(false);
  });
  test('skips cards with no href', () => {
    const names = parseCourseList(doc).map(c => c.full_name);
    expect(names).not.toContain('No Href');
  });
});

// ---------------------------------------------------------------------------
// parseAssignments
// ---------------------------------------------------------------------------
describe('parseAssignments', () => {
  let doc;
  beforeAll(() => { doc = loadFixture('assignment-page.html'); });

  test('returns 2 assignments (Graded text + score; skips Submitted; dedupes)', () => {
    const results = parseAssignments(doc);
    expect(results).toHaveLength(2);
  });
  test('first assignment has correct fields', () => {
    const [a] = parseAssignments(doc);
    expect(a.name).toBe('Homework 1');
    expect(a.url).toBe('https://www.gradescope.com/courses/111111/assignments/100');
    expect(a.statusText).toBe('Graded');
  });
  test('includes score-graded assignment', () => {
    const results = parseAssignments(doc);
    expect(results.some(a => a.name === 'Project 1')).toBe(true);
  });
  test('skips row without Graded status', () => {
    const names = parseAssignments(doc).map(a => a.name);
    expect(names).not.toContain('Homework 2');
  });
  test('deduplicates by URL', () => {
    const urls = parseAssignments(doc).map(a => a.url);
    const unique = new Set(urls);
    expect(urls.length).toBe(unique.size);
  });
});

// ---------------------------------------------------------------------------
// parseFileLinks
// ---------------------------------------------------------------------------
describe('parseFileLinks', () => {
  let doc;
  const BASE = 'https://www.gradescope.com';
  beforeAll(() => { doc = loadFixture('download-page.html'); });

  test('returns correct number of unique links', () => {
    const results = parseFileLinks(doc, BASE);
    // download_submission, notes.pdf (download attr), solution.py, archive.zip, graded copy = 5
    expect(results).toHaveLength(5);
  });
  test('deduplicates links with the same href', () => {
    const hrefs = parseFileLinks(doc, BASE).map(l => l.href);
    const unique = new Set(hrefs);
    expect(hrefs.length).toBe(unique.size);
  });
  test('normalizes root-relative hrefs to absolute', () => {
    const hrefs = parseFileLinks(doc, BASE).map(l => l.href);
    hrefs.forEach(h => expect(h.startsWith('https://')).toBe(true));
  });
  test('picks up Download Graded Copy by text match', () => {
    const results = parseFileLinks(doc, BASE);
    expect(results.some(l => l.text.toLowerCase().includes('download graded copy'))).toBe(true);
  });
  test('uses [download] attr as filenameHint when present', () => {
    const results = parseFileLinks(doc, BASE);
    const pdfLink = results.find(l => l.filenameHint === 'notes.pdf');
    expect(pdfLink).toBeDefined();
  });
  test('falls back to URL path segment for filenameHint', () => {
    const results = parseFileLinks(doc, BASE);
    const pyLink = results.find(l => l.href.endsWith('.py'));
    expect(pyLink?.filenameHint).toBe('solution.py');
  });
  test('skips anchors with no href', () => {
    const hrefs = parseFileLinks(doc, BASE).map(l => l.href);
    expect(hrefs.some(h => h === '')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// normalizeCourses
// ---------------------------------------------------------------------------
describe('normalizeCourses', () => {
  test('normalizes a single course with valid URL', () => {
    const input = [{ url: 'https://www.gradescope.com/courses/12345', full_name: 'Intro to CS', short_name: '', term: '' }];
    const result = normalizeCourses(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      course_id: '12345',
      full_name: 'Intro to CS',
      short_name: '',
      rename: 'INTRO-TO-CS',
      github_repo: 'gradescope-INTRO-TO-CS',
      last_synced: null,
      status: 'idle',
      url: 'https://www.gradescope.com/courses/12345',
    });
  });
  test('extracts course_id from URL pathname', () => {
    const input = [{ url: 'https://www.gradescope.com/courses/67890/assignments', full_name: 'Math 101' }];
    const result = normalizeCourses(input);
    expect(result[0].course_id).toBe('67890');
  });
  test('falls back to regex for course_id if URL parsing fails', () => {
    const input = [{ url: 'invalid-url/courses/11111', full_name: 'Physics' }];
    const result = normalizeCourses(input);
    expect(result[0].course_id).toBe('11111');
  });
  test('slugifies full_name for rename', () => {
    const input = [{ url: 'https://www.gradescope.com/courses/123', full_name: 'Advanced Topics in AI & ML!' }];
    const result = normalizeCourses(input);
    expect(result[0].rename).toBe('ADVANCED-TOPICS-IN-AI-ML');
  });
  test('limits rename to 40 chars', () => {
    const longName = 'A'.repeat(50);
    const input = [{ url: 'https://www.gradescope.com/courses/123', full_name: longName }];
    const result = normalizeCourses(input);
    expect(result[0].rename.length).toBeLessThanOrEqual(40);
  });
  test('uses course-id fallback for rename if full_name is empty', () => {
    const input = [{ url: 'https://www.gradescope.com/courses/999', full_name: '' }];
    const result = normalizeCourses(input);
    expect(result[0].rename).toBe('COURSE-999');
  });
  test('handles empty input array', () => {
    const result = normalizeCourses([]);
    expect(result).toEqual([]);
  });
  test('handles null/undefined input', () => {
    expect(normalizeCourses(null)).toEqual([]);
    expect(normalizeCourses(undefined)).toEqual([]);
  });
  test('trims full_name', () => {
    const input = [{ url: 'https://www.gradescope.com/courses/123', full_name: '  CS 101  ' }];
    const result = normalizeCourses(input);
    expect(result[0].full_name).toBe('CS 101');
  });
});

// ---------------------------------------------------------------------------
// parseCourseList — h3 primary path (uses tests/fixtures/h3-course-list.html)
// ---------------------------------------------------------------------------
describe('parseCourseList (h3 primary path)', () => {
  let doc;
  beforeAll(() => { doc = loadFixture('h3-course-list.html'); });

  test('returns exactly 2 unique courses via h3.courseBox--shortname', () => {
    const courses = parseCourseList(doc);
    expect(courses).toHaveLength(2);
  });

  test('first course has correct short_name and full_name', () => {
    const courses = parseCourseList(doc);
    expect(courses[0].short_name).toBe('EC ENGR M116C');
    expect(courses[0].full_name).toBe('Principles of Electrical Engineering');
    expect(courses[0].term).toBe('Winter 2026');
    expect(courses[0].url).toBe('https://www.gradescope.com/courses/555555');
  });

  test('deduplicates cards with the same URL', () => {
    const courses = parseCourseList(doc);
    const urls = courses.map(c => c.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  test('skips cards whose href contains /assignments/', () => {
    const courses = parseCourseList(doc);
    expect(courses.every(c => !c.url.includes('/assignments/'))).toBe(true);
  });

  test('skips cards with no href', () => {
    const courses = parseCourseList(doc);
    expect(courses.every(c => !!c.url)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cleanShortName — tested indirectly via normalizeCourses
// ---------------------------------------------------------------------------
describe('cleanShortName (via normalizeCourses short_name)', () => {
  function clean(raw) {
    return normalizeCourses([{ url: 'https://www.gradescope.com/courses/1', full_name: '', short_name: raw }])[0].short_name;
  }

  test('strips semester prefix like 26W-', () => {
    expect(clean('26W-COM SCI-M148')).toBe('COM SCI M148');
  });

  test('strips semester prefix like 25F-', () => {
    expect(clean('25F-COM SCI-M151B')).toBe('COM SCI M151B');
  });

  test('strips section suffix like -LEC-1', () => {
    expect(clean('COM SCI-LEC-1')).toBe('COM SCI');
  });

  test('strips section suffix like -LAB-3', () => {
    expect(clean('EC ENGR-LAB-3')).toBe('EC ENGR');
  });

  test('strips semester word like Winter 2026', () => {
    expect(clean('ECE C147A/C247A Winter 2026')).toBe('ECE C147A/C247A');
  });

  test('strips semester word like Fall 2024', () => {
    expect(clean('PHYSICS 4AL Fall 2024')).toBe('PHYSICS 4AL');
  });

  test('converts remaining hyphens to spaces', () => {
    expect(clean('PHYSICS-4AL')).toBe('PHYSICS 4AL');
  });

  test('leaves already-clean names unchanged', () => {
    expect(clean('COM SCI 131')).toBe('COM SCI 131');
  });

  test('returns undefined/null passthrough', () => {
    expect(clean('')).toBe('');
  });
});

describe('enumerateCourseFiles', () => {
  test('builds deterministic file path list from assignment HTML map', () => {
    const courseDoc = loadFixture('assignment-page.html');
    const assignmentDocHtml = fs.readFileSync(path.join(__dirname, 'fixtures', 'download-page.html'), 'utf8');

    const files = enumerateCourseFiles(courseDoc, () => assignmentDocHtml);
    expect(files.length).toBeGreaterThan(0);
    expect(files[0]).toEqual(expect.objectContaining({
      assignmentUrl: expect.stringContaining('/assignments/'),
      url: expect.stringContaining('https://'),
      path: expect.stringContaining('/'),
      filename: expect.any(String),
    }));
  });
});
