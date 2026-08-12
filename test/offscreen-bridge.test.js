import assert from 'node:assert/strict';
import test from 'node:test';
import { HlsError } from '../src/hls/parse-playlist.js';
import { ACTIONS } from '../src/shared/messages.js';
import { createOffscreenBridge } from '../src/offscreen/bridge.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function startMessage(operationId = 'operation-1', url = 'https://cdn.test/video.m3u8') {
  return {
    target: 'offscreen',
    action: ACTIONS.START_HLS,
    payload: { operationId, url, allowedOrigins: ['https://cdn.test'] },
  };
}

function releaseMessage(operationId, blobUrl) {
  return {
    target: 'offscreen',
    action: ACTIONS.RELEASE_BLOB,
    payload: { operationId, blobUrl },
  };
}

test('inspects HLS synchronously and rejects the removed legacy DOWNLOAD_HLS path', async () => {
  const bridge = createOffscreenBridge({
    inspect: async () => ({ kind: 'media', variants: [] }),
  });
  assert.deepEqual(await bridge.handle({
    target: 'offscreen',
    action: ACTIONS.INSPECT_HLS,
    payload: { url: 'https://cdn.test/video.m3u8' },
  }), { kind: 'media', variants: [] });
  await assert.rejects(bridge.handle({
    target: 'offscreen',
    action: ACTIONS.DOWNLOAD_HLS,
    payload: {
      url: 'https://cdn.test/video.m3u8', filename: 'video.ts',
      allowedOrigins: ['https://cdn.test'], permissionPatterns: ['https://cdn.test/*'],
    },
  }), /Mensagem inválida/);
});

test('START_HLS acknowledges before assembly settles and delivers completion later', async () => {
  const assembly = deferred();
  const delivered = deferred();
  const bridge = createOffscreenBridge({
    assemble: async () => assembly.promise,
    createObjectURL: () => 'blob:extension.test/operation-1',
    sendCompletion: async (message) => {
      delivered.resolve(message);
      return { ok: true, value: { acknowledged: true } };
    },
  });
  assert.deepEqual(await bridge.handle(startMessage()), {
    operationId: 'operation-1', state: 'assembling',
  });
  assembly.resolve({ blob: new Blob(['HLS']), size: 3 });
  assert.deepEqual(await delivered.promise, {
    target: 'background',
    action: ACTIONS.HLS_COMPLETED,
    payload: {
      operationId: 'operation-1',
      result: { blobUrl: 'blob:extension.test/operation-1', size: 3 },
    },
  });
});

test('repeated START_HLS owns one assembly and retries completion to explicit ack', async () => {
  let assembles = 0;
  let deliveries = 0;
  let retries = 0;
  const done = deferred();
  const bridge = createOffscreenBridge({
    assemble: async () => { assembles += 1; return { blob: new Blob(['X']), size: 1 }; },
    createObjectURL: () => 'blob:extension.test/shared',
    scheduleRetry: async () => { retries += 1; },
    sendCompletion: async () => {
      deliveries += 1;
      if (deliveries === 1) throw new Error('worker suspenso');
      done.resolve();
      return { ok: true, value: { acknowledged: true } };
    },
  });
  await Promise.all([bridge.handle(startMessage()), bridge.handle(startMessage())]);
  await done.promise;
  assert.equal(assembles, 1);
  assert.equal(deliveries, 2);
  assert.equal(retries, 1);
});

test('offscreen forwards throttled integer HLS progress to the background', async () => {
  const progressMessages = [];
  const completed = deferred();
  const bridge = createOffscreenBridge({
    assemble: async (_url, { onProgress }) => {
      onProgress({
        completedSegments: 0, totalSegments: 200, bytesReceived: 0, estimatedTotalBytes: null,
      });
      onProgress({
        completedSegments: 1, totalSegments: 200, bytesReceived: 10, estimatedTotalBytes: 2_000,
      });
      onProgress({
        completedSegments: 2, totalSegments: 200, bytesReceived: 20, estimatedTotalBytes: 2_000,
      });
      return { blob: new Blob(['X']), size: 1 };
    },
    createObjectURL: () => 'blob:extension.test/progress',
    sendProgress: async (message) => { progressMessages.push(message); },
    sendCompletion: async () => {
      completed.resolve();
      return { ok: true, value: { acknowledged: true } };
    },
  });

  await bridge.handle(startMessage());
  await completed.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(progressMessages.map(({ payload }) => payload), [
    {
      operationId: 'operation-1', completedSegments: 0, totalSegments: 200,
      bytesReceived: 0, estimatedTotalBytes: null,
    },
    {
      operationId: 'operation-1', completedSegments: 2, totalSegments: 200,
      bytesReceived: 20, estimatedTotalBytes: 2_000,
    },
  ]);
});

test('release verifies operation ownership and cannot revoke another operation blob', async () => {
  const revoked = [];
  const completions = [];
  const bridge = createOffscreenBridge({
    assemble: async (url) => ({ blob: new Blob([url]), size: url.length }),
    createObjectURL: (blob) => `blob:extension.test/${blob.size}`,
    revokeObjectURL: (url) => revoked.push(url),
    sendCompletion: async (message) => {
      completions.push(message);
      return { ok: true, value: { acknowledged: true } };
    },
  });
  await bridge.handle(startMessage('operation-a', 'https://cdn.test/a.m3u8'));
  await bridge.handle(startMessage('operation-b', 'https://cdn.test/longer-b.m3u8'));
  await new Promise((resolve) => setImmediate(resolve));
  const completed = completions.filter(({ action }) => action === ACTIONS.HLS_COMPLETED);
  const blobA = completed.find(({ payload }) => payload.operationId === 'operation-a').payload.result.blobUrl;
  const blobB = completed.find(({ payload }) => payload.operationId === 'operation-b').payload.result.blobUrl;

  await assert.rejects(
    bridge.handle(releaseMessage('operation-a', blobB)),
    /não pertence|inválid/i,
  );
  assert.deepEqual(revoked, []);
  assert.deepEqual(await bridge.handle(releaseMessage('operation-a', blobA)), {
    operationId: 'operation-a', state: 'releasing',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(revoked, [blobA]);
  assert.ok(completions.some(({ action, payload }) => (
    action === ACTIONS.HLS_RELEASED && payload.operationId === 'operation-a' && payload.blobUrl === blobA
  )));
});

test('offscreen retries revocation and HLS_RELEASED delivery without worker timers', async () => {
  let revokes = 0;
  let releaseDeliveries = 0;
  let retries = 0;
  const released = deferred();
  const bridge = createOffscreenBridge({
    assemble: async () => ({ blob: new Blob(['X']), size: 1 }),
    createObjectURL: () => 'blob:extension.test/retry',
    revokeObjectURL: () => {
      revokes += 1;
      if (revokes === 1) throw new Error('revoke temporário');
    },
    scheduleRetry: async () => { retries += 1; },
    sendCompletion: async (message) => {
      if (message.action === ACTIONS.HLS_RELEASED) {
        releaseDeliveries += 1;
        if (releaseDeliveries === 1) throw new Error('worker indisponível');
        released.resolve();
      }
      return { ok: true, value: { acknowledged: true } };
    },
  });
  await bridge.handle(startMessage());
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await bridge.handle(releaseMessage('operation-1', 'blob:extension.test/retry')), {
    operationId: 'operation-1', state: 'releasing',
  });
  await released.promise;
  assert.equal(revokes, 2);
  assert.equal(releaseDeliveries, 2);
  assert.equal(retries, 2);
});

test('offscreen arms one inspection cleanup wake and retries until background ack', async () => {
  let deliveries = 0;
  let retries = 0;
  const delivered = deferred();
  const bridge = createOffscreenBridge({
    scheduleRetry: async () => { retries += 1; },
    sendCompletion: async (message) => {
      assert.deepEqual(message, {
        target: 'background',
        action: ACTIONS.INSPECTION_CLEANUP,
        payload: { leaseId: 'inspection-1' },
      });
      deliveries += 1;
      if (deliveries === 1) throw new Error('worker suspenso');
      delivered.resolve();
      return { ok: true, value: { acknowledged: true } };
    },
  });
  const arm = {
    target: 'offscreen',
    action: ACTIONS.ARM_INSPECTION_CLEANUP,
    payload: { leaseId: 'inspection-1' },
  };

  assert.deepEqual(await Promise.all([bridge.handle(arm), bridge.handle(arm)]), [
    { leaseId: 'inspection-1', state: 'armed' },
    { leaseId: 'inspection-1', state: 'armed' },
  ]);
  await delivered.promise;
  assert.equal(deliveries, 2);
  assert.equal(retries, 1);
});

test('offscreen listener keeps bounded safe response envelopes', async () => {
  const originalChrome = globalThis.chrome;
  let listener;
  globalThis.chrome = {
    runtime: { onMessage: { addListener(handler) { listener = handler; } } },
  };
  try {
    const main = await import(`../src/offscreen/main.js?listener-${Date.now()}`);
    assert.equal(listener({ target: 'background' }, {}, () => {}), false);
    const errorListener = main.createOffscreenMessageListener({
      handle: async () => { throw new HlsError('HLS_NETWORK', 'Falha segura', { status: 503 }); },
    });
    const response = await new Promise((resolve) => errorListener(startMessage(), {}, resolve));
    assert.deepEqual(response, {
      ok: false,
      error: { code: 'HLS_NETWORK', message: 'Falha segura', details: { status: 503 } },
    });
  } finally {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
  }
});
