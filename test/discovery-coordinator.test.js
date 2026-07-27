import assert from 'node:assert/strict';
import test from 'node:test';

const PAGE_URL = 'https://escola.test/aula/42';
const YOUTUBE_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
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
