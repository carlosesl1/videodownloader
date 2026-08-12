import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS } from '../src/shared/messages.js';

import {
  buildOriginGrant,
  bootPopup,
  canonicalMediaUrl,
  findMatchingOperation,
  permissionOriginsFromError,
  requestHostOriginGrant,
  richMediaLabel,
  runWithHostOriginGrant,
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

test('claims ownership before requesting a new host permission', async () => {
  const actions = [];
  const chromeApi = {
    permissions: {
      async contains() { return false; },
      async request(options) {
        actions.push(['request', structuredClone(options)]);
        return true;
      },
    },
    runtime: {
      async sendMessage(message) {
        actions.push(['message', structuredClone(message)]);
        return {
          ok: true,
          value: {
            claimId: message.payload.claimId,
            state: message.action === ACTIONS.CLAIM_HOST_PERMISSIONS ? 'claimed' : 'confirmed',
          },
        };
      },
    },
  };

  assert.deepEqual(await requestHostOriginGrant(['https://cdn.test/master.m3u8'], {
    chromeApi,
    createClaimId: () => 'permission-test',
  }), {
    origins: ['https://cdn.test'],
    patterns: ['https://cdn.test/*'],
    permissionClaimId: 'permission-test',
  });
  assert.deepEqual(actions, [
    ['message', {
      target: 'background',
      action: ACTIONS.CLAIM_HOST_PERMISSIONS,
      payload: {
        claimId: 'permission-test',
        permissionPatterns: ['https://cdn.test/*'],
      },
    }],
    ['request', { origins: ['https://cdn.test/*'] }],
    ['message', {
      target: 'background',
      action: ACTIONS.CONFIRM_HOST_PERMISSION_CLAIM,
      payload: {
        claimId: 'permission-test',
        permissionPatterns: ['https://cdn.test/*'],
      },
    }],
  ]);
});

test('claims and requests only origins not already owned by the user', async () => {
  const messages = [];
  const requests = [];
  const chromeApi = {
    permissions: {
      async contains({ origins }) { return origins[0] === 'https://existing.test/*'; },
      async request(options) { requests.push(structuredClone(options)); return true; },
    },
    runtime: {
      async sendMessage(message) {
        messages.push(structuredClone(message));
        return {
          ok: true,
          value: {
            claimId: message.payload.claimId,
            state: message.action === ACTIONS.CLAIM_HOST_PERMISSIONS ? 'claimed' : 'confirmed',
          },
        };
      },
    },
  };

  const grant = await requestHostOriginGrant([
    'https://existing.test/master.m3u8',
    'https://new.test/segment.ts',
  ], {
    chromeApi,
    createClaimId: () => 'permission-mixed',
  });

  assert.deepEqual(grant, {
    origins: ['https://existing.test', 'https://new.test'],
    patterns: ['https://existing.test/*', 'https://new.test/*'],
    permissionClaimId: 'permission-mixed',
  });
  assert.deepEqual(messages.map(({ action }) => action), [
    ACTIONS.CLAIM_HOST_PERMISSIONS,
    ACTIONS.CONFIRM_HOST_PERMISSION_CLAIM,
  ]);
  assert.deepEqual(messages[0].payload.permissionPatterns, ['https://new.test/*']);
  assert.deepEqual(requests, [{ origins: ['https://new.test/*'] }]);
});

test('send failure releases the durable host-permission claim', async () => {
  const actions = [];
  const chromeApi = {
    permissions: {
      async contains() { return false; },
      async request() { return true; },
    },
    runtime: {
      async sendMessage(message) {
        actions.push(message.action);
        if (message.action === ACTIONS.CLAIM_HOST_PERMISSIONS) {
          return { ok: true, value: { claimId: message.payload.claimId, state: 'claimed' } };
        }
        if (message.action === ACTIONS.CONFIRM_HOST_PERMISSION_CLAIM) {
          return { ok: true, value: { claimId: message.payload.claimId, state: 'confirmed' } };
        }
        if (message.action === ACTIONS.RELEASE_HOST_PERMISSION_CLAIM) {
          return { ok: true, value: { claimId: message.payload.claimId, state: 'released' } };
        }
        throw new Error('worker disconnected');
      },
    },
  };

  await assert.rejects(runWithHostOriginGrant({
    chromeApi,
    values: ['https://cdn.test/master.m3u8'],
    createClaimId: () => 'permission-send-failure',
  }, async () => {
    await chromeApi.runtime.sendMessage({ action: ACTIONS.DOWNLOAD_HLS });
  }), /worker disconnected/);
  assert.deepEqual(actions, [
    ACTIONS.CLAIM_HOST_PERMISSIONS,
    ACTIONS.CONFIRM_HOST_PERMISSION_CLAIM,
    ACTIONS.DOWNLOAD_HLS,
    ACTIONS.RELEASE_HOST_PERMISSION_CLAIM,
  ]);
});

test('aprovação tardia renova a reserva e falha pós-grant remove a permissão concedida', async () => {
  const actions = [];
  let removeCalls = 0;
  let heartbeat;
  const chromeApi = {
    permissions: {
      async contains() { return false; },
      async request() {
        actions.push('approved-after-prompt');
        heartbeat();
        await new Promise((resolve) => setImmediate(resolve));
        return true;
      },
      async remove({ origins }) {
        removeCalls += 1;
        assert.deepEqual(origins, ['https://slow.test/*']);
        return true;
      },
    },
    runtime: {
      async sendMessage(message) {
        actions.push(message.action);
        if (message.action === ACTIONS.CLAIM_HOST_PERMISSIONS) {
          return { ok: true, value: { claimId: message.payload.claimId, state: 'claimed' } };
        }
        if (message.action === ACTIONS.CONFIRM_HOST_PERMISSION_CLAIM) {
          throw new Error('worker reiniciado durante confirmação');
        }
        throw new Error('worker indisponível para liberar');
      },
    },
  };

  await assert.rejects(requestHostOriginGrant(['https://slow.test/master.m3u8'], {
    chromeApi,
    createClaimId: () => 'permission-late',
    claimHeartbeatMs: 1,
    setIntervalFn(callback) { heartbeat = callback; return 7; },
    clearIntervalFn(id) { assert.equal(id, 7); },
  }), /reiniciado/);
  assert.deepEqual(actions, [
    ACTIONS.CLAIM_HOST_PERMISSIONS,
    'approved-after-prompt',
    ACTIONS.CLAIM_HOST_PERMISSIONS,
    ACTIONS.CONFIRM_HOST_PERMISSION_CLAIM,
    ACTIONS.RELEASE_HOST_PERMISSION_CLAIM,
  ]);
  assert.equal(removeCalls, 1);
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

test('matches an active HLS operation after its signed query token rotates', () => {
  const item = {
    kind: 'hls',
    variants: [{ url: 'https://cdn.test/playlist.m3u8?token=new' }],
  };
  const found = findMatchingOperation(item, [
    {
      operationId: 'active',
      url: 'https://cdn.test/playlist.m3u8?token=old',
      state: 'assembling',
      updatedAt: 2,
    },
  ]);

  assert.equal(found.operationId, 'active');
});

test('prefere URL HLS exata e não usa fallback de query quando ele é ambíguo', () => {
  const item = {
    kind: 'hls',
    variants: [{ url: 'https://cdn.test/playlist.m3u8?token=exact' }],
  };
  const exact = findMatchingOperation(item, [
    { operationId: 'other', url: 'https://cdn.test/playlist.m3u8?token=other', state: 'assembling', updatedAt: 9 },
    { operationId: 'exact', url: 'https://cdn.test/playlist.m3u8?token=exact', state: 'complete', updatedAt: 1 },
  ]);
  assert.equal(exact.operationId, 'exact');

  const ambiguous = findMatchingOperation(item, [
    { operationId: 'old', url: 'https://cdn.test/playlist.m3u8?token=old', state: 'complete', updatedAt: 1 },
    { operationId: 'new', url: 'https://cdn.test/playlist.m3u8?token=new', state: 'assembling', updatedAt: 2 },
  ]);
  assert.equal(ambiguous, undefined);
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

test('unwraps a TikTok catalog and builds a remote-media item', () => {
  const catalog = unwrapYouTubeFormats({ ok: true, value: {
    platform: 'tiktok',
    videoId: '7488298911734435077',
    title: 'Public TikTok',
    durationSeconds: 12,
    qualities: [{ height: 720, label: '720p', container: 'mp4', combined: true }],
  } });
  const item = youtubeItem(
    catalog,
    'https://www.tiktok.com/@video.radar/video/7488298911734435077',
  );

  assert.equal(item.kind, 'remote-media');
  assert.equal(item.platform, 'tiktok');
  assert.equal(item.id, 'tiktok:7488298911734435077');
});

test('somente áudio descreve a faixa M4A realmente priorizada pelo seletor', () => {
  const item = youtubeItem({
    platform: 'youtube', videoId: 'jNQXAC9IVRw', title: 'Me at the zoo',
    durationSeconds: 19,
    qualities: [{ height: 720, label: '720p', container: 'mp4', combined: true }],
    formats: [
      {
        formatId: '251', height: null, container: 'webm', combined: false,
        audioOnly: true, fps: null, hdr: false, dynamicRange: null,
        videoCodec: null, audioCodec: 'opus', bitrateKbps: 192,
        fileSizeBytes: 5_000_000, fileSizeApproximate: false, language: null,
      },
      {
        formatId: '140', height: null, container: 'm4a', combined: false,
        audioOnly: true, fps: null, hdr: false, dynamicRange: null,
        videoCodec: null, audioCodec: 'mp4a.40.2', bitrateKbps: 128,
        fileSizeBytes: 4_000_000, fileSizeApproximate: true, language: null,
      },
    ],
    subtitles: [], audioLanguages: [],
  }, 'https://www.youtube.com/watch?v=jNQXAC9IVRw');

  const audio = item.variants.at(-1);
  assert.equal(audio.selection.audioOnly, true);
  assert.match(audio.label, /AAC/);
  assert.match(audio.label, /~3,81 MB/);
  assert.doesNotMatch(audio.label, /OPUS/);
});

test('boots YouTube and durable queue recovery with one shared storage listener', async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(messages, [
      { target: 'background', action: 'YOUTUBE_GET_JOB', payload: {} },
      { target: 'background', action: 'YOUTUBE_GET_QUEUE', payload: {} },
    ]);
    assert.equal(listeners.length, 1);
  } finally {
    globalThis.document = previousDocument;
  }
});

test('reopening the popup asks the background for the current tab discovery', async () => {
  class Element {
    constructor() {
      this.dataset = {};
      this.children = [];
      this.textContent = '';
    }
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
  try {
    bootPopup({
      documentApi: { querySelector: (selector) => selector === '#app' ? root : announcer },
      chromeApi: {
        tabs: {
          async query() {
            return [{ id: 17, url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' }];
          },
        },
        runtime: {
          async sendMessage(message) {
            messages.push(message);
            if (message.action === 'DISCOVERY_GET') {
              return { ok: true, value: {
                schemaVersion: 1,
                tabId: 17,
                pageUrl: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
                target: 'youtube.com',
                status: 'scanning',
                kind: 'youtube',
                mediaUrl: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
                result: null,
                view: { selections: [], inspections: [] },
                errorCode: null,
                updatedAt: 50,
              } };
            }
            return { ok: true, value: null };
          },
        },
        storage: { onChanged: { addListener() {} } },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.ok(messages.some((message) => (
      message.action === 'DISCOVERY_GET'
      && message.payload?.tabId === 17
    )), 'popup did not request the durable discovery for the active tab');
    assert.match(announcer.textContent, /Carregando qualidades do YouTube/);
  } finally {
    globalThis.document = previousDocument;
  }
});

test('reopening the popup renders the persisted discovery without scanning again', async () => {
  class Element {
    constructor() {
      this.dataset = {};
      this.children = [];
      this.textContent = '';
      this.className = '';
      this.listeners = new Map();
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute() {}
    addEventListener(type, listener) { this.listeners.set(type, listener); }
  }
  const find = (element, predicate) => {
    if (predicate(element)) return element;
    for (const child of element.children) {
      const match = find(child, predicate);
      if (match) return match;
    }
    return null;
  };
  const root = new Element();
  const announcer = new Element();
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => new Element() };
  const messages = [];
  try {
    bootPopup({
      documentApi: { querySelector: (selector) => selector === '#app' ? root : announcer },
      chromeApi: {
        tabs: {
          async query() {
            return [{ id: 17, url: 'https://escola.test/aula/42' }];
          },
        },
        runtime: {
          async sendMessage(message) {
            messages.push(message);
            if (message.action === 'DISCOVERY_GET') {
              return { ok: true, value: {
                schemaVersion: 1,
                tabId: 17,
                pageUrl: 'https://escola.test/aula/42',
                target: 'escola.test',
                status: 'results',
                kind: 'page',
                mediaUrl: null,
                result: {
                  pageTitle: 'Aula 42',
                  candidates: [{
                    url: 'https://cdn.test/aula-1080.mp4',
                    type: 'video/mp4',
                    kind: 'direct',
                    source: 'dom-current',
                    groupKey: 'video-0',
                    width: 1920,
                    height: 1080,
                  }, {
                    url: 'https://cdn.test/aula-720.mp4',
                    type: 'video/mp4',
                    kind: 'direct',
                    source: 'dom-source',
                    groupKey: 'video-0',
                    width: 1280,
                    height: 720,
                  }],
                },
                view: {
                  selections: [{ id: 'direct-video-0', selectedIndex: 1 }],
                  inspections: [],
                },
                errorCode: null,
                updatedAt: 100,
              } };
            }
            return { ok: true, value: null };
          },
        },
        storage: {
          session: { async get() { return {}; } },
          local: { async get() { return {}; } },
          onChanged: { addListener() {} },
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.ok(find(root, (element) => element.dataset.itemId === 'direct-video-0'));
    const quality = find(root, (element) => element.dataset.quality === 'direct-video-0');
    assert.ok(quality, 'restored discovery did not render its quality selector');
    assert.equal(quality.children[1].selected, true, 'persisted quality selection was not restored');
    quality.value = '0';
    root.listeners.get('change')({ target: { closest: () => quality } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const update = messages.find((message) => message.action === 'DISCOVERY_UPDATE_VIEW');
    assert.equal(update.payload.view.selections[0].selectedIndex, 0);
    assert.equal(
      messages.some((message) => message.action === 'DISCOVERY_START'),
      false,
      'reopening must restore, not start another scan',
    );
  } finally {
    globalThis.document = previousDocument;
  }
});

test('reopening the popup restores an active HLS operation from session storage', async () => {
  class Element {
    constructor() {
      this.dataset = {};
      this.children = [];
      this.textContent = '';
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute() {}
    addEventListener() {}
  }
  const find = (element, predicate) => {
    if (predicate(element)) return element;
    for (const child of element.children) {
      const match = find(child, predicate);
      if (match) return match;
    }
    return null;
  };
  const root = new Element();
  const announcer = new Element();
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => new Element() };
  try {
    bootPopup({
      documentApi: { querySelector: (selector) => selector === '#app' ? root : announcer },
      chromeApi: {
        runtime: { sendMessage: async () => ({ ok: true, value: null }) },
        storage: {
          session: {
            get: async () => ({
              hlsOperationIndex: ['op-reopen'],
              'hlsOperation:op-reopen': {
                operationId: 'op-reopen',
                url: 'https://cdn.test/720.m3u8',
                filename: 'aula.ts',
                state: 'assembling',
                progress: {
                  completedSegments: 15,
                  totalSegments: 60,
                  bytesReceived: 5_242_880,
                  estimatedTotalBytes: 20_971_520,
                  percent: 25,
                },
              },
            }),
          },
          onChanged: { addListener() {} },
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const restored = find(root, (element) => element.dataset.itemId === 'hls-operation:op-reopen');
    assert.ok(restored, 'active HLS operation was not restored');
    assert.ok(find(restored, (element) => element.textContent.includes('25%')));
  } finally {
    globalThis.document = previousDocument;
  }
});

test('reopening the popup restores a completed relocated download from local storage', async () => {
  class Element {
    constructor() {
      this.dataset = {};
      this.children = [];
      this.textContent = '';
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute() {}
    addEventListener() {}
  }
  const find = (element, predicate) => {
    if (predicate(element)) return element;
    for (const child of element.children) {
      const match = find(child, predicate);
      if (match) return match;
    }
    return null;
  };
  const root = new Element();
  const announcer = new Element();
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => new Element() };
  try {
    bootPopup({
      documentApi: { querySelector: (selector) => selector === '#app' ? root : announcer },
      chromeApi: {
        runtime: { sendMessage: async () => ({ ok: true, value: null }) },
        storage: {
          local: {
            get: async () => ({
              downloadRelocationIndex: [],
              downloadDeliveryResultIndex: [42],
              'downloadDeliveryResult:42': {
                downloadId: 42,
                operationId: 'direct-42',
                destinationFolder: 'D:\\Vídeos',
                mediaKind: 'direct',
                mediaUrl: 'https://cdn.test/aula.mp4',
                displayName: 'aula.mp4',
                status: 'complete',
                stagingPath: 'C:\\Temp\\aula.mp4',
                finalPath: 'D:\\Vídeos\\aula.mp4',
                errorCode: null,
                updatedAt: 2,
              },
            }),
          },
          onChanged: { addListener() {} },
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const restored = find(root, (element) => element.dataset.itemId === 'download:42');
    assert.ok(restored, 'completed relocated download was not restored');
    assert.ok(find(restored, (element) => element.textContent.includes('D:\\Vídeos\\aula.mp4')));
  } finally {
    globalThis.document = previousDocument;
  }
});

test('clicking cancel applies the returned queue job without waiting for a storage event', async () => {
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
      if (selector === '[data-reveal]' && Object.hasOwn(this.dataset, 'reveal')) return this;
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
  const cancelled = {
    jobId: 'youtube-job-1', operationId: 'queue-op-1', videoId: 'jNQXAC9IVRw',
    title: 'Me at the zoo', url: snapshot.url, height: 720,
    selection: {
      height: 720, audioOnly: false, subtitleLanguage: null,
      includeAutomaticSubtitles: false,
    },
    state: 'cancelled', stage: 'cancelled', percent: 42,
    downloadedBytes: null, totalBytes: null, speedBytesPerSecond: null,
    etaSeconds: null, path: null, error: null, position: null,
    resumePartial: false, attemptCount: 0,
    createdAt: '2026-08-12T12:00:00Z', updatedAt: '2026-08-12T12:01:00Z',
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
            if (message.action === 'YOUTUBE_GET_QUEUE') return { ok: true, value: [] };
            if (message.action === 'YOUTUBE_CANCEL_DOWNLOAD') {
              return { ok: true, value: cancelled };
            }
            throw new Error(`unexpected action ${message.action}`);
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
    assert.ok(
      find(root, (element) => element.dataset.itemId === 'media-job:youtube-job-1'),
      'cancel response was not rendered as the durable queue job',
    );
    assert.equal(find(root, (element) => Object.hasOwn(element.dataset, 'cancel')), null);
  } finally {
    globalThis.document = previousDocument;
  }
});

test('rich labels expose video codec, audio codec and bitrate together', () => {
  const label = richMediaLabel({
    label: '1080p', fps: 60, hdr: true, dynamicRange: 'HDR10',
    videoCodec: 'avc1.640028', audioCodec: 'mp4a.40.2', bitrateKbps: 2_500,
  });

  assert.match(label, /H\.264/);
  assert.match(label, /AAC/);
  assert.match(label, /2500 kb\/s/);
});
