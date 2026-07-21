import assert from 'node:assert/strict';
import test from 'node:test';
import { ACTIONS } from '../src/shared/messages.js';
import { createOffscreenBridge } from '../src/offscreen/bridge.js';

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
