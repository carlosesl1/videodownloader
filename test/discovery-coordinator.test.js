import assert from 'node:assert/strict';
import test from 'node:test';

const PAGE_URL = 'https://escola.test/aula/42';
const YOUTUBE_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const TIKTOK_URL = 'https://www.tiktok.com/@video.radar/video/7488298911734435077';
const STORAGE_KEY = 'discovery:7';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function memorySession(initial = {}) {
  const values = clone(initial);
  const calls = { get: [], set: [], remove: [] };
  return {
    values,
    calls,
    async get(key) {
      calls.get.push(key);
      if (key === null) return clone(values);
      return Object.hasOwn(values, key) ? { [key]: clone(values[key]) } : {};
    },
    async set(entries) {
      calls.set.push(clone(entries));
      Object.assign(values, clone(entries));
    },
    async remove(key) {
      calls.remove.push(key);
      delete values[key];
    },
  };
}

function message(action, tabId = 7) {
  return { target: 'background', action, payload: { tabId } };
}

async function loadCoordinator() {
  return import('../src/background/discovery-coordinator.js');
}

test('persists scanning before work finishes and restores the final page result', async () => {
  const { createDiscoveryCoordinator, DISCOVERY_ACTIONS } = await loadCoordinator();
  let releaseScan;
  const scanGate = new Promise((resolve) => { releaseScan = resolve; });
  const storageSession = memorySession();
  const coordinator = createDiscoveryCoordinator({
    tabs: { async get() { return { id: 7, url: PAGE_URL }; } },
    scripting: {
      async executeScript() {
        await scanGate;
        return [{ result: {
          pageTitle: 'Aula 42',
          candidates: [{
            url: 'https://cdn.test/aula.mp4',
            kind: 'direct',
            type: 'video/mp4',
            source: 'dom-current',
          }],
        } }];
      },
    },
    storageSession,
    youtube: { async handle() { throw new Error('YouTube must not run'); } },
    now: (() => { let tick = 100; return () => tick++; })(),
  });

  const pending = coordinator.handle(message(DISCOVERY_ACTIONS.START));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(storageSession.values[STORAGE_KEY].status, 'scanning');
  assert.equal(storageSession.values[STORAGE_KEY].pageUrl, PAGE_URL);
  assert.equal(
    (await coordinator.handle(message(DISCOVERY_ACTIONS.GET))).status,
    'scanning',
  );

  releaseScan();
  const completed = await pending;
  assert.equal(completed.status, 'results');
  assert.equal(completed.kind, 'page');
  assert.equal(completed.result.pageTitle, 'Aula 42');
  assert.equal(completed.result.candidates[0].url, 'https://cdn.test/aula.mp4');
  assert.deepEqual(
    await coordinator.handle(message(DISCOVERY_ACTIONS.GET)),
    completed,
  );
});

test('coalesces an in-flight scan and persists YouTube formats for popup reopen', async () => {
  const { createDiscoveryCoordinator, DISCOVERY_ACTIONS } = await loadCoordinator();
  let releaseFormats;
  const formatsGate = new Promise((resolve) => { releaseFormats = resolve; });
  const storageSession = memorySession();
  const youtubeCalls = [];
  const coordinator = createDiscoveryCoordinator({
    tabs: { async get() { return { id: 7, url: `${YOUTUBE_URL}&t=4` }; } },
    scripting: { async executeScript() { throw new Error('Page scan must not run'); } },
    storageSession,
    youtube: {
      async handle(request) {
        youtubeCalls.push(clone(request));
        await formatsGate;
        return {
          videoId: 'jNQXAC9IVRw',
          title: 'Me at the zoo',
          durationSeconds: 19,
          qualities: [{ height: 720, label: '720p', container: 'mp4', combined: true }],
        };
      },
    },
    now: () => 200,
  });

  const first = coordinator.handle(message(DISCOVERY_ACTIONS.START));
  const second = coordinator.handle(message(DISCOVERY_ACTIONS.START));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(storageSession.values[STORAGE_KEY].status, 'scanning');
  assert.equal(storageSession.values[STORAGE_KEY].kind, 'youtube');

  releaseFormats();
  const [left, right] = await Promise.all([first, second]);
  assert.deepEqual(right, left);
  assert.equal(left.status, 'results');
  assert.equal(left.mediaUrl, YOUTUBE_URL);
  assert.equal(left.result.qualities[0].height, 720);
  assert.equal(youtubeCalls.length, 1);
});

test('routes a TikTok video page to the native media catalog without DOM scanning', async () => {
  const { createDiscoveryCoordinator, DISCOVERY_ACTIONS } = await loadCoordinator();
  const storageSession = memorySession();
  const calls = [];
  const coordinator = createDiscoveryCoordinator({
    tabs: { async get() { return { id: 7, url: `${TIKTOK_URL}?is_from_webapp=1` }; } },
    scripting: { async executeScript() { throw new Error('Page scan must not run'); } },
    storageSession,
    youtube: {
      async handle(request) {
        calls.push(clone(request));
        return {
          platform: 'tiktok',
          videoId: '7488298911734435077',
          title: 'Public TikTok',
          durationSeconds: 12,
          qualities: [{ height: 720, label: '720p', container: 'mp4', combined: true }],
        };
      },
    },
    now: () => 250,
  });

  const snapshot = await coordinator.handle(message(DISCOVERY_ACTIONS.START));

  assert.equal(snapshot.kind, 'remote-media');
  assert.equal(snapshot.target, 'tiktok.com');
  assert.equal(snapshot.mediaUrl, TIKTOK_URL);
  assert.equal(snapshot.result.platform, 'tiktok');
  assert.equal(snapshot.result.videoId, '7488298911734435077');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.url, TIKTOK_URL);
});

test('turns the visible TikTok feed card into the matching native video', async () => {
  const { createDiscoveryCoordinator, DISCOVERY_ACTIONS } = await loadCoordinator();
  const storageSession = memorySession();
  const calls = [];
  const coordinator = createDiscoveryCoordinator({
    tabs: { async get() { return { id: 7, url: 'https://www.tiktok.com/foryou?lang=pt-BR' }; } },
    scripting: {
      async executeScript() {
        return [{ result: {
          pageTitle: 'TikTok - Make Your Day',
          focusedPageUrl: `${TIKTOK_URL}?is_from_webapp=1`,
          candidates: [],
        } }];
      },
    },
    storageSession,
    youtube: {
      async handle(request) {
        calls.push(clone(request));
        return {
          platform: 'tiktok',
          videoId: '7488298911734435077',
          title: 'TikTok correto do cartão visível',
          durationSeconds: 12,
          qualities: [{ height: 720, label: '720p', container: 'mp4', combined: true }],
        };
      },
    },
    now: () => 265,
  });

  const snapshot = await coordinator.handle(message(DISCOVERY_ACTIONS.START));

  assert.equal(snapshot.kind, 'remote-media');
  assert.equal(snapshot.target, 'tiktok.com');
  assert.equal(snapshot.mediaUrl, TIKTOK_URL);
  assert.equal(snapshot.result.videoId, '7488298911734435077');
  assert.equal(snapshot.result.title, 'TikTok correto do cartão visível');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.url, TIKTOK_URL);
});

test('turns the most visible Instagram feed video into one native post result', async () => {
  const { createDiscoveryCoordinator, DISCOVERY_ACTIONS } = await loadCoordinator();
  const storageSession = memorySession();
  const reelUrl = 'https://www.instagram.com/reel/C8x_example/';
  const calls = [];
  const coordinator = createDiscoveryCoordinator({
    tabs: { async get() { return { id: 7, url: 'https://www.instagram.com/' }; } },
    scripting: {
      async executeScript() {
        return [{ result: {
          pageTitle: 'Instagram',
          focusedPageUrl: `${reelUrl}?igsh=feed`,
          candidates: Array.from({ length: 200 }, (_, index) => ({
            url: `https://cdn.test/history-${index}.mp4`,
            kind: 'direct',
            source: 'performance',
          })),
        } }];
      },
    },
    storageSession,
    youtube: {
      async handle(request) {
        calls.push(clone(request));
        return {
          platform: 'instagram',
          videoId: 'C8x_example',
          title: 'Reel em destaque',
          durationSeconds: 15,
          qualities: [{ height: 1080, label: '1080p', container: 'mp4', combined: true }],
        };
      },
    },
    now: () => 275,
  });

  const snapshot = await coordinator.handle(message(DISCOVERY_ACTIONS.START));

  assert.equal(snapshot.kind, 'remote-media');
  assert.equal(snapshot.mediaUrl, reelUrl);
  assert.equal(snapshot.result.title, 'Reel em destaque');
  assert.equal(snapshot.result.qualities.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.url, reelUrl);
});

test('preserves actionable social lookup failures instead of hiding them behind DOM results', async () => {
  const { createDiscoveryCoordinator, DISCOVERY_ACTIONS } = await loadCoordinator();
  const storageSession = memorySession();
  const coordinator = createDiscoveryCoordinator({
    tabs: { async get() { return { id: 7, url: 'https://www.tiktok.com/foryou' }; } },
    scripting: {
      async executeScript() {
        return [{ result: {
          pageTitle: 'TikTok',
          focusedPageUrl: TIKTOK_URL,
          candidates: [{ url: 'https://cdn.test/fallback.mp4', kind: 'direct', source: 'dom-current' }],
        } }];
      },
    },
    storageSession,
    youtube: {
      async handle() {
        throw Object.assign(new Error('login details must stay private'), { code: 'LOGIN_REQUIRED' });
      },
    },
    now: () => 280,
  });

  const snapshot = await coordinator.handle(message(DISCOVERY_ACTIONS.START));

  assert.equal(snapshot.status, 'error');
  assert.equal(snapshot.errorCode, 'LOGIN_REQUIRED');
  assert.equal(snapshot.result, null);
  assert.equal(JSON.stringify(snapshot).includes('login details'), false);
});

test('uses a valid local candidate when a focused social lookup fails generically', async () => {
  const { createDiscoveryCoordinator, DISCOVERY_ACTIONS } = await loadCoordinator();
  const storageSession = memorySession();
  const coordinator = createDiscoveryCoordinator({
    tabs: { async get() { return { id: 7, url: 'https://www.tiktok.com/foryou' }; } },
    scripting: {
      async executeScript() {
        return [{ result: {
          pageTitle: 'TikTok',
          focusedPageUrl: TIKTOK_URL,
          candidates: [{ url: 'https://cdn.test/fallback.mp4', kind: 'direct', source: 'dom-current' }],
        } }];
      },
    },
    storageSession,
    youtube: { async handle() { throw new Error('native helper unavailable'); } },
    now: () => 285,
  });

  const snapshot = await coordinator.handle(message(DISCOVERY_ACTIONS.START));

  assert.equal(snapshot.status, 'results');
  assert.equal(snapshot.kind, 'page');
  assert.equal(snapshot.mediaUrl, null);
  assert.equal(snapshot.result.candidates[0].url, 'https://cdn.test/fallback.mp4');
});

test('does not report empty DOM fallback as a successful social lookup', async () => {
  const { createDiscoveryCoordinator, DISCOVERY_ACTIONS } = await loadCoordinator();
  const storageSession = memorySession();
  const coordinator = createDiscoveryCoordinator({
    tabs: { async get() { return { id: 7, url: 'https://www.tiktok.com/foryou' }; } },
    scripting: {
      async executeScript() {
        return [{ result: { pageTitle: 'TikTok', focusedPageUrl: TIKTOK_URL, candidates: [] } }];
      },
    },
    storageSession,
    youtube: { async handle() { throw new Error('native helper unavailable'); } },
    now: () => 290,
  });

  const snapshot = await coordinator.handle(message(DISCOVERY_ACTIONS.START));

  assert.equal(snapshot.status, 'error');
  assert.equal(snapshot.errorCode, 'SCAN_FAILED');
  assert.equal(snapshot.result, null);
});

test('does not restore a discovery after the tab navigates', async () => {
  const { createDiscoveryCoordinator, DISCOVERY_ACTIONS } = await loadCoordinator();
  const storageSession = memorySession({
    [STORAGE_KEY]: {
      schemaVersion: 1,
      tabId: 7,
      pageUrl: PAGE_URL,
      target: 'escola.test',
      status: 'results',
      kind: 'page',
      mediaUrl: null,
      result: { pageTitle: 'Aula', candidates: [] },
      view: { selections: [], inspections: [] },
      errorCode: null,
      updatedAt: 10,
    },
  });
  const coordinator = createDiscoveryCoordinator({
    tabs: { async get() { return { id: 7, url: 'https://escola.test/aula/43' }; } },
    scripting: { async executeScript() { throw new Error('not used'); } },
    storageSession,
    youtube: { async handle() { throw new Error('not used'); } },
    now: () => 20,
  });

  assert.equal(await coordinator.handle(message(DISCOVERY_ACTIONS.GET)), null);
  assert.deepEqual(storageSession.calls.remove, [STORAGE_KEY]);
});

test('persists a safe terminal error instead of leaving the popup scanning forever', async () => {
  const { createDiscoveryCoordinator, DISCOVERY_ACTIONS } = await loadCoordinator();
  const storageSession = memorySession();
  const coordinator = createDiscoveryCoordinator({
    tabs: { async get() { return { id: 7, url: PAGE_URL }; } },
    scripting: {
      async executeScript() {
        throw Object.assign(new Error('private browser detail'), { code: 'SCAN_FAILED' });
      },
    },
    storageSession,
    youtube: { async handle() { throw new Error('not used'); } },
    now: () => 300,
  });

  const failed = await coordinator.handle(message(DISCOVERY_ACTIONS.START));
  assert.equal(failed.status, 'error');
  assert.equal(failed.errorCode, 'SCAN_FAILED');
  assert.equal(JSON.stringify(failed).includes('private browser detail'), false);
  assert.deepEqual(storageSession.values[STORAGE_KEY], failed);
});

test('persists quality selection and inspected HLS variants without rescanning', async () => {
  const { createDiscoveryCoordinator, DISCOVERY_ACTIONS } = await loadCoordinator();
  const storageSession = memorySession();
  let scans = 0;
  const coordinator = createDiscoveryCoordinator({
    tabs: { async get() { return { id: 7, url: PAGE_URL }; } },
    scripting: {
      async executeScript() {
        scans += 1;
        return [{ result: {
          pageTitle: 'Aula',
          candidates: [{ url: 'https://cdn.test/master.m3u8', kind: 'hls' }],
        } }];
      },
    },
    storageSession,
    youtube: { async handle() { throw new Error('not used'); } },
    now: (() => { let tick = 400; return () => tick++; })(),
  });
  await coordinator.handle(message(DISCOVERY_ACTIONS.START));

  const updated = await coordinator.handle({
    target: 'background',
    action: 'DISCOVERY_UPDATE_VIEW',
    payload: {
      tabId: 7,
      view: {
        selections: [{ id: 'hls-https://cdn.test/master.m3u8', selectedIndex: 1 }],
        inspections: [{
          id: 'hls-https://cdn.test/master.m3u8',
          variants: [
            {
              url: 'https://cdn.test/1080.m3u8',
              label: '1080p',
              width: 1920,
              height: 1080,
              bandwidth: 4_000_000,
              codecs: 'avc1',
            },
            {
              url: 'https://cdn.test/720.m3u8',
              label: '720p',
              width: 1280,
              height: 720,
              bandwidth: 2_000_000,
              codecs: 'avc1',
            },
          ],
          allowedOrigins: ['https://cdn.test'],
        }],
      },
    },
  });

  assert.equal(updated.view.selections[0].selectedIndex, 1);
  assert.equal(updated.view.inspections[0].variants.length, 2);
  assert.deepEqual(
    (await coordinator.handle(message(DISCOVERY_ACTIONS.GET))).view,
    updated.view,
  );
  assert.equal(scans, 1);
});

test('evicts the least-recently-updated discovery snapshots within a global byte budget', async () => {
  const { createDiscoveryCoordinator, DISCOVERY_ACTIONS } = await loadCoordinator();
  const storageSession = memorySession();
  const coordinator = createDiscoveryCoordinator({
    tabs: {
      async get(tabId) {
        return { id: tabId, url: `https://escola.test/aula/${tabId}` };
      },
    },
    scripting: {
      async executeScript({ target }) {
        return [{ result: {
          pageTitle: `Aula ${target.tabId}`,
          candidates: [{
            url: `https://cdn.test/video-${target.tabId}.mp4?padding=${'a'.repeat(650)}`,
            kind: 'direct',
          }],
        } }];
      },
    },
    storageSession,
    youtube: { async handle() { throw new Error('not used'); } },
    now: (() => { let tick = 500; return () => tick++; })(),
    snapshotBudgetBytes: 2_500,
  });

  await coordinator.handle(message(DISCOVERY_ACTIONS.START, 1));
  await coordinator.handle(message(DISCOVERY_ACTIONS.START, 2));
  assert.ok(storageSession.values['discovery:1']);
  assert.ok(storageSession.values['discovery:2']);

  await coordinator.handle(message(DISCOVERY_ACTIONS.START, 3));

  assert.equal(storageSession.values['discovery:1'], undefined);
  assert.ok(storageSession.values['discovery:2']);
  assert.ok(storageSession.values['discovery:3']);
  assert.ok(storageSession.calls.remove.includes('discovery:1'));
});
