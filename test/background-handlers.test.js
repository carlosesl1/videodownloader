import assert from 'node:assert/strict';
import test from 'node:test';
import { ACTIONS } from '../src/shared/messages.js';
import {
  createBackgroundHandlers,
  createBackgroundMessageListener,
  createTerminalDownloadHandler,
} from '../src/background/handlers.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function directMessage() {
  return {
    target: 'background',
    action: ACTIONS.DOWNLOAD_DIRECT,
    payload: { url: 'https://cdn.test/aula.mp4', filename: 'aula.mp4' },
  };
}

function inspectMessage(patterns = ['https://cdn.test/*']) {
  return {
    target: 'background',
    action: ACTIONS.INSPECT_HLS,
    payload: { url: 'https://cdn.test/master.m3u8', permissionPatterns: patterns },
  };
}

function downloadMessage(url = 'https://cdn.test/video.m3u8#player') {
  return {
    target: 'background',
    action: ACTIONS.DOWNLOAD_HLS,
    payload: {
      url,
      filename: 'aula.ts',
      allowedOrigins: ['https://cdn.test'],
      permissionPatterns: ['https://cdn.test/*'],
    },
  };
}

function completion(operationId, blobUrl = `blob:extension.test/${operationId}`) {
  return {
    target: 'background',
    action: ACTIONS.HLS_COMPLETED,
    payload: { operationId, result: { blobUrl, size: 10 } },
  };
}

function progressMessage(
  operationId,
  completedSegments,
  totalSegments,
  bytesReceived,
  estimatedTotalBytes,
) {
  return {
    target: 'background',
    action: ACTIONS.HLS_PROGRESS,
    payload: {
      operationId, completedSegments, totalSegments, bytesReceived, estimatedTotalBytes,
    },
  };
}

function failedCompletion(operationId) {
  return {
    target: 'background',
    action: ACTIONS.HLS_COMPLETED,
    payload: {
      operationId,
      error: { code: 'HLS_NETWORK', message: 'Falha HLS tardia', details: { status: 503 } },
    },
  };
}

function releasedMessage(operationId, blobUrl = `blob:extension.test/${operationId}`) {
  return {
    target: 'background',
    action: ACTIONS.HLS_RELEASED,
    payload: { operationId, blobUrl },
  };
}

function memorySession(initial = {}) {
  const values = structuredClone(initial);
  const calls = { get: [], set: [], remove: [] };
  let failSet;
  let failRemove;
  return {
    values,
    calls,
    setFailure(predicate) { failSet = predicate; },
    removeFailure(predicate) { failRemove = predicate; },
    async get(keys) {
      calls.get.push(keys);
      if (keys === null || keys === undefined) return structuredClone(values);
      const requested = Array.isArray(keys) ? keys : [keys];
      const result = {};
      for (const key of requested) {
        if (Object.hasOwn(values, key)) result[key] = structuredClone(values[key]);
      }
      return result;
    },
    async set(entries) {
      calls.set.push(structuredClone(entries));
      if (failSet?.(entries)) throw new Error('Falha ao persistir');
      Object.assign(values, structuredClone(entries));
    },
    async remove(keys) {
      calls.remove.push(structuredClone(keys));
      if (failRemove?.(keys)) throw new Error('Falha ao remover');
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    },
  };
}

function defaultDependencies(overrides = {}) {
  const session = overrides.storageSession ?? memorySession();
  const sent = [];
  const removed = [];
  const downloadsStarted = [];
  const downloadItems = [];
  const downloadSearches = [];
  return {
    session,
    sent,
    removed,
    downloadsStarted,
    downloadItems,
    downloadSearches,
    dependencies: {
      storageSession: session,
      createOperationId: () => 'operation-1',
      permissions: {
        contains: async () => true,
        remove: async (options) => { removed.push(options); return true; },
      },
      downloads: {
        async download(options) {
          downloadsStarted.push(options);
          const id = 40 + downloadsStarted.length;
          downloadItems.push({ id, url: options.url, state: 'in_progress' });
          return id;
        },
        async search(query) {
          downloadSearches.push(structuredClone(query));
          if (Number.isInteger(query?.id)) {
            return structuredClone(downloadItems.filter(({ id }) => id === query.id));
          }
          if (typeof query?.urlRegex === 'string') {
            const pattern = new RegExp(query.urlRegex);
            return structuredClone(downloadItems.filter(({ url }) => pattern.test(url)));
          }
          return [];
        },
      },
      sendOffscreen: async (message) => {
        sent.push(message);
        return { ok: true, value: message.action === ACTIONS.START_HLS
          ? { operationId: message.payload.operationId, state: 'assembling' }
          : { operationId: message.payload.operationId, state: 'releasing' } };
      },
      ...overrides,
    },
  };
}

test('direct downloads keep the exact Chrome call contract', async () => {
  const env = defaultDependencies();
  const handlers = createBackgroundHandlers(env.dependencies);

  assert.deepEqual(await handlers.handle(directMessage()), { downloadId: 41 });
  assert.deepEqual(env.downloadsStarted, [{
    url: 'https://cdn.test/aula.mp4', filename: 'aula.mp4', saveAs: true,
  }]);
});

test('DOWNLOAD_HLS persists then returns an acknowledged operation without waiting for assembly', async () => {
  const env = defaultDependencies();
  const handlers = createBackgroundHandlers(env.dependencies);

  assert.deepEqual(await handlers.handle(downloadMessage()), {
    operationId: 'operation-1', state: 'assembling',
  });
  assert.equal(env.downloadsStarted.length, 0);
  assert.equal(env.sent.length, 1);
  assert.deepEqual(env.sent[0], {
    target: 'offscreen',
    action: ACTIONS.START_HLS,
    payload: {
      operationId: 'operation-1',
      url: 'https://cdn.test/video.m3u8',
      allowedOrigins: ['https://cdn.test'],
    },
  });
  const record = Object.values(env.session.values).find((value) => value?.operationId === 'operation-1');
  assert.equal(record.url, 'https://cdn.test/video.m3u8');
  assert.equal(record.state, 'assembling');
});

test('concurrent equivalent starts share one persisted operation and one START_HLS', async () => {
  const env = defaultDependencies();
  let nextId = 0;
  env.dependencies.createOperationId = () => `operation-${++nextId}`;
  const handlers = createBackgroundHandlers(env.dependencies);

  const [first, second] = await Promise.all([
    handlers.handle(downloadMessage('https://cdn.test/video.m3u8#one')),
    handlers.handle(downloadMessage('https://cdn.test/video.m3u8#two')),
  ]);
  assert.deepEqual(first, second);
  assert.equal(first.operationId, 'operation-1');
  assert.equal(env.sent.filter(({ action }) => action === ACTIONS.START_HLS).length, 1);
});

test('a recreated coordinator reuses an assembling operation and handles completion once', async () => {
  const env = defaultDependencies();
  const first = createBackgroundHandlers(env.dependencies);
  const started = await first.handle(downloadMessage());

  env.sent.length = 0;
  const recreated = createBackgroundHandlers({
    ...env.dependencies,
    createOperationId: () => 'must-not-be-used',
  });
  await recreated.ready;
  assert.deepEqual(await recreated.handle(downloadMessage()), started);
  assert.equal(env.sent.filter(({ action }) => action === ACTIONS.START_HLS).length, 1);

  assert.deepEqual(await recreated.handle(completion(started.operationId)), { acknowledged: true });
  assert.deepEqual(await recreated.handle(completion(started.operationId)), { acknowledged: true });
  assert.equal(env.downloadsStarted.length, 1);
  assert.equal(env.downloadsStarted[0].saveAs, true);
});

test('progress updates persist monotonically and a different HLS start waits', async () => {
  const env = defaultDependencies();
  let nextId = 0;
  env.dependencies.createOperationId = () => `operation-${++nextId}`;
  const handlers = createBackgroundHandlers(env.dependencies);
  const started = await handlers.handle(downloadMessage());

  assert.deepEqual(await handlers.handle(progressMessage(
    started.operationId, 12, 30, 4096, 10_240,
  )), {
    acknowledged: true,
  });
  assert.deepEqual(env.session.values[`hlsOperation:${started.operationId}`].progress, {
    completedSegments: 12,
    totalSegments: 30,
    bytesReceived: 4096,
    estimatedTotalBytes: 10_240,
    percent: 40,
  });
  await handlers.handle(progressMessage(started.operationId, 10, 30, 2048, 6_144));
  assert.equal(env.session.values[`hlsOperation:${started.operationId}`].progress.percent, 40);

  await assert.rejects(
    handlers.handle(downloadMessage('https://cdn.test/other.m3u8')),
    (error) => error.code === 'HLS_BUSY',
  );
  assert.equal(env.sent.filter(({ action }) => action === ACTIONS.START_HLS).length, 1);
});

test('duplicate completion never redownloads when Chrome search no longer returns the mapped item', async () => {
  const env = defaultDependencies();
  env.dependencies.downloads.search = async () => [];
  const handlers = createBackgroundHandlers(env.dependencies);
  const started = await handlers.handle(downloadMessage());

  await handlers.handle(completion(started.operationId));
  await handlers.handle(completion(started.operationId));
  assert.equal(env.downloadsStarted.length, 1);
});

test('late assembly error cannot regress a downloading operation or release its active blob', async () => {
  const env = defaultDependencies();
  const handlers = createBackgroundHandlers(env.dependencies);
  const started = await handlers.handle(downloadMessage());
  await handlers.handle(completion(started.operationId));
  const removesBefore = env.session.calls.remove.length;
  const releasesBefore = env.sent.filter(({ action }) => action === ACTIONS.RELEASE_BLOB).length;
  const permissionRemovesBefore = env.removed.length;

  assert.deepEqual(await handlers.handle(failedCompletion(started.operationId)), { acknowledged: true });

  const record = Object.values(env.session.values).find(
    (value) => value?.operationId === started.operationId && value?.state,
  );
  assert.equal(record.state, 'downloading');
  assert.equal(record.downloadId, 41);
  assert.equal(env.session.values['hlsDownloadBlob:41'].operationId, started.operationId);
  assert.equal(env.session.calls.remove.length, removesBefore);
  assert.equal(
    env.sent.filter(({ action }) => action === ACTIONS.RELEASE_BLOB).length,
    releasesBefore,
  );
  assert.equal(env.removed.length, permissionRemovesBefore);
});

test('an unknown successful completion releases its blob and acknowledges it', async () => {
  const env = defaultDependencies();
  const handlers = createBackgroundHandlers(env.dependencies);
  await handlers.ready;

  assert.deepEqual(await handlers.handle(completion('unknown')), { acknowledged: true });
  assert.deepEqual(env.sent.at(-1), {
    target: 'offscreen',
    action: ACTIONS.RELEASE_BLOB,
    payload: { operationId: 'unknown', blobUrl: 'blob:extension.test/unknown' },
  });
  assert.equal(env.downloadsStarted.length, 0);
});

test('terminal notification received before download mapping eventually releases the blob', async () => {
  const env = defaultDependencies();
  let handleTerminal;
  env.dependencies.downloads = {
    async search() { return []; },
    async download(options) {
      env.downloadsStarted.push(options);
      void handleTerminal({ id: 77, state: { current: 'complete' } });
      return 77;
    },
  };
  const handlers = createBackgroundHandlers(env.dependencies);
  handleTerminal = createTerminalDownloadHandler(handlers);
  const started = await handlers.handle(downloadMessage());
  await handlers.handle(completion(started.operationId));
  await handlers.whenIdle();

  assert.ok(env.sent.some(({ action }) => action === ACTIONS.RELEASE_BLOB));
  assert.equal(Object.hasOwn(env.session.values, 'hlsDownloadBlob:77'), true);
  await handlers.handle(releasedMessage(started.operationId));
  assert.equal(Object.hasOwn(env.session.values, 'hlsDownloadBlob:77'), false);
});

test('storage failure after Chrome starts downloading keeps the blob and reconciles without duplication', async () => {
  const session = memorySession();
  const env = defaultDependencies({ storageSession: session });
  let failMapping = true;
  session.setFailure((entries) => failMapping && Object.keys(entries).some((key) => key.startsWith('hlsDownloadBlob:')));
  const handlers = createBackgroundHandlers(env.dependencies);
  const started = await handlers.handle(downloadMessage());

  await assert.rejects(handlers.handle(completion(started.operationId)), /persistir/);
  assert.equal(env.downloadsStarted.length, 1);
  assert.equal(env.sent.filter(({ action }) => action === ACTIONS.RELEASE_BLOB).length, 0);

  failMapping = false;
  assert.deepEqual(await handlers.handle(completion(started.operationId)), { acknowledged: true });
  assert.equal(env.downloadsStarted.length, 1);
  assert.equal(env.session.values['hlsDownloadBlob:41'].operationId, started.operationId);
  assert.ok(env.downloadSearches.some((query) => (
    typeof query.urlRegex === 'string' && !Object.hasOwn(query, 'url')
  )));
});

test('assembly completion durably releases host permissions before terminal browser state', async () => {
  const env = defaultDependencies();
  const handlers = createBackgroundHandlers(env.dependencies);
  const started = await handlers.handle(downloadMessage());

  await handlers.handle(completion(started.operationId));
  const record = Object.values(env.session.values).find(
    (value) => value?.operationId === started.operationId && value?.state,
  );
  assert.equal(record.state, 'downloading');
  assert.equal(record.permissionsReleased, true);
  assert.deepEqual(env.removed, [{ origins: ['https://cdn.test/*'] }]);
  assert.equal(env.sent.some(({ action }) => action === ACTIONS.RELEASE_BLOB), false);
});

test('terminal recovery still removes permissions when no assembly-release marker exists', async () => {
  const env = defaultDependencies();
  const handlers = createBackgroundHandlers(env.dependencies);
  const started = await handlers.handle(downloadMessage());

  await handlers.handle(failedCompletion(started.operationId));
  const record = env.session.values[`hlsOperation:${started.operationId}`];
  assert.equal(record.state, 'failed');
  assert.equal(record.cleanupPending, false);
  assert.equal(record.permissionsReleased, true);
  assert.deepEqual(env.removed, [{ origins: ['https://cdn.test/*'] }]);

  const recreated = createBackgroundHandlers(env.dependencies);
  await recreated.ready;
  assert.equal(env.removed.length, 1);
});

test('terminal cleanup keeps publishable status and finalizes only after durable HLS_RELEASED', async () => {
  const env = defaultDependencies();
  let nextId = 0;
  env.dependencies.createOperationId = () => `operation-${++nextId}`;
  const handlers = createBackgroundHandlers(env.dependencies);
  const started = await handlers.handle(downloadMessage());
  const blobUrl = `blob:extension.test/${started.operationId}`;
  await handlers.handle(completion(started.operationId, blobUrl));
  await handlers.handleDownloadChanged({ id: 41, state: { current: 'complete' } });

  let record = Object.values(env.session.values).find(
    (value) => value?.operationId === started.operationId && value?.state,
  );
  assert.equal(record.state, 'complete');
  assert.equal(record.cleanupPending, true);
  assert.equal(env.session.values['hlsDownloadBlob:41'].operationId, started.operationId);

  assert.deepEqual(await handlers.handle(releasedMessage(started.operationId, blobUrl)), {
    acknowledged: true,
  });
  record = env.session.values[`hlsOperation:${started.operationId}`];
  assert.equal(record.state, 'complete');
  assert.equal(record.cleanupPending, false);
  assert.equal(Object.hasOwn(record, 'blobUrl'), false);
  assert.equal(Object.hasOwn(env.session.values, 'hlsDownloadBlob:41'), false);
  assert.equal(Object.keys(env.session.values).some((key) => key.startsWith('hlsDedupe:')), false);
  assert.deepEqual(env.removed, [{ origins: ['https://cdn.test/*'] }]);

  const next = await handlers.handle(downloadMessage());
  assert.notEqual(next.operationId, started.operationId);
});

test('recreated worker resumes cleanup without another downloads.onChanged event', async () => {
  const env = defaultDependencies();
  const first = createBackgroundHandlers(env.dependencies);
  const started = await first.handle(downloadMessage());
  const blobUrl = `blob:extension.test/${started.operationId}`;
  await first.handle(completion(started.operationId, blobUrl));
  await first.handleDownloadChanged({ id: 41, state: { current: 'interrupted' } });
  const releaseCount = env.sent.filter(({ action }) => action === ACTIONS.RELEASE_BLOB).length;

  const recreated = createBackgroundHandlers(env.dependencies);
  await recreated.ready;
  assert.ok(env.sent.filter(({ action }) => action === ACTIONS.RELEASE_BLOB).length > releaseCount);
  await recreated.handle(releasedMessage(started.operationId, blobUrl));
  assert.equal(env.session.values[`hlsOperation:${started.operationId}`].cleanupPending, false);
});

test('worker recreation removes stale persisted inspection leases without touching active HLS permissions', async () => {
  const inspection = deferred();
  const env = defaultDependencies();
  let inspectionId = 0;
  env.dependencies.createInspectionId = () => `inspection-${++inspectionId}`;
  env.dependencies.sendOffscreen = async (message) => {
    env.sent.push(message);
    if (message.action === ACTIONS.INSPECT_HLS) return inspection.promise;
    if (message.action === ACTIONS.ARM_INSPECTION_CLEANUP) {
      return { ok: true, value: { leaseId: message.payload.leaseId, state: 'armed' } };
    }
    return { ok: true, value: { operationId: message.payload.operationId, state: 'assembling' } };
  };
  const first = createBackgroundHandlers(env.dependencies);
  await first.handle(downloadMessage());
  void first.handle(inspectMessage());
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(Object.keys(env.session.values).some((key) => key.startsWith('hlsInspection:')));

  const recreated = createBackgroundHandlers(env.dependencies);
  await recreated.ready;
  assert.equal(Object.keys(env.session.values).some((key) => key.startsWith('hlsInspection:')), false);
  assert.deepEqual(env.removed, []);
});

test('offscreen cleanup wake recovers a failed inspection permission removal after worker recreation', async () => {
  const session = memorySession();
  const permissionCalls = [];
  let removalAttempts = 0;
  let cleanupWake;
  const sendOffscreen = async (message) => {
    if (message.action === ACTIONS.START_HLS) {
      return { ok: true, value: { operationId: message.payload.operationId, state: 'assembling' } };
    }
    if (message.action === ACTIONS.INSPECT_HLS) {
      return { ok: true, value: {
        kind: 'media',
        variants: [{
          url: 'https://inspect.test/video.m3u8', label: 'Qualidade única',
          width: 0, height: 0, bandwidth: 0, codecs: '',
        }],
      } };
    }
    if (message.action === ACTIONS.ARM_INSPECTION_CLEANUP) {
      cleanupWake = {
        target: 'background',
        action: ACTIONS.INSPECTION_CLEANUP,
        payload: { leaseId: message.payload.leaseId },
      };
      return { ok: true, value: { leaseId: message.payload.leaseId, state: 'armed' } };
    }
    throw new Error(`unexpected ${message.action}`);
  };
  const dependencies = {
    storageSession: session,
    downloads: { async search() { return []; }, async download() { return 1; } },
    createOperationId: () => 'active-operation',
    createInspectionId: () => 'inspection-retry',
    sendOffscreen,
    permissions: {
      async contains() { return true; },
      async remove(options) {
        permissionCalls.push(options);
        removalAttempts += 1;
        if (removalAttempts === 1) throw new Error('falha transitória');
        return true;
      },
    },
  };
  const first = createBackgroundHandlers(dependencies);
  await first.handle({
    ...downloadMessage('https://video.test/live.m3u8'),
    payload: {
      ...downloadMessage('https://video.test/live.m3u8').payload,
      allowedOrigins: ['https://video.test'],
      permissionPatterns: ['https://video.test/*'],
    },
  });
  await assert.rejects(first.handle(inspectMessage(['https://inspect.test/*'])), /transitória/);
  assert.equal(session.values['hlsInspection:inspection-retry'].state, 'releasing');
  assert.ok(cleanupWake);

  const recreated = createBackgroundHandlers(dependencies);
  await recreated.ready;
  assert.equal(Object.hasOwn(session.values, 'hlsInspection:inspection-retry'), false);
  assert.deepEqual(permissionCalls, [
    { origins: ['https://inspect.test/*'] },
    { origins: ['https://inspect.test/*'] },
  ]);
  assert.equal(permissionCalls.some(({ origins }) => origins.includes('https://video.test/*')), false);
  assert.deepEqual(await recreated.handle(cleanupWake), { acknowledged: true });
});

test('permission removal serialized ahead of a new start makes it fail before START_HLS', async () => {
  let permissionPresent = true;
  const env = defaultDependencies();
  env.dependencies.permissions = {
    contains: async () => permissionPresent,
    remove: async (options) => {
      env.removed.push(options);
      permissionPresent = false;
      return true;
    },
  };
  const handlers = createBackgroundHandlers(env.dependencies);
  const started = await handlers.handle(downloadMessage());
  await handlers.handle(completion(started.operationId));

  await assert.rejects(
    handlers.handle(downloadMessage('https://cdn.test/other.m3u8')),
    (error) => error.code === 'BACKGROUND_PERMISSION_BUSY',
  );
  assert.equal(env.sent.filter(({ action }) => action === ACTIONS.START_HLS).length, 1);
});

test('inspection validates the complete result before returning and releases permissions', async () => {
  const env = defaultDependencies();
  env.dependencies.sendOffscreen = async (message) => {
    if (message.action === ACTIONS.ARM_INSPECTION_CLEANUP) {
      return { ok: true, value: { leaseId: message.payload.leaseId, state: 'armed' } };
    }
    return {
      ok: true,
      value: {
        kind: 'master',
        variants: [{
          url: 'javascript:alert(1)', label: '1080p', width: 1920, height: 1080,
          bandwidth: 5_000_000, codecs: 'avc1',
        }],
      },
    };
  };
  const handlers = createBackgroundHandlers(env.dependencies);

  await assert.rejects(handlers.handle(inspectMessage()), (error) => (
    error.code === 'BACKGROUND_OFFSCREEN_RESPONSE'
  ));
  assert.deepEqual(env.removed, [{ origins: ['https://cdn.test/*'] }]);
});

test('inspection accepts a parser variant whose optional codecs metadata is null', async () => {
  const env = defaultDependencies();
  const value = {
    kind: 'master',
    variants: [{
      url: 'https://cdn.test/1080.m3u8', label: '1080p', width: 1920, height: 1080,
      bandwidth: 5_000_000, codecs: null,
    }],
  };
  env.dependencies.sendOffscreen = async (message) => (
    message.action === ACTIONS.ARM_INSPECTION_CLEANUP
      ? { ok: true, value: { leaseId: message.payload.leaseId, state: 'armed' } }
      : { ok: true, value }
  );
  const handlers = createBackgroundHandlers(env.dependencies);

  assert.deepEqual(await handlers.handle(inspectMessage()), value);
});

test('background listener returns asynchronous safe envelopes', async () => {
  const listener = createBackgroundMessageListener({
    handle: async () => { throw Object.assign(new Error('Falha segura'), { code: 'HLS_NETWORK', details: {} }); },
  });
  assert.equal(listener({ target: 'offscreen' }, {}, () => {}), false);
  const response = await new Promise((resolve) => {
    assert.equal(listener(directMessage(), {}, resolve), true);
  });
  assert.deepEqual(response, {
    ok: false,
    error: { code: 'HLS_NETWORK', message: 'Falha segura', details: {} },
  });
});

test('Chrome 116 getContexts skips an existing document and coalesces concurrent creation', async () => {
  const originalChrome = globalThis.chrome;
  const runtimeListeners = [];
  const downloadListeners = [];
  const createCalls = [];
  const creation = deferred();
  let contexts = [{ contextType: 'OFFSCREEN_DOCUMENT' }];
  globalThis.chrome = {
    downloads: {
      onChanged: { addListener(listener) { downloadListeners.push(listener); } },
      async search() { return []; },
      async download() { return 1; },
    },
    storage: { session: memorySession() },
    permissions: { async contains() { return true; }, async remove() { return true; } },
    offscreen: {
      async createDocument(options) {
        createCalls.push(options);
        await creation.promise;
        contexts = [{ contextType: 'OFFSCREEN_DOCUMENT' }];
      },
    },
    runtime: {
      getURL(path) { return `chrome-extension://test/${path}`; },
      async getContexts(query) {
        assert.deepEqual(query, {
          contextTypes: ['OFFSCREEN_DOCUMENT'],
          documentUrls: ['chrome-extension://test/offscreen.html'],
        });
        return contexts;
      },
      onMessage: { addListener(listener) { runtimeListeners.push(listener); } },
      async sendMessage(message) {
        return { ok: true, value: message.action === ACTIONS.INSPECT_HLS
          ? { kind: 'media', variants: [{
            url: 'https://cdn.test/master.m3u8', label: 'Qualidade única', width: 0,
            height: 0, bandwidth: 0, codecs: '',
          }] }
          : { released: true } };
      },
    },
  };

  try {
    const main = await import(`../src/background/main.js?chrome116-${Date.now()}`);
    const sender = main.createOffscreenSender();
    await sender({ target: 'offscreen', action: ACTIONS.RELEASE_BLOB, payload: { blobUrl: 'blob:test/a' } });
    assert.equal(createCalls.length, 0);

    contexts = [];
    const first = sender({ target: 'offscreen', action: ACTIONS.RELEASE_BLOB, payload: { blobUrl: 'blob:test/b' } });
    const second = sender({ target: 'offscreen', action: ACTIONS.RELEASE_BLOB, payload: { blobUrl: 'blob:test/c' } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(createCalls.length, 1);
    creation.resolve();
    await Promise.all([first, second]);
    assert.equal(runtimeListeners.length, 1);
    assert.equal(downloadListeners.length, 1);
  } finally {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
  }
});
