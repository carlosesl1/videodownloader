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
  const calls = { get: [], set: [], remove: [] };
  return {
    values,
    calls,
    async get(keys) {
      calls.get.push(structuredClone(keys));
      if (keys === null) return structuredClone(values);
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(
        requested.filter((key) => Object.hasOwn(values, key))
          .map((key) => [key, structuredClone(values[key])]),
      );
    },
    async set(entries) {
      calls.set.push(structuredClone(entries));
      Object.assign(values, structuredClone(entries));
    },
    async remove(keys) {
      calls.remove.push(structuredClone(keys));
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
  assert.deepEqual(storageLocal.values.downloadRelocationIndex, []);
  assert.deepEqual(storageLocal.values.downloadDeliveryResultIndex, [42]);
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

test('migra registros legados uma vez e repara índices de relocações ausentes', async () => {
  const storageLocal = memoryLocal({
    [`${RELOCATION_PREFIX}42`]: activeRecord(),
    [`${DELIVERY_RESULT_PREFIX}7`]: activeRecord({
      downloadId: 7,
      operationId: 'op_7',
      status: 'complete',
      finalPath: String.raw`D:\Vídeos\antigo.mp4`,
    }),
  });
  const downloads = fakeDownloads([]);
  const nativeClient = fakeNative(() => { throw new Error('não deve mover'); });

  await createDownloadRelocationCoordinator({
    storageLocal, downloads, nativeClient, now: () => 20,
  }).reconcile();
  assert.deepEqual(storageLocal.values.downloadRelocationIndex, [42]);
  assert.deepEqual(storageLocal.values.downloadDeliveryResultIndex, [7]);
  assert.equal(storageLocal.values.downloadRelocationIndexMigration, 1);
  const scansAfterMigration = storageLocal.calls.get.filter((keys) => keys === null).length;

  await createDownloadRelocationCoordinator({
    storageLocal, downloads, nativeClient, now: () => 20,
  }).reconcile();
  assert.equal(storageLocal.calls.get.filter((keys) => keys === null).length, scansAfterMigration);

  storageLocal.values.downloadRelocationIndex = [999, 42];
  await createDownloadRelocationCoordinator({
    storageLocal, downloads, nativeClient, now: () => 20,
  }).reconcile();
  assert.deepEqual(storageLocal.values.downloadRelocationIndex, [42]);
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
