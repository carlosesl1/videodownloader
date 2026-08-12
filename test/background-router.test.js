import assert from 'node:assert/strict';
import test from 'node:test';

import { createBackgroundRouter } from '../src/background/router.js';
import { DISCOVERY_ACTIONS } from '../src/detection/discovery-protocol.js';
import { ACTIONS } from '../src/shared/messages.js';
import { YOUTUBE_ACTIONS } from '../src/youtube/protocol.js';

test('encaminha descoberta, YouTube e mídia aos coordenadores corretos', async () => {
  const calls = [];
  const hls = {
    ready: Promise.resolve(),
    async handle(message) { calls.push(['hls', message.action]); return 'hls'; },
  };
  const youtube = {
    ready: Promise.resolve(),
    async handle(message) { calls.push(['youtube', message.action]); return 'youtube'; },
  };
  const discovery = {
    ready: Promise.resolve(),
    async handle(message) { calls.push(['discovery', message.action]); return 'discovery'; },
  };
  const router = createBackgroundRouter({ hls, youtube, discovery });

  await router.ready;
  for (const action of Object.values(DISCOVERY_ACTIONS)) {
    assert.equal(await router.handle({ action }), 'discovery');
  }
  for (const action of Object.values(YOUTUBE_ACTIONS)) {
    assert.equal(await router.handle({ action }), 'youtube');
  }
  for (const action of [ACTIONS.DOWNLOAD_DIRECT, ACTIONS.DOWNLOAD_HLS, 'UNKNOWN']) {
    assert.equal(await router.handle({ action }), 'hls');
  }

  assert.deepEqual(calls, [
    ...Object.values(DISCOVERY_ACTIONS).map((action) => ['discovery', action]),
    ...Object.values(YOUTUBE_ACTIONS).map((action) => ['youtube', action]),
    ['hls', ACTIONS.DOWNLOAD_DIRECT],
    ['hls', ACTIONS.DOWNLOAD_HLS],
    ['hls', 'UNKNOWN'],
  ]);
  assert.equal(Object.isFrozen(router), true);
});

test('valida os três coordenadores e combina seus ready', async () => {
  assert.throws(() => createBackgroundRouter({ hls: {}, youtube: { handle() {} } }), /Coordenador inválido/);
  assert.throws(() => createBackgroundRouter({ hls: { handle() {} }, youtube: null }), /Coordenador inválido/);

  let resolveHls;
  let resolveYouTube;
  let resolveDiscovery;
  const hlsReady = new Promise((resolve) => { resolveHls = resolve; });
  const youtubeReady = new Promise((resolve) => { resolveYouTube = resolve; });
  const discoveryReady = new Promise((resolve) => { resolveDiscovery = resolve; });
  const router = createBackgroundRouter({
    hls: { ready: hlsReady, handle() {} },
    youtube: { ready: youtubeReady, handle() {} },
    discovery: { ready: discoveryReady, handle() {} },
  });
  let settled = false;
  router.ready.then(() => { settled = true; });
  resolveHls();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  resolveYouTube();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  resolveDiscovery();
  await router.ready;
  assert.equal(settled, true);
});

test('main compõe o router sem abrir a porta nativa até uma ação YouTube', async () => {
  const originalChrome = globalThis.chrome;
  const runtimeListeners = [];
  const downloadListeners = [];
  const portMessageListeners = [];
  const portDisconnectListeners = [];
  let connections = 0;
  const storageArea = {
    async get() { return {}; },
    async set() {},
    async remove() {},
  };
  const port = {
    onMessage: {
      addListener(listener) { portMessageListeners.push(listener); },
      removeListener() {},
    },
    onDisconnect: {
      addListener(listener) { portDisconnectListeners.push(listener); },
      removeListener() {},
    },
    postMessage(command) {
      queueMicrotask(() => {
        for (const listener of portMessageListeners) listener({
          type: 'formats', requestId: command.requestId, ...structuredClone(CATALOG_FOR_MAIN),
        });
      });
    },
    disconnect() {
      for (const listener of portDisconnectListeners) listener();
    },
  };
  const CATALOG_FOR_MAIN = {
    videoId: 'jNQXAC9IVRw', title: 'Me at the zoo', durationSeconds: 19,
    qualities: [{ height: 720, label: '720p', container: 'mp4', combined: true }],
  };
  globalThis.chrome = {
    alarms: {
      create() {},
      onAlarm: { addListener() {} },
    },
    tabs: {
      async get(tabId) {
        return { id: tabId, url: 'https://example.test/video' };
      },
    },
    scripting: {
      async executeScript() {
        return [{ result: { pageTitle: 'Video', candidates: [] } }];
      },
    },
    downloads: {
      onChanged: { addListener(listener) { downloadListeners.push(listener); } },
      async search() { return []; },
      async download() { return 1; },
    },
    storage: { session: storageArea, local: storageArea },
    permissions: { async contains() { return true; }, async remove() { return true; } },
    notifications: { async create() {} },
    offscreen: { async createDocument() {} },
    runtime: {
      getURL: (path) => `chrome-extension://test/${path}`,
      async getContexts() { return []; },
      async sendMessage() { return { ok: true, value: { released: true } }; },
      connectNative() { connections += 1; return port; },
      onMessage: { addListener(listener) { runtimeListeners.push(listener); } },
    },
  };

  try {
    await import(`../src/background/main.js?router-${Date.now()}`);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(connections, 0);
    assert.equal(runtimeListeners.length, 1);
    assert.equal(downloadListeners.length, 1);

    const response = await new Promise((resolve) => {
      runtimeListeners[0]({
        target: 'background', action: YOUTUBE_ACTIONS.LIST_FORMATS,
        payload: { url: 'https://youtu.be/jNQXAC9IVRw' },
      }, {}, resolve);
    });
    assert.deepEqual(response, { ok: true, value: CATALOG_FOR_MAIN });
    assert.equal(connections, 1);
  } finally {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
  }
});
