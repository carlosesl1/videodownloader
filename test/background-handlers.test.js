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
    payload: {
      url: 'https://cdn.test/master.m3u8',
      permissionPatterns: patterns,
    },
  };
}

function hlsDownloadMessage(patterns = ['https://cdn.test/*']) {
  return {
    target: 'background',
    action: ACTIONS.DOWNLOAD_HLS,
    payload: {
      url: 'https://cdn.test/master.m3u8',
      filename: 'aula.ts',
      allowedOrigins: ['https://cdn.test'],
      permissionPatterns: patterns,
    },
  };
}

function memorySession(initial = {}) {
  const values = { ...initial };
  const calls = { get: [], set: [], remove: [] };
  return {
    values,
    calls,
    async get(key) {
      calls.get.push(key);
      return Object.hasOwn(values, key) ? { [key]: values[key] } : {};
    },
    async set(entries) {
      calls.set.push(entries);
      Object.assign(values, entries);
    },
    async remove(key) {
      calls.remove.push(key);
      delete values[key];
    },
  };
}

test('direct download validates first and uses the exact Chrome download options', async () => {
  const calls = [];
  const handlers = createBackgroundHandlers({
    downloads: { download: async (options) => { calls.push(options); return 41; } },
    storageSession: memorySession(),
    permissions: { remove: async () => true },
    sendOffscreen: async () => { throw new Error('not used'); },
  });

  assert.deepEqual(await handlers.handle(directMessage()), { downloadId: 41 });
  assert.deepEqual(calls, [{
    url: 'https://cdn.test/aula.mp4',
    filename: 'aula.mp4',
    saveAs: false,
  }]);

  await assert.rejects(handlers.handle({ ...directMessage(), target: 'offscreen' }), /Mensagem inválida/);
  assert.equal(calls.length, 1);
});

test('HLS inspection forwards to offscreen, unwraps its value, and removes normalized permissions', async () => {
  const sent = [];
  const removed = [];
  const handlers = createBackgroundHandlers({
    downloads: { download: async () => 1 },
    storageSession: memorySession(),
    permissions: { remove: async (options) => { removed.push(options); return true; } },
    sendOffscreen: async (message) => {
      sent.push(message);
      return { ok: true, value: { kind: 'media', duration: 30 } };
    },
  });
  const message = inspectMessage(['https://cdn.test/*', 'https://cdn.test/*']);

  assert.deepEqual(await handlers.handle(message), { kind: 'media', duration: 30 });
  assert.deepEqual(sent, [{ ...message, target: 'offscreen' }]);
  assert.deepEqual(removed, [{ origins: ['https://cdn.test/*'] }]);
});

test('HLS inspection removes permissions after failure and preserves the remote safe error', async () => {
  const removed = [];
  const handlers = createBackgroundHandlers({
    downloads: { download: async () => 1 },
    storageSession: memorySession(),
    permissions: { remove: async (options) => { removed.push(options); return true; } },
    sendOffscreen: async () => ({
      ok: false,
      error: { code: 'HLS_NETWORK', message: 'Falha segura', details: { status: 503 } },
    }),
  });

  await assert.rejects(handlers.handle(inspectMessage()), (error) => {
    assert.equal(error.code, 'HLS_NETWORK');
    assert.equal(error.message, 'Falha segura');
    assert.deepEqual(error.details, { status: 503 });
    return true;
  });
  assert.deepEqual(removed, [{ origins: ['https://cdn.test/*'] }]);
});

test('HLS download releases its permission after assembly, downloads the blob, and tracks it per id', async () => {
  const events = [];
  const session = memorySession();
  const handlers = createBackgroundHandlers({
    downloads: {
      download: async (options) => {
        events.push(['download', options]);
        return 17;
      },
    },
    storageSession: {
      ...session,
      async set(entries) {
        events.push(['set', entries]);
        return session.set(entries);
      },
    },
    permissions: {
      remove: async (options) => {
        events.push(['remove', options]);
        return true;
      },
    },
    sendOffscreen: async (message) => {
      events.push(['offscreen', message]);
      return { ok: true, value: { blobUrl: 'blob:extension.test/hls-17', size: 99 } };
    },
  });
  const message = hlsDownloadMessage();

  assert.deepEqual(await handlers.handle(message), { downloadId: 17 });
  assert.deepEqual(events, [
    ['offscreen', { ...message, target: 'offscreen' }],
    ['remove', { origins: ['https://cdn.test/*'] }],
    ['download', { url: 'blob:extension.test/hls-17', filename: 'aula.ts', saveAs: false }],
    ['set', { 'hlsDownloadBlob:17': 'blob:extension.test/hls-17' }],
  ]);
  assert.equal(session.values['hlsDownloadBlob:17'], 'blob:extension.test/hls-17');
});

test('HLS download releases a created blob immediately if Chrome download or tracking fails', async () => {
  for (const failingStep of ['download', 'storage']) {
    const sent = [];
    const handlers = createBackgroundHandlers({
      downloads: {
        download: async () => {
          if (failingStep === 'download') throw new Error('Falha no download');
          return 22;
        },
      },
      storageSession: {
        async set() {
          if (failingStep === 'storage') throw new Error('Falha no armazenamento');
        },
      },
      permissions: { remove: async () => true },
      sendOffscreen: async (message) => {
        sent.push(message);
        if (message.action === ACTIONS.RELEASE_BLOB) return { ok: true, value: { released: true } };
        return { ok: true, value: { blobUrl: `blob:extension.test/${failingStep}`, size: 10 } };
      },
    });

    await assert.rejects(handlers.handle(hlsDownloadMessage()), /Falha/);
    assert.deepEqual(sent.at(-1), {
      target: 'offscreen',
      action: ACTIONS.RELEASE_BLOB,
      payload: { blobUrl: `blob:extension.test/${failingStep}` },
    });
  }
});

test('permission leases keep a shared pattern until the last concurrent operation finishes', async () => {
  const pending = [deferred(), deferred()];
  const removed = [];
  let call = 0;
  const handlers = createBackgroundHandlers({
    downloads: { download: async () => 1 },
    storageSession: memorySession(),
    permissions: { remove: async (options) => { removed.push(options); return true; } },
    sendOffscreen: async () => pending[call++].promise,
  });

  const first = handlers.handle(inspectMessage());
  const second = handlers.handle(inspectMessage());
  pending[0].resolve({ ok: true, value: { operation: 1 } });
  assert.deepEqual(await first, { operation: 1 });
  assert.deepEqual(removed, []);
  pending[1].resolve({ ok: true, value: { operation: 2 } });
  assert.deepEqual(await second, { operation: 2 });
  assert.deepEqual(removed, [{ origins: ['https://cdn.test/*'] }]);
});

test('permission leases clean distinct concurrent patterns independently', async () => {
  const pending = [deferred(), deferred()];
  const removed = [];
  let call = 0;
  const handlers = createBackgroundHandlers({
    downloads: { download: async () => 1 },
    storageSession: memorySession(),
    permissions: { remove: async (options) => { removed.push(options); return true; } },
    sendOffscreen: async () => pending[call++].promise,
  });

  const first = handlers.handle(inspectMessage(['https://one.test/*']));
  const second = handlers.handle(inspectMessage(['https://two.test/*']));
  pending[1].resolve({ ok: true, value: 2 });
  assert.equal(await second, 2);
  assert.deepEqual(removed, [{ origins: ['https://two.test/*'] }]);
  pending[0].resolve({ ok: true, value: 1 });
  assert.equal(await first, 1);
  assert.deepEqual(removed, [
    { origins: ['https://two.test/*'] },
    { origins: ['https://one.test/*'] },
  ]);
});

test('terminal download events release tracked blobs, retry failures, and are idempotent', async () => {
  const key = 'hlsDownloadBlob:73';
  const session = memorySession({ [key]: 'blob:extension.test/hls-73' });
  const sent = [];
  let shouldFail = true;
  const handleTerminal = createTerminalDownloadHandler({
    storageSession: session,
    sendOffscreen: async (message) => {
      sent.push(message);
      if (shouldFail) throw new Error('offscreen indisponível');
      return { ok: true, value: { released: true } };
    },
  });

  await handleTerminal({ id: 73, state: { current: 'in_progress' } });
  assert.equal(sent.length, 0);
  await handleTerminal({ id: 999, state: { current: 'complete' } });
  assert.equal(sent.length, 0);

  await assert.rejects(handleTerminal({ id: 73, state: { current: 'interrupted' } }), /offscreen indisponível/);
  assert.equal(session.values[key], 'blob:extension.test/hls-73');
  assert.deepEqual(session.calls.remove, []);

  shouldFail = false;
  await handleTerminal({ id: 73, state: { current: 'complete' } });
  assert.equal(Object.hasOwn(session.values, key), false);
  assert.deepEqual(session.calls.remove, [key]);
  await handleTerminal({ id: 73, state: { current: 'complete' } });
  assert.equal(sent.length, 2);
});

test('terminal download events coalesce repeated terminal notifications in flight', async () => {
  const key = 'hlsDownloadBlob:8';
  const session = memorySession({ [key]: 'blob:extension.test/hls-8' });
  const release = deferred();
  let sends = 0;
  const handleTerminal = createTerminalDownloadHandler({
    storageSession: session,
    sendOffscreen: async () => { sends += 1; return release.promise; },
  });

  const first = handleTerminal({ id: 8, state: { current: 'complete' } });
  const second = handleTerminal({ id: 8, state: { current: 'interrupted' } });
  release.resolve({ ok: true, value: { released: true } });
  await Promise.all([first, second]);
  assert.equal(sends, 1);
  assert.deepEqual(session.calls.remove, [key]);
});

test('malformed offscreen responses become bounded safe background errors', async () => {
  const handlers = createBackgroundHandlers({
    downloads: { download: async () => 1 },
    storageSession: memorySession(),
    permissions: { remove: async () => true },
    sendOffscreen: async () => ({ ok: true }),
  });

  await assert.rejects(handlers.handle(inspectMessage()), (error) => {
    assert.equal(error.code, 'BACKGROUND_OFFSCREEN_RESPONSE');
    assert.match(error.message, /resposta/i);
    assert.deepEqual(error.details, {});
    return true;
  });
});

test('background listener handles only its target and returns JSON-safe bounded envelopes', async () => {
  let ignored = false;
  const successful = createBackgroundMessageListener({
    handle: async () => ({ downloadId: 4 }),
  });
  assert.equal(successful({ target: 'offscreen' }, {}, () => { ignored = true; }), false);
  assert.equal(ignored, false);
  const successResponse = await new Promise((resolve) => {
    assert.equal(successful(directMessage(), {}, resolve), true);
  });
  assert.deepEqual(successResponse, { ok: true, value: { downloadId: 4 } });

  const cyclic = {};
  cyclic.self = cyclic;
  const failing = createBackgroundMessageListener({
    handle: async () => {
      const error = new Error('x'.repeat(1_000));
      error.code = 'unsafe-code';
      error.details = cyclic;
      error.stack = 'segredo';
      error.cause = 'segredo';
      throw error;
    },
  });
  const failureResponse = await new Promise((resolve) => failing(directMessage(), {}, resolve));
  assert.deepEqual(failureResponse, {
    ok: false,
    error: {
      code: 'BACKGROUND_UNKNOWN',
      message: 'Não foi possível concluir a operação.',
      details: {},
    },
  });
  assert.doesNotThrow(() => JSON.stringify(failureResponse));
  assert.equal('stack' in failureResponse.error, false);
  assert.equal('cause' in failureResponse.error, false);
});

test('background main coalesces offscreen creation and registers each Chrome listener once', async () => {
  const originalChrome = globalThis.chrome;
  const runtimeListeners = [];
  const downloadListeners = [];
  const creation = deferred();
  const createCalls = [];
  let documentExists = false;
  globalThis.chrome = {
    downloads: {
      onChanged: { addListener(listener) { downloadListeners.push(listener); } },
      async download() { return 1; },
    },
    storage: { session: memorySession() },
    permissions: { async remove() { return true; } },
    offscreen: {
      async hasDocument() { return documentExists; },
      async createDocument(options) {
        createCalls.push(options);
        await creation.promise;
        documentExists = true;
      },
    },
    runtime: {
      onMessage: { addListener(listener) { runtimeListeners.push(listener); } },
      async sendMessage() { return { ok: true, value: { kind: 'media' } }; },
    },
  };

  try {
    await import(`../src/background/main.js?main-contract-${Date.now()}`);
    assert.equal(runtimeListeners.length, 1);
    assert.equal(downloadListeners.length, 1);

    const first = new Promise((resolve) => runtimeListeners[0](inspectMessage(), {}, resolve));
    const second = new Promise((resolve) => runtimeListeners[0](inspectMessage(), {}, resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(createCalls.length, 1);
    assert.deepEqual(createCalls[0], {
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Processar playlists HLS e manter blobs para downloads.',
    });
    creation.resolve();
    assert.deepEqual(await first, { ok: true, value: { kind: 'media' } });
    assert.deepEqual(await second, { ok: true, value: { kind: 'media' } });
  } finally {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
  }
});
