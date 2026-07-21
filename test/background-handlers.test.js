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
  return {
    session,
    sent,
    removed,
    downloadsStarted,
    downloadItems,
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
        async search() { return structuredClone(downloadItems); },
      },
      sendOffscreen: async (message) => {
        sent.push(message);
        return { ok: true, value: message.action === ACTIONS.START_HLS
          ? { operationId: message.payload.operationId, state: 'assembling' }
          : { released: true } };
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
    url: 'https://cdn.test/aula.mp4', filename: 'aula.mp4', saveAs: false,
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
  assert.equal(env.sent.filter(({ action }) => action === ACTIONS.START_HLS).length, 0);

  assert.deepEqual(await recreated.handle(completion(started.operationId)), { acknowledged: true });
  assert.deepEqual(await recreated.handle(completion(started.operationId)), { acknowledged: true });
  assert.equal(env.downloadsStarted.length, 1);
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
  assert.deepEqual(env.removed, []);
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
  assert.equal(Object.hasOwn(env.session.values, 'hlsDownloadBlob:77'), false);
});

test('terminal cleanup failure schedules a durable retry without another onChanged event', async () => {
  const retries = [];
  const env = defaultDependencies({ scheduleRetry: (callback) => { retries.push(callback); } });
  let releaseCalls = 0;
  env.dependencies.sendOffscreen = async (message) => {
    env.sent.push(message);
    if (message.action === ACTIONS.START_HLS) {
      return { ok: true, value: { operationId: message.payload.operationId, state: 'assembling' } };
    }
    releaseCalls += 1;
    if (releaseCalls === 1) throw new Error('offscreen indisponível');
    return { ok: true, value: { released: true } };
  };
  const handlers = createBackgroundHandlers(env.dependencies);
  const started = await handlers.handle(downloadMessage());
  await handlers.handle(completion(started.operationId));
  await handlers.handleDownloadChanged({ id: 41, state: { current: 'interrupted' } });
  assert.equal(retries.length, 1);
  assert.equal(Object.hasOwn(env.session.values, 'hlsDownloadBlob:41'), true);

  await retries.shift()();
  await handlers.whenIdle();
  assert.equal(releaseCalls, 2);
  assert.equal(Object.hasOwn(env.session.values, 'hlsDownloadBlob:41'), false);
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
  await handlers.handleDownloadChanged({ id: 41, state: { current: 'complete' } });

  await assert.rejects(
    handlers.handle(downloadMessage('https://cdn.test/other.m3u8')),
    (error) => error.code === 'BACKGROUND_PERMISSION_BUSY',
  );
  assert.equal(env.sent.filter(({ action }) => action === ACTIONS.START_HLS).length, 1);
});

test('retrying old terminal cleanup does not erase a newer dedupe owner', async () => {
  const retries = [];
  const env = defaultDependencies({ scheduleRetry: (callback) => { retries.push(callback); } });
  let nextId = 0;
  let releaseCalls = 0;
  env.dependencies.createOperationId = () => `operation-${++nextId}`;
  env.dependencies.sendOffscreen = async (message) => {
    env.sent.push(message);
    if (message.action === ACTIONS.START_HLS) {
      return { ok: true, value: { operationId: message.payload.operationId, state: 'assembling' } };
    }
    releaseCalls += 1;
    if (releaseCalls === 1) throw new Error('release temporariamente indisponível');
    return { ok: true, value: { released: true } };
  };
  const handlers = createBackgroundHandlers(env.dependencies);
  const old = await handlers.handle(downloadMessage());
  await handlers.handle(completion(old.operationId));
  await handlers.handleDownloadChanged({ id: 41, state: { current: 'complete' } });
  const current = await handlers.handle(downloadMessage());
  assert.notEqual(current.operationId, old.operationId);

  await retries.shift()();
  const repeated = await handlers.handle(downloadMessage());
  assert.equal(repeated.operationId, current.operationId);
  assert.equal(env.sent.filter(({ action }) => action === ACTIONS.START_HLS).length, 2);
});

test('inspection validates the complete result before returning and releases permissions', async () => {
  const env = defaultDependencies();
  env.dependencies.sendOffscreen = async () => ({
    ok: true,
    value: {
      kind: 'master',
      variants: [{
        url: 'javascript:alert(1)', label: '1080p', width: 1920, height: 1080,
        bandwidth: 5_000_000, codecs: 'avc1',
      }],
    },
  });
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
  env.dependencies.sendOffscreen = async () => ({ ok: true, value });
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
