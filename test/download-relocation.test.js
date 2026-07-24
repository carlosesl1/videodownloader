import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DELIVERY_RESULT_PREFIX,
  RELOCATION_PREFIX,
  createDownloadRelocationCoordinator,
} from '../src/background/download-relocation.js';
import { HOST_COMMANDS } from '../src/youtube/protocol.js';

function memoryLocal(initial = {}) {
  const values = structuredClone(initial);
  return {
    values,
    async get(keys) {
      if (keys === null) return structuredClone(values);
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(
        requested.filter((key) => Object.hasOwn(values, key))
          .map((key) => [key, structuredClone(values[key])]),
      );
    },
    async set(entries) { Object.assign(values, structuredClone(entries)); },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    },
  };
}

function fakeDownloads(items) {
  return {
    async search({ id }) {
      return structuredClone(items.filter((item) => item.id === id));
    },
  };
}

function fakeNative(handler) {
  const requests = [];
  return {
    requests,
    async request(type, payload) {
      requests.push({ type, payload: structuredClone(payload) });
      return handler(type, payload);
    },
  };
}

function activeRecord(overrides = {}) {
  return {
    downloadId: 42,
    operationId: 'op_1',
    destinationFolder: String.raw`D:\Vídeos`,
    status: 'downloading',
    mediaKind: 'direct',
    mediaUrl: 'https://cdn.test/aula.mp4',
    displayName: 'aula.mp4',
    stagingPath: null,
    finalPath: null,
    errorCode: null,
    updatedAt: 1,
    ...overrides,
  };
}

test('persiste por downloadId, move ao concluir e guarda caminho final', async () => {
  const storageLocal = memoryLocal();
  const downloads = fakeDownloads([{
    id: 42,
    state: 'complete',
    filename: String.raw`C:\Downloads\Video Radar\.staging\op_1\aula.ts`,
  }]);
  const nativeClient = fakeNative((_type, payload) => ({
    type: 'fileMoved',
    requestId: 'move-1',
    downloadId: payload.downloadId,
    finalPath: String.raw`D:\Vídeos\aula.ts`,
  }));
  const coordinator = createDownloadRelocationCoordinator({
    storageLocal,
    downloads,
    nativeClient,
    now: () => 10,
  });

  await coordinator.track(activeRecord({ mediaKind: 'hls', displayName: 'aula.ts' }));
  await coordinator.handleChanged({ id: 42, state: { current: 'complete' } });

  assert.deepEqual(await coordinator.get(42), activeRecord({
    mediaKind: 'hls',
    displayName: 'aula.ts',
    status: 'complete',
    stagingPath: String.raw`C:\Downloads\Video Radar\.staging\op_1\aula.ts`,
    finalPath: String.raw`D:\Vídeos\aula.ts`,
    updatedAt: 10,
  }));
  assert.equal(Object.hasOwn(storageLocal.values, `${RELOCATION_PREFIX}42`), false);
  assert.equal(Object.hasOwn(storageLocal.values, `${DELIVERY_RESULT_PREFIX}42`), true);
  assert.deepEqual(nativeClient.requests, [{
    type: HOST_COMMANDS.MOVE_DOWNLOADED_FILE,
    payload: {
      downloadId: 42,
      sourcePath: String.raw`C:\Downloads\Video Radar\.staging\op_1\aula.ts`,
      destinationFolder: String.raw`D:\Vídeos`,
    },
  }]);
});

test('retoma download completo após reinício e serializa observações concorrentes', async () => {
  const storageLocal = memoryLocal({
    [`${RELOCATION_PREFIX}42`]: activeRecord(),
  });
  const downloads = fakeDownloads([{
    id: 42,
    state: 'complete',
    filename: String.raw`C:\Downloads\Video Radar\.staging\op_1\aula.mp4`,
  }]);
  let calls = 0;
  const nativeClient = fakeNative(async (_type, payload) => {
    calls += 1;
    await new Promise((resolve) => setImmediate(resolve));
    return {
      type: 'fileMoved',
      requestId: 'move-1',
      downloadId: payload.downloadId,
      finalPath: String.raw`D:\Vídeos\aula.mp4`,
    };
  });
  const coordinator = createDownloadRelocationCoordinator({
    storageLocal,
    downloads,
    nativeClient,
    now: () => 20,
  });

  await Promise.all([
    coordinator.reconcile(),
    coordinator.handleChanged({ id: 42, state: { current: 'complete' } }),
  ]);

  assert.equal(calls, 1);
  assert.equal((await coordinator.get(42)).status, 'complete');
});

test('falha mantém caminho recuperável e permite nova tentativa', async () => {
  const storageLocal = memoryLocal({
    [`${RELOCATION_PREFIX}42`]: activeRecord({ mediaKind: 'hls', displayName: 'aula.ts' }),
  });
  const downloads = fakeDownloads([{
    id: 42,
    state: 'complete',
    filename: String.raw`C:\Downloads\Video Radar\.staging\op_1\aula.ts`,
  }]);
  let fail = true;
  const nativeClient = fakeNative((_type, payload) => {
    if (fail) throw new Error('controlled move failure');
    return {
      type: 'fileMoved',
      requestId: 'move-2',
      downloadId: payload.downloadId,
      finalPath: String.raw`D:\Vídeos\aula.ts`,
    };
  });
  const coordinator = createDownloadRelocationCoordinator({
    storageLocal,
    downloads,
    nativeClient,
    now: () => 30,
  });

  await coordinator.handleChanged({ id: 42, state: { current: 'complete' } });
  const failed = await coordinator.get(42);
  assert.equal(failed.status, 'moveFailed');
  assert.match(failed.stagingPath, /Video Radar.+[.]staging.+aula[.]ts/);
  assert.equal(failed.errorCode, 'DESTINATION_MOVE_FAILED');

  fail = false;
  await coordinator.deliver(42);
  assert.equal((await coordinator.get(42)).status, 'complete');
  assert.equal(nativeClient.requests.length, 2);
});
