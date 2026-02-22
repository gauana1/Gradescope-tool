const { JSDOM } = require('jsdom');

let fetchFile;
let MAX_FILE_SIZE_BYTES;

describe('inject.fetchFile', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.resetAllMocks();
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    global.window = dom.window;
    global.document = dom.window.document;
    global.btoa = dom.window.btoa.bind(dom.window);
    window.postMessage = jest.fn();
    ({ fetchFile, MAX_FILE_SIZE_BYTES } = require('../extension/inject.js'));
  });

  test('posts FILE_TOO_LARGE when HEAD content-length exceeds 50MB', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: { get: (name) => (name === 'Content-Length' ? String(MAX_FILE_SIZE_BYTES + 10) : null) },
    });

    await fetchFile('https://www.gradescope.com/file.pdf', { path: 'a/file.pdf' });

    expect(window.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      source: 'gradescope-archiver-inject',
      type: 'FILE_TOO_LARGE',
      path: 'a/file.pdf',
    }), '*');
  });

  test('streams GET and emits FETCH_PROGRESS then FETCH_RESULT', async () => {
    const encoder = new TextEncoder();
    const chunks = [encoder.encode('hello'), encoder.encode('world')];
    let index = 0;

    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => '10' },
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: {
          get: (name) => {
            if (name === 'Content-Length') return '10';
            if (name === 'Content-Type') return 'text/plain';
            return null;
          },
        },
        body: {
          getReader: () => ({
            read: async () => {
              if (index < chunks.length) {
                const value = chunks[index];
                index += 1;
                return { done: false, value };
              }
              return { done: true, value: undefined };
            },
          }),
        },
      });

    await fetchFile('https://www.gradescope.com/file.txt', { path: 'a/file.txt' });

    const postedTypes = window.postMessage.mock.calls.map((call) => call[0].type);
    expect(postedTypes).toContain('FETCH_PROGRESS');
    expect(postedTypes.some((type) => type === 'FETCH_RESULT' || type === 'FETCH_ERROR')).toBe(true);
  });
});
