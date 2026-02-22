var INJECT_SOURCE = 'gradescope-archiver-inject';
var MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;

function postInjectMessage(payload) {
  window.postMessage({ source: INJECT_SOURCE, ...payload }, '*');
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function mergeAbortSignals(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let timeoutId = null;

  const onAbort = () => controller.abort();
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort();
    else parentSignal.addEventListener('abort', onAbort, { once: true });
  }

  if (timeoutMs && timeoutMs > 0) {
    timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (parentSignal) parentSignal.removeEventListener('abort', onAbort);
    },
  };
}

async function fetchFile(url, { timeoutMs = 120000, abortSignal, path = '', filename = '' } = {}) {
  const { signal, cleanup } = mergeAbortSignals(abortSignal, timeoutMs);
  try {
    let declaredSize = 0;
    try {
      const headResponse = await fetch(url, {
        method: 'HEAD',
        credentials: 'include',
        signal,
      });
      // Only trust Content-Length when HEAD actually succeeded — many Gradescope
      // endpoints return 4xx/5xx to HEAD but work fine for GET.
      if (headResponse.ok) {
        const lengthHeader = headResponse.headers.get('Content-Length') || '0';
        declaredSize = parseInt(lengthHeader, 10) || 0;
      }
    } catch (_) {
      declaredSize = 0;
    }

    if (declaredSize > MAX_FILE_SIZE_BYTES) {
      postInjectMessage({
        type: 'FILE_TOO_LARGE',
        url,
        path,
        filename,
        sizeBytes: declaredSize,
      });
      return;
    }

    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      signal,
    });

    if (!response.ok) {
      throw new Error(`GET failed: ${response.status}`);
    }

    const mimeType = response.headers.get('Content-Type') || 'application/octet-stream';
    const totalBytes = parseInt(response.headers.get('Content-Length') || '0', 10) || declaredSize || 0;

    // Prefer the filename from Content-Disposition (e.g. attachment; filename="hw1.pdf")
    // over the placeholder we were called with, which is often just "download" or "file".
    const disposition = response.headers.get('Content-Disposition') || '';
    const dispMatch = /filename\*?=(?:UTF-\d+''\s*)?["']?([^;"'\n\r]+)["']?/i.exec(disposition);
    const dispFilename = dispMatch ? dispMatch[1].trim().replace(/["']/g, '') : '';
    const resolvedFilename = dispFilename || filename;

    if (!response.body) {
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > MAX_FILE_SIZE_BYTES) {
        postInjectMessage({ type: 'FILE_TOO_LARGE', url, path, filename: resolvedFilename, sizeBytes: buffer.byteLength });
        return;
      }
      const b64 = arrayBufferToBase64(buffer);
      postInjectMessage({ type: 'FETCH_RESULT', url, path, filename: resolvedFilename, b64, mimeType, error: null });
      return;
    }

    const reader = response.body.getReader();
    const chunks = [];
    let bytesReceived = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        bytesReceived += value.byteLength;
        if (bytesReceived > MAX_FILE_SIZE_BYTES) {
          postInjectMessage({ type: 'FILE_TOO_LARGE', url, path, filename: resolvedFilename, sizeBytes: bytesReceived });
          return;
        }
        chunks.push(value);
      }

      const pct = totalBytes > 0 ? Math.round((bytesReceived / totalBytes) * 100) : 0;
      postInjectMessage({
        type: 'FETCH_PROGRESS',
        url,
        path,
        filename: resolvedFilename,
        bytesReceived,
        totalBytes,
        pct,
      });
    }

    const merged = new Uint8Array(bytesReceived);
    let cursor = 0;
    for (const chunk of chunks) {
      merged.set(chunk, cursor);
      cursor += chunk.byteLength;
    }

    const b64 = arrayBufferToBase64(merged.buffer);
    postInjectMessage({
      type: 'FETCH_RESULT',
      url,
      path,
      filename: resolvedFilename,
      b64,
      mimeType,
      error: null,
    });
  } catch (error) {
    postInjectMessage({
      type: 'FETCH_ERROR',
      url,
      path,
      filename,
      error: error?.message || String(error),
    });
  } finally {
    cleanup();
  }
}

if (typeof window !== 'undefined') {
  if (!window.__gradescopeArchiverInjectReady) {
    window.__gradescopeArchiverInjectReady = true;
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.source !== INJECT_SOURCE) return;
      if (data.type !== 'FETCH_FILE' || !data.url) return;

      fetchFile(data.url, {
        timeoutMs: data.timeoutMs || 120000,
        path: data.path || '',
        filename: data.filename || '',
      });
    });
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    fetchFile,
    arrayBufferToBase64,
    MAX_FILE_SIZE_BYTES,
  };
}
