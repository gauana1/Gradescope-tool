const { JSDOM } = require('jsdom');

describe('content-script message bridge', () => {
  let onMessageListener;

  beforeEach(() => {
    jest.resetModules();
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    global.window = dom.window;
    global.document = dom.window.document;
    global.MessageEvent = dom.window.MessageEvent;

    global.chrome = {
      runtime: {
        sendMessage: jest.fn().mockResolvedValue(undefined),
        onMessage: {
          addListener: jest.fn((listener) => { onMessageListener = listener; }),
        },
        onConnect: {
          addListener: jest.fn(),
        },
      },
      storage: {
        local: {
          get: jest.fn((key, cb) => cb({ courses: [{ course_id: '1' }] })),
        },
      },
    };

    window.gradescopeScraper = {
      parseCourseList: jest.fn().mockReturnValue([{ course_id: '1' }]),
      normalizeCourses: jest.fn((items) => items),
    };

    window.postMessage = jest.fn();

    require('../extension/content-script.js');
  });

  test('forwards FETCH_RESULT from inject to FILE_DATA runtime message', () => {
    window.dispatchEvent(new MessageEvent('message', {
      source: window,
      data: {
        source: 'gradescope-archiver-inject',
        type: 'FETCH_RESULT',
        filename: 'f.pdf',
        path: 'a/f.pdf',
        b64: 'abc',
        mimeType: 'application/pdf',
        url: 'https://www.gradescope.com/file',
      },
    }));

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'FILE_DATA',
      payload: {
        filename: 'f.pdf',
        path: 'a/f.pdf',
        b64: 'abc',
        mimeType: 'application/pdf',
        url: 'https://www.gradescope.com/file',
      },
    });
  });

  test('on FETCH_FILE runtime message posts to inject channel', () => {
    onMessageListener({
      type: 'FETCH_FILE',
      payload: {
        url: 'https://www.gradescope.com/file',
        path: 'a/f.pdf',
        filename: 'f.pdf',
        timeoutMs: 1000,
      },
    });

    expect(window.postMessage).toHaveBeenCalledWith({
      source: 'gradescope-archiver-inject',
      type: 'FETCH_FILE',
      url: 'https://www.gradescope.com/file',
      path: 'a/f.pdf',
      filename: 'f.pdf',
      timeoutMs: 1000,
    }, '*');
  });
});
