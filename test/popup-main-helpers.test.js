import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildOriginGrant,
  bootPopup,
  canonicalMediaUrl,
  findMatchingOperation,
  permissionOriginsFromError,
  unwrapDirectResponse,
  unwrapInspectResponse,
  unwrapQueuedResponse,
  unwrapYouTubeFormats,
  unwrapYouTubeJob,
  youtubeItem,
} from '../src/popup/main.js';

test('builds exact safe Chrome origin patterns with ports', () => {
  assert.deepEqual(
    buildOriginGrant([
      'https://cdn.test:8443/master.m3u8?token=x',
      'https://cdn.test:8443/segment.ts',
      'http://media.test/video.ts',
    ]),
    {
      origins: ['https://cdn.test:8443', 'http://media.test'],
      patterns: ['https://cdn.test:8443/*', 'http://media.test/*'],
    },
  );
  assert.throws(() => buildOriginGrant(['data:text/plain,no']), /URL de mídia inválida/);
});

test('canonicalizes media URLs without discarding query tokens', () => {
  assert.equal(
    canonicalMediaUrl('https://cdn.test/video.m3u8?token=abc#fragment'),
    'https://cdn.test/video.m3u8?token=abc',
  );
});

test('validates direct, inspection and queued background envelopes', () => {
  assert.deepEqual(unwrapDirectResponse({ ok: true, value: { downloadId: 7 } }), { downloadId: 7 });
  assert.deepEqual(
    unwrapInspectResponse({
      ok: true,
      value: {
        kind: 'master',
        variants: [{
          url: 'https://cdn.test/720.m3u8',
          label: '720p',
          width: 1280,
          height: 720,
          bandwidth: 2500000,
          codecs: 'avc1',
        }],
      },
    }).variants[0].label,
    '720p',
  );
  assert.deepEqual(
    unwrapQueuedResponse({ ok: true, value: { operationId: 'op:1', state: 'assembling' } }),
    { operationId: 'op:1', state: 'assembling' },
  );
  assert.throws(() => unwrapDirectResponse({ ok: true, value: { downloadId: '7' } }), /resposta inválida/i);
  assert.throws(() => unwrapQueuedResponse({ ok: true, value: { operationId: '<script>', state: 'assembling' } }), /resposta inválida/i);
});

test('preserves a safe background error and extracts HLS permission origins', () => {
  const envelope = {
    ok: false,
    error: {
      code: 'HLS_PERMISSION',
      message: 'Autorização necessária',
      details: { origins: ['https://segments.test', 'file:///tmp/no'] },
    },
  };
  assert.throws(
    () => unwrapQueuedResponse(envelope),
    (error) => error.code === 'HLS_PERMISSION' && error.details.origins.length === 2,
  );
  assert.deepEqual(permissionOriginsFromError(envelope.error), ['https://segments.test']);
});

test('matches the newest persisted operation by canonical variant URL', () => {
  const item = {
    kind: 'hls',
    variants: [{ url: 'https://cdn.test/720.m3u8?token=x#old' }],
  };
  const found = findMatchingOperation(item, [
    { operationId: 'old', url: 'https://cdn.test/720.m3u8?token=x', state: 'complete', updatedAt: 1 },
    { operationId: 'new', url: 'https://cdn.test/720.m3u8?token=x', state: 'assembling', updatedAt: 2 },
  ]);
  assert.equal(found.operationId, 'new');
});

test('unwraps only a valid pure YouTube catalog and durable job snapshot', () => {
  const catalog = unwrapYouTubeFormats({ ok: true, value: {
    videoId: 'jNQXAC9IVRw', title: 'Me at the zoo', durationSeconds: 19,
    qualities: [{ height: 720, label: '720p', container: 'mp4', combined: true }],
  } });
  const item = youtubeItem(catalog, 'https://www.youtube.com/watch?v=jNQXAC9IVRw');
  assert.equal(item.kind, 'youtube');
  assert.equal(item.filename, 'Me at the zoo-720p.mp4');

  const snapshot = unwrapYouTubeJob({ ok: true, value: {
    jobId: 'youtube-job-1', videoId: 'jNQXAC9IVRw', title: 'Me at the zoo',
    url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', height: 720,
    format: { height: 720, label: '720p', container: 'mp4', combined: true },
    stage: 'video', percent: null, downloadedBytes: null, totalBytes: null,
    speedBytesPerSecond: null, etaSeconds: null, path: null, error: null, updatedAt: 1,
  } });
  assert.equal(snapshot.jobId, 'youtube-job-1');
  assert.throws(() => unwrapYouTubeJob({ ok: true, value: { ...snapshot, url: 'https://evil.test' } }), (error) => error.code === 'INVALID_RESPONSE');
});

test('boots one YouTube recovery request and one shared storage listener', async () => {
  class Element {
    constructor() { this.dataset = {}; this.children = []; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute() {}
    addEventListener() {}
  }
  const root = new Element();
  const announcer = new Element();
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => new Element() };
  const messages = [];
  const listeners = [];
  try {
    bootPopup({
      documentApi: { querySelector: (selector) => selector === '#app' ? root : announcer },
      chromeApi: {
        runtime: { sendMessage: async (message) => { messages.push(message); return { ok: true, value: null }; } },
        storage: { onChanged: { addListener: (listener) => listeners.push(listener) } },
      },
    });
    await Promise.resolve();
    assert.deepEqual(messages, [{ target: 'background', action: 'YOUTUBE_GET_JOB', payload: {} }]);
    assert.equal(listeners.length, 1);
  } finally {
    globalThis.document = previousDocument;
  }
});

test('clicking the rendered cancel control sends the active YouTube job id', async () => {
  class InteractiveElement {
    constructor(tagName = 'div') {
      this.tagName = tagName;
      this.dataset = {};
      this.children = [];
      this.listeners = new Map();
      this.attributes = new Map();
      this.parent = null;
      this.className = '';
      this.textContent = '';
      this.disabled = false;
    }

    append(...children) {
      for (const child of children) {
        child.parent = this;
        this.children.push(child);
      }
    }

    replaceChildren(...children) {
      this.children = [];
      this.append(...children);
    }

    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    }

    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }

    closest(selector) {
      if (selector === '[data-cancel]' && Object.hasOwn(this.dataset, 'cancel')) return this;
      return this.parent?.closest?.(selector) ?? null;
    }
  }

  const find = (root, predicate) => {
    for (const child of root.children) {
      if (predicate(child)) return child;
      const nested = find(child, predicate);
      if (nested) return nested;
    }
    return null;
  };

  const snapshot = {
    jobId: 'youtube-job-1', videoId: 'jNQXAC9IVRw', title: 'Me at the zoo',
    url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', height: 720,
    format: { height: 720, label: '720p', container: 'mp4', combined: true },
    stage: 'video', percent: 42, downloadedBytes: null, totalBytes: null,
    speedBytesPerSecond: null, etaSeconds: null, path: null, error: null, updatedAt: 1,
  };
  const root = new InteractiveElement();
  const announcer = new InteractiveElement();
  const previousDocument = globalThis.document;
  const messages = [];
  const listeners = [];
  globalThis.document = { createElement: (tagName) => new InteractiveElement(tagName) };
  try {
    bootPopup({
      documentApi: { querySelector: (selector) => selector === '#app' ? root : announcer },
      chromeApi: {
        runtime: {
          sendMessage: async (message) => {
            messages.push(message);
            if (message.action === 'YOUTUBE_GET_JOB') return { ok: true, value: snapshot };
            return { ok: true, value: { requested: true, requestId: 'cancel-1' } };
          },
        },
        storage: { onChanged: { addListener: (listener) => listeners.push(listener) } },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const cancel = find(root, (element) => Object.hasOwn(element.dataset, 'cancel'));
    assert.ok(cancel, 'restored active YouTube job did not render a cancel control');
    assert.equal(cancel.dataset.cancel, 'youtube:jNQXAC9IVRw', 'cancel control must identify the rendered item');
    root.listeners.get('click')({ target: cancel });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(messages.at(-1), {
      target: 'background', action: 'YOUTUBE_CANCEL_DOWNLOAD', payload: { jobId: 'youtube-job-1' },
    });
    assert.equal(listeners.length, 1);
  } finally {
    globalThis.document = previousDocument;
  }
});
