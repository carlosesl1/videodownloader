import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DELIVERY_RESULT_PREFIX,
  RELOCATION_PREFIX,
  createDownloadRelocationCoordinator,
} from '../src/background/download-relocation.js';
import { HOST_COMMANDS } from '../src/youtube/protocol.js';
import { RELOCATION_INTENT_INDEX } from '../src/shared/persistence-keys.js';

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
    async search(query) {
      if (Number.isSafeInteger(query?.id)) {
        return structuredClone(items.filter((item) => item.id === query.id));
      }
      if (typeof query?.url === 'string') {
        const after = Date.parse(query.startedAfter);
        return structuredClone(items.filter((item) => item.url === query.url
          && Date.parse(item.startTime) >= after));
      }
      if (typeof query?.filenameRegex === 'string') {
        const after = Date.parse(query.startedAfter);
        const pattern = new RegExp(query.filenameRegex);
        return structuredClone(items.filter((item) => pattern.test(item.filename ?? '')
          && Date.parse(item.startTime) >= after));
      }
      return [];
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
    operationId: payload.operationId,
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
      operationId: 'op_1',
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
      operationId: payload.operationId,
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
      operationId: payload.operationId,
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

test('acompanha Save As até conclusão sem abrir o host nativo', async () => {
  const storageLocal = memoryLocal();
  const downloads = fakeDownloads([{
    id: 51,
    url: 'https://cdn.test/aula.mp4',
    state: 'complete',
    filename: String.raw`C:\Users\Carlos\Videos\aula.mp4`,
  }]);
  const nativeClient = fakeNative(() => { throw new Error('não deve mover'); });
  const coordinator = createDownloadRelocationCoordinator({
    storageLocal, downloads, nativeClient, now: () => 50,
  });

  await coordinator.createIntent({
    downloadId: null,
    operationId: 'direct_51',
    destinationFolder: null,
    mediaKind: 'direct',
    mediaUrl: 'https://cdn.test/aula.mp4',
    displayName: 'aula.mp4',
  });
  await coordinator.bindIntent('direct_51', 51);
  await coordinator.handleChanged({ id: 51, state: { current: 'complete' } });

  const completed = await coordinator.get(51);
  assert.equal(completed.status, 'complete');
  assert.equal(completed.finalPath, String.raw`C:\Users\Carlos\Videos\aula.mp4`);
  assert.equal(completed.destinationFolder, null);
  assert.deepEqual(nativeClient.requests, []);
});

test('recupera a intenção direta se o worker cair entre download e vínculo', async () => {
  const createdAt = Date.parse('2026-08-12T12:00:00.000Z');
  const operationId = 'direct_crash';
  const intentStorageKey = `${RELOCATION_PREFIX}intent:${operationId}`;
  const storageLocal = memoryLocal({
    [RELOCATION_INTENT_INDEX]: [operationId],
    [intentStorageKey]: {
      operationId,
      downloadId: null,
      destinationFolder: null,
      mediaKind: 'direct',
      mediaUrl: 'https://cdn.test/crash.mp4',
      displayName: 'crash.mp4',
      status: 'starting',
      stagingPath: null,
      finalPath: null,
      errorCode: null,
      updatedAt: createdAt,
    },
  });
  const downloads = fakeDownloads([{
    id: 77,
    url: 'https://cdn.test/crash.mp4',
    startTime: '2026-08-12T12:00:01.000Z',
    state: 'complete',
    filename: String.raw`C:\Downloads\crash.mp4`,
  }]);
  const nativeClient = fakeNative(() => { throw new Error('não deve mover'); });
  const coordinator = createDownloadRelocationCoordinator({
    storageLocal, downloads, nativeClient, now: () => createdAt + 2_000,
  });

  await coordinator.reconcile();

  assert.equal((await coordinator.get(77)).status, 'complete');
  assert.equal(Object.hasOwn(storageLocal.values, intentStorageKey), false);
  assert.deepEqual(storageLocal.values[RELOCATION_INTENT_INDEX], []);
  assert.deepEqual(nativeClient.requests, []);
});

test('não captura download externo quando a recuperação direta é ambígua', async () => {
  const createdAt = Date.parse('2026-08-12T12:00:00.000Z');
  const operationId = 'direct_ambiguous';
  const intentStorageKey = `${RELOCATION_PREFIX}intent:${operationId}`;
  const intent = {
    operationId,
    downloadId: null,
    destinationFolder: null,
    mediaKind: 'direct',
    mediaUrl: 'https://cdn.test/same.mp4',
    displayName: 'same.mp4',
    status: 'starting',
    stagingPath: null,
    finalPath: null,
    errorCode: null,
    updatedAt: createdAt,
  };
  const storageLocal = memoryLocal({
    [RELOCATION_INTENT_INDEX]: [operationId],
    [intentStorageKey]: intent,
  });
  const downloads = fakeDownloads([
    { id: 77, url: intent.mediaUrl, startTime: '2026-08-12T12:00:01.000Z', state: 'complete', filename: String.raw`C:\Downloads\one.mp4` },
    { id: 78, url: intent.mediaUrl, startTime: '2026-08-12T12:00:02.000Z', state: 'complete', filename: String.raw`C:\Downloads\external.mp4` },
  ]);
  const coordinator = createDownloadRelocationCoordinator({
    storageLocal,
    downloads,
    nativeClient: fakeNative(() => { throw new Error('não deve mover'); }),
    now: () => createdAt + 3_000,
  });

  await coordinator.reconcile();

  assert.deepEqual(storageLocal.values[intentStorageKey], intent);
  assert.equal(await coordinator.get(77), null);
  assert.equal(await coordinator.get(78), null);
});

test('mantém pareamento de intenção e download estritamente um-para-um', async () => {
  const storageLocal = memoryLocal();
  const coordinator = createDownloadRelocationCoordinator({
    storageLocal,
    downloads: fakeDownloads([]),
    nativeClient: fakeNative(() => { throw new Error('não deve mover'); }),
    now: () => 100,
  });
  for (const operationId of ['first', 'second']) {
    await coordinator.createIntent({
      downloadId: null,
      operationId,
      destinationFolder: null,
      mediaKind: 'direct',
      mediaUrl: `https://cdn.test/${operationId}.mp4`,
      displayName: `${operationId}.mp4`,
    });
  }
  await coordinator.bindIntent('first', 42);
  await assert.rejects(coordinator.bindIntent('second', 42), /já vinculada/);
  assert.equal((await coordinator.get(42)).operationId, 'first');
  assert.equal(Object.hasOwn(storageLocal.values, `${RELOCATION_PREFIX}intent:second`), true);
});

test('recupera e entrega intenção HLS pelo operationId após completion antecipado', async () => {
  const operationId = 'hls_crash';
  const storageLocal = memoryLocal();
  const downloads = fakeDownloads([{
    id: 91,
    url: `blob:extension.test/${operationId}`,
    state: 'complete',
    filename: String.raw`C:\Downloads\Video Radar\.staging\hls_crash\aula.ts`,
  }]);
  const nativeClient = fakeNative((_type, payload) => ({
    type: 'fileMoved',
    requestId: 'move-hls',
    operationId: payload.operationId,
    downloadId: payload.downloadId,
    finalPath: String.raw`D:\Vídeos\aula.ts`,
  }));
  const coordinator = createDownloadRelocationCoordinator({
    storageLocal, downloads, nativeClient, now: () => 200,
  });
  await coordinator.createIntent({
    downloadId: null,
    operationId,
    destinationFolder: String.raw`D:\Vídeos`,
    mediaKind: 'hls',
    mediaUrl: 'https://cdn.test/aula.m3u8',
    displayName: 'aula.ts',
  });

  assert.equal(await coordinator.recoverIntent(operationId, 91), true);
  assert.equal((await coordinator.get(91)).status, 'complete');
  assert.equal((await coordinator.get(91)).finalPath, String.raw`D:\Vídeos\aula.ts`);
  assert.equal(Object.hasOwn(storageLocal.values, `${RELOCATION_PREFIX}intent:${operationId}`), false);
  assert.equal(nativeClient.requests.length, 1);
});

test('reconcile recupera intenção HLS pela pasta de staging unívoca sem novo download', async () => {
  const createdAt = Date.parse('2026-08-12T12:00:00.000Z');
  const operationId = 'hls_restart';
  const intentStorageKey = `${RELOCATION_PREFIX}intent:${operationId}`;
  const storageLocal = memoryLocal({
    [RELOCATION_INTENT_INDEX]: [operationId],
    [intentStorageKey]: {
      operationId,
      downloadId: null,
      destinationFolder: String.raw`D:\Vídeos`,
      mediaKind: 'hls',
      mediaUrl: 'https://cdn.test/aula.m3u8',
      displayName: 'aula.ts',
      status: 'starting',
      stagingPath: null,
      finalPath: null,
      errorCode: null,
      updatedAt: createdAt,
    },
  });
  const downloads = fakeDownloads([{
    id: 92,
    url: `blob:extension.test/${operationId}`,
    startTime: '2026-08-12T12:00:01.000Z',
    state: 'complete',
    filename: String.raw`C:\Downloads\Video Radar\.staging\hls_restart\aula.ts`,
  }]);
  const nativeClient = fakeNative((_type, payload) => ({
    type: 'fileMoved',
    requestId: 'move-hls-restart',
    operationId: payload.operationId,
    downloadId: payload.downloadId,
    finalPath: String.raw`D:\Vídeos\aula.ts`,
  }));
  const coordinator = createDownloadRelocationCoordinator({
    storageLocal, downloads, nativeClient, now: () => createdAt + 2_000,
  });

  await coordinator.reconcile();

  assert.equal((await coordinator.get(92)).status, 'complete');
  assert.equal(Object.hasOwn(storageLocal.values, intentStorageKey), false);
  assert.equal(nativeClient.requests.length, 1);
});

test('persiste interrupção do navegador com o caminho parcial disponível', async () => {
  const storageLocal = memoryLocal();
  const downloads = fakeDownloads([{
    id: 81,
    state: 'interrupted',
    filename: String.raw`C:\Downloads\aula.mp4.crdownload`,
  }]);
  const coordinator = createDownloadRelocationCoordinator({
    storageLocal,
    downloads,
    nativeClient: fakeNative(() => { throw new Error('não deve mover'); }),
    now: () => 80,
  });
  await coordinator.track(activeRecord({ downloadId: 81 }));

  await coordinator.handleChanged({ id: 81, state: { current: 'interrupted' } });

  const interrupted = await coordinator.get(81);
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.errorCode, 'BROWSER_DOWNLOAD_INTERRUPTED');
  assert.equal(interrupted.stagingPath, String.raw`C:\Downloads\aula.mp4.crdownload`);
});
