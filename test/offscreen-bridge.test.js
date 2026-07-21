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

function downloadMessage(url = 'https://cdn.test/video.m3u8') {
  return {
    target: 'offscreen',
    action: ACTIONS.DOWNLOAD_HLS,
    payload: {
      url,
      filename: 'video.ts',
      allowedOrigins: ['https://cdn.test'],
      permissionPatterns: ['https://cdn.test/*'],
    },
  };
}

test('downloads HLS to an owned object URL and releases it once', async () => {
  const assembleCalls = [];
  const revoked = [];
  const bridge = createOffscreenBridge({
    assemble: async (...args) => {
      assembleCalls.push(args);
      return { blob: new Blob(['HLS']), size: 3 };
    },
    createObjectURL: (blob) => {
      assert.ok(blob instanceof Blob);
      return 'blob:extension.test/hls-1';
    },
    revokeObjectURL: (url) => revoked.push(url),
  });

  assert.deepEqual(await bridge.handle(downloadMessage()), {
    blobUrl: 'blob:extension.test/hls-1',
    size: 3,
  });
  assert.deepEqual(assembleCalls, [[
    'https://cdn.test/video.m3u8',
    { allowedOrigins: ['https://cdn.test'] },
  ]]);
  assert.deepEqual(await bridge.handle({
    target: 'offscreen',
    action: ACTIONS.RELEASE_BLOB,
    payload: { blobUrl: 'blob:extension.test/hls-1' },
  }), { released: true });
  assert.deepEqual(revoked, ['blob:extension.test/hls-1']);
});

test('does not revoke unowned URLs or an already released URL', async () => {
  const revoked = [];
  const bridge = createOffscreenBridge({
    createObjectURL: () => 'blob:extension.test/owned',
    revokeObjectURL: (url) => revoked.push(url),
    assemble: async () => ({ blob: new Blob(['X']), size: 1 }),
  });

  const unowned = {
    target: 'offscreen',
    action: ACTIONS.RELEASE_BLOB,
    payload: { blobUrl: 'blob:extension.test/unowned' },
  };
  assert.deepEqual(await bridge.handle(unowned), { released: false });
  await bridge.handle(downloadMessage());
  const owned = { ...unowned, payload: { blobUrl: 'blob:extension.test/owned' } };
  assert.deepEqual(await bridge.handle(owned), { released: true });
  assert.deepEqual(await bridge.handle(owned), { released: false });
  assert.deepEqual(revoked, ['blob:extension.test/owned']);
});

test('keeps blob ownership when revocation fails so terminal cleanup can retry', async () => {
  let revokeCalls = 0;
  const bridge = createOffscreenBridge({
    assemble: async () => ({ blob: new Blob(['X']), size: 1 }),
    createObjectURL: () => 'blob:extension.test/retry-release',
    revokeObjectURL: () => {
      revokeCalls += 1;
      if (revokeCalls === 1) throw new Error('revogação temporariamente indisponível');
    },
  });
  await bridge.handle(downloadMessage());
  const release = {
    target: 'offscreen',
    action: ACTIONS.RELEASE_BLOB,
    payload: { blobUrl: 'blob:extension.test/retry-release' },
  };

  await assert.rejects(bridge.handle(release), /temporariamente/);
  assert.deepEqual(await bridge.handle(release), { released: true });
  assert.equal(revokeCalls, 2);
});

test('delegates HLS inspection with its URL and returns variants', async () => {
  const calls = [];
  const variants = [{ label: '1080p', url: 'https://cdn.test/1080.m3u8' }];
  const bridge = createOffscreenBridge({
    inspect: async (url) => {
      calls.push(url);
      return { kind: 'master', variants };
    },
  });
  const message = {
    target: 'offscreen',
    action: ACTIONS.INSPECT_HLS,
    payload: { url: 'https://cdn.test/master.m3u8', permissionPatterns: ['https://cdn.test/*'] },
  };

  assert.deepEqual(await bridge.handle(message), { kind: 'master', variants });
  assert.deepEqual(calls, ['https://cdn.test/master.m3u8']);
});

test('rejects invalid offscreen targets, actions, and payloads before any operation', async () => {
  let calls = 0;
  const bridge = createOffscreenBridge({
    inspect: async () => { calls += 1; },
    assemble: async () => { calls += 1; },
  });
  for (const message of [
    { ...downloadMessage(), target: 'background' },
    { ...downloadMessage(), action: 'UNSAFE_ACTION' },
    { ...downloadMessage(), payload: { ...downloadMessage().payload, allowedOrigins: [null] } },
  ]) {
    await assert.rejects(bridge.handle(message));
  }
  assert.equal(calls, 0);
});

test('does not retain URLs when assembly or URL creation fails', async () => {
  const revoked = [];
  const assembleFailure = createOffscreenBridge({
    assemble: async () => { throw new Error('assembly failed'); },
    revokeObjectURL: (url) => revoked.push(url),
  });
  await assert.rejects(assembleFailure.handle(downloadMessage()), /assembly failed/);
  assert.deepEqual(await assembleFailure.handle({
    target: 'offscreen', action: ACTIONS.RELEASE_BLOB, payload: { blobUrl: 'blob:extension.test/no-assembly' },
  }), { released: false });

  const urlFailure = createOffscreenBridge({
    assemble: async () => ({ blob: new Blob(['X']), size: 1 }),
    createObjectURL: () => { throw new Error('url failed'); },
    revokeObjectURL: (url) => revoked.push(url),
  });
  await assert.rejects(urlFailure.handle(downloadMessage()), /url failed/);
  assert.deepEqual(await urlFailure.handle({
    target: 'offscreen', action: ACTIONS.RELEASE_BLOB, payload: { blobUrl: 'blob:extension.test/no-url' },
  }), { released: false });
  assert.deepEqual(revoked, []);
});

test('rejects invalid assembled results and non-blob object URLs without retaining ownership', async () => {
  const revoked = [];
  let createCalls = 0;
  const invalidResults = [
    { blob: 'not-a-blob', size: 1 },
    { blob: new Blob(['X']), size: -1 },
    { blob: new Blob(['X']), size: Number.MAX_SAFE_INTEGER + 1 },
  ];

  for (const result of invalidResults) {
    const bridge = createOffscreenBridge({
      assemble: async () => result,
      createObjectURL: () => { createCalls += 1; throw new Error('must not create a URL'); },
      revokeObjectURL: (url) => revoked.push(url),
    });
    await assert.rejects(bridge.handle(downloadMessage()));
  }
  assert.equal(createCalls, 0);

  for (const blobUrl of ['', 'blob:', 'blob: ', 'https://extension.test/file', 'data:text/plain,video']) {
    const bridge = createOffscreenBridge({
      assemble: async () => ({ blob: new Blob(['X']), size: 1 }),
      createObjectURL: () => blobUrl,
      revokeObjectURL: (url) => revoked.push(url),
    });
    await assert.rejects(bridge.handle(downloadMessage()));
    if (blobUrl.startsWith('blob:')) {
      assert.deepEqual(await bridge.handle({
        target: 'offscreen', action: ACTIONS.RELEASE_BLOB, payload: { blobUrl },
      }), { released: false });
    }
  }
  assert.deepEqual(revoked, []);
});

test('owns simultaneous HLS downloads independently', async () => {
  let nextUrl = 0;
  const revoked = [];
  const bridge = createOffscreenBridge({
    assemble: async (url) => ({ blob: new Blob([url]), size: url.length }),
    createObjectURL: () => `blob:extension.test/${nextUrl += 1}`,
    revokeObjectURL: (url) => revoked.push(url),
  });

  const [first, second] = await Promise.all([
    bridge.handle(downloadMessage('https://cdn.test/one.m3u8')),
    bridge.handle(downloadMessage('https://cdn.test/two.m3u8')),
  ]);
  assert.notEqual(first.blobUrl, second.blobUrl);
  assert.deepEqual(await bridge.handle({
    target: 'offscreen', action: ACTIONS.RELEASE_BLOB, payload: { blobUrl: second.blobUrl },
  }), { released: true });
  assert.deepEqual(await bridge.handle({
    target: 'offscreen', action: ACTIONS.RELEASE_BLOB, payload: { blobUrl: first.blobUrl },
  }), { released: true });
  assert.deepEqual(revoked, [second.blobUrl, first.blobUrl]);
});

test('START_HLS acknowledges before assembly settles and delivers completion later', async () => {
  const assembly = deferred();
  const completionDelivered = deferred();
  const bridge = createOffscreenBridge({
    assemble: async () => assembly.promise,
    createObjectURL: () => 'blob:extension.test/operation-1',
    sendCompletion: async (message) => {
      completionDelivered.resolve(message);
      return { ok: true, value: { acknowledged: true } };
    },
  });
  const start = {
    target: 'offscreen',
    action: ACTIONS.START_HLS,
    payload: {
      operationId: 'operation-1',
      url: 'https://cdn.test/video.m3u8',
      allowedOrigins: ['https://cdn.test'],
    },
  };

  assert.deepEqual(await bridge.handle(start), { operationId: 'operation-1', state: 'assembling' });
  let delivered = false;
  completionDelivered.promise.then(() => { delivered = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(delivered, false);

  assembly.resolve({ blob: new Blob(['HLS']), size: 3 });
  assert.deepEqual(await completionDelivered.promise, {
    target: 'background',
    action: ACTIONS.HLS_COMPLETED,
    payload: {
      operationId: 'operation-1',
      result: { blobUrl: 'blob:extension.test/operation-1', size: 3 },
    },
  });
});

test('repeated START_HLS reuses one assembly and retries completion until explicit ack', async () => {
  let assembleCalls = 0;
  let completionCalls = 0;
  let retryCalls = 0;
  const delivered = deferred();
  const bridge = createOffscreenBridge({
    assemble: async () => {
      assembleCalls += 1;
      return { blob: new Blob(['X']), size: 1 };
    },
    createObjectURL: () => 'blob:extension.test/shared',
    scheduleRetry: async () => { retryCalls += 1; },
    sendCompletion: async () => {
      completionCalls += 1;
      if (completionCalls === 1) throw new Error('worker suspenso');
      delivered.resolve();
      return { ok: true, value: { acknowledged: true } };
    },
  });
  const message = {
    target: 'offscreen',
    action: ACTIONS.START_HLS,
    payload: {
      operationId: 'same-operation',
      url: 'https://cdn.test/video.m3u8',
      allowedOrigins: ['https://cdn.test'],
    },
  };

  assert.deepEqual(await Promise.all([bridge.handle(message), bridge.handle(message)]), [
    { operationId: 'same-operation', state: 'assembling' },
    { operationId: 'same-operation', state: 'assembling' },
  ]);
  await delivered.promise;
  assert.equal(assembleCalls, 1);
  assert.equal(completionCalls, 2);
  assert.equal(retryCalls, 1);

  assert.deepEqual(await bridge.handle({
    target: 'offscreen',
    action: ACTIONS.RELEASE_BLOB,
    payload: { operationId: 'same-operation', blobUrl: 'blob:extension.test/shared' },
  }), { released: true });
});

test('registers an async offscreen listener and keeps its nested safe error contract', async () => {
  const originalChrome = globalThis.chrome;
  let listener;
  globalThis.chrome = {
    runtime: {
      onMessage: {
        addListener(handler) {
          listener = handler;
        },
      },
    },
  };

  try {
    const main = await import('../src/offscreen/main.js?listener-contract');
    assert.equal(typeof listener, 'function');
    let ignored = false;
    assert.equal(listener({ target: 'background' }, {}, () => { ignored = true; }), false);
    assert.equal(ignored, false);

    const response = await new Promise((resolve) => {
      assert.equal(listener({
        target: 'offscreen',
        action: ACTIONS.RELEASE_BLOB,
        payload: { blobUrl: 'blob:extension.test/unowned' },
      }, {}, resolve), true);
    });
    assert.deepEqual(response, { ok: true, value: { released: false } });

    const errorListener = main.createOffscreenMessageListener({
      handle: async () => { throw new HlsError('HLS_NETWORK', 'Falha HLS segura', { status: 503 }); },
    });
    const hlsError = await new Promise((resolve) => errorListener({ target: 'offscreen' }, {}, resolve));
    assert.deepEqual(hlsError, {
      ok: false,
      error: { code: 'HLS_NETWORK', message: 'Falha HLS segura', details: { status: 503 } },
    });

    const regularErrorListener = main.createOffscreenMessageListener({
      handle: async () => { throw new Error('Falha comum segura'); },
    });
    const regularError = await new Promise((resolve) => regularErrorListener({ target: 'offscreen' }, {}, resolve));
    assert.deepEqual(regularError, {
      ok: false,
      error: { code: 'HLS_UNKNOWN', message: 'Falha comum segura', details: {} },
    });
    assert.equal('stack' in regularError.error, false);
    assert.equal('cause' in regularError.error, false);

    const arbitraryListener = main.createOffscreenMessageListener({
      handle: async () => { throw { stack: 'secret stack', cause: 'secret cause' }; },
    });
    const arbitraryError = await new Promise((resolve) => arbitraryListener({ target: 'offscreen' }, {}, resolve));
    assert.deepEqual(arbitraryError, {
      ok: false,
      error: {
        code: 'HLS_UNKNOWN',
        message: 'Não foi possível processar a operação HLS.',
        details: {},
      },
    });
    assert.equal('stack' in arbitraryError.error, false);
    assert.equal('cause' in arbitraryError.error, false);

    const cyclic = {};
    cyclic.self = cyclic;
    const throwingToJson = { toJSON() { throw new Error('secret serializer'); } };
    const unsafeCases = [
      { code: 'unsafe-code', details: { value: 1 }, expectedCode: 'HLS_UNKNOWN', expectedDetails: { value: 1 } },
      { code: 123, details: { value: 2 }, expectedCode: 'HLS_UNKNOWN', expectedDetails: { value: 2 } },
      { code: 'HLS_CYCLIC', details: cyclic, expectedCode: 'HLS_CYCLIC', expectedDetails: {} },
      { code: 'HLS_BIGINT', details: { size: 1n }, expectedCode: 'HLS_BIGINT', expectedDetails: {} },
      { code: 'HLS_TO_JSON', details: throwingToJson, expectedCode: 'HLS_TO_JSON', expectedDetails: {} },
      { code: 'HLS_PRIMITIVE', details: 'not-an-object', expectedCode: 'HLS_PRIMITIVE', expectedDetails: {} },
    ];
    for (const { code, details, expectedCode, expectedDetails } of unsafeCases) {
      const error = new HlsError(code, 'Falha HLS segura', details);
      const unsafeListener = main.createOffscreenMessageListener({
        handle: async () => { throw error; },
      });
      const response = await new Promise((resolve) => unsafeListener({ target: 'offscreen' }, {}, resolve));
      assert.deepEqual(response, {
        ok: false,
        error: { code: expectedCode, message: 'Falha HLS segura', details: expectedDetails },
      });
      assert.doesNotThrow(() => JSON.stringify(response));
    }
  } finally {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
  }
});
