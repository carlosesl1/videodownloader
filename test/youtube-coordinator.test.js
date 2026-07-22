import assert from 'node:assert/strict';
import test from 'node:test';

import { createYouTubeCoordinator } from '../src/background/youtube-coordinator.js';
import { HOST_COMMANDS, YOUTUBE_ACTIONS } from '../src/youtube/protocol.js';

const VIDEO_ID = 'jNQXAC9IVRw';
const CANONICAL_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
const JOB_FIELDS = [
  'jobId', 'videoId', 'title', 'url', 'height', 'format',
  'stage', 'percent', 'downloadedBytes', 'totalBytes', 'speedBytesPerSecond', 'etaSeconds',
  'path', 'error', 'updatedAt',
];
const CATALOG = Object.freeze({
  videoId: VIDEO_ID,
  title: 'Me at the zoo',
  durationSeconds: 19,
  qualities: Object.freeze([
    Object.freeze({ height: 1080, label: '1080p', container: 'mp4', combined: false }),
    Object.freeze({ height: 720, label: '720p', container: 'webm', combined: true }),
  ]),
});

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function memoryLocal(initial = {}, { beforeSet } = {}) {
  const values = clone(initial);
  const calls = { get: [], set: [], remove: [] };
  return {
    values,
    calls,
    async get(key) {
      calls.get.push(key);
      if (typeof key !== 'string') throw new Error('expected one storage.local key');
      return Object.hasOwn(values, key) ? { [key]: clone(values[key]) } : {};
    },
    async set(entries) {
      calls.set.push(clone(entries));
      assert.deepEqual(Object.keys(entries), ['youtubeJob']);
      assert.deepEqual(Object.keys(entries.youtubeJob), JOB_FIELDS);
      await beforeSet?.(entries.youtubeJob, calls.set.length);
      values.youtubeJob = clone(entries.youtubeJob);
    },
    async remove(key) {
      calls.remove.push(key);
      delete values[key];
    },
  };
}

function formatsEvent(requestId = 'formats-1') {
  return { type: 'formats', requestId, ...clone(CATALOG) };
}

function startedEvent(jobId = 'job-1', requestId = 'start-1') {
  return {
    type: 'jobStarted', requestId, jobId,
    job: {
      jobId, videoId: '', title: '', height: 720, stage: 'preparing',
      percent: null, path: null, errorCode: null,
    },
  };
}

function message(action, payload) {
  return { target: 'background', action, payload };
}

function progress(jobId, stage, percent, overrides = {}) {
  return {
    type: 'jobProgress', requestId: `progress-${stage}`, jobId, stage, percent,
    ...overrides,
  };
}

function persistedJob(overrides = {}) {
  return {
    jobId: 'job-1', videoId: VIDEO_ID, title: CATALOG.title, url: CANONICAL_URL,
    height: 720, format: clone(CATALOG.qualities[1]),
    stage: 'preparing', percent: null,
    downloadedBytes: null, totalBytes: null, speedBytesPerSecond: null, etaSeconds: null,
    path: null, error: null, updatedAt: 100,
    ...overrides,
  };
}

function createEnv({ initial, request, localOptions } = {}) {
  const storageLocal = memoryLocal(initial, localOptions);
  const requests = [];
  const notificationCalls = [];
  let tick = 1_000;
  const nativeClient = {
    async request(type, payload) {
      requests.push({ type, payload: clone(payload) });
      if (request) return request(type, payload, requests.length);
      if (type === HOST_COMMANDS.LIST_FORMATS) return formatsEvent();
      if (type === HOST_COMMANDS.START_DOWNLOAD) return startedEvent();
      if (type === HOST_COMMANDS.CANCEL_DOWNLOAD) return { requested: true, requestId: 'cancel-1' };
      if (type === HOST_COMMANDS.GET_JOB) return { type: 'ready', requestId: 'get-1', job: null };
      throw new Error(`unexpected command ${type}`);
    },
  };
  const notifications = {
    async create(id, options) { notificationCalls.push({ id, options: clone(options) }); },
  };
  const coordinator = createYouTubeCoordinator({
    nativeClient, storageLocal, notifications, now: () => tick++,
  });
  return { coordinator, storageLocal, requests, notificationCalls };
}

async function start(env, url = `https://youtu.be/${VIDEO_ID}`) {
  await env.coordinator.ready;
  return env.coordinator.handle(message(YOUTUBE_ACTIONS.START_DOWNLOAD, { url, height: 720 }));
}

test('lista formatos sem persistir e reutiliza o catálogo em memória ao iniciar', async () => {
  const env = createEnv();
  await env.coordinator.ready;

  assert.deepEqual(
    await env.coordinator.handle(message(YOUTUBE_ACTIONS.LIST_FORMATS, {
      url: `https://youtu.be/${VIDEO_ID}?t=3`,
    })),
    CATALOG,
  );
  assert.deepEqual(env.requests, [{
    type: HOST_COMMANDS.LIST_FORMATS,
    payload: { url: CANONICAL_URL },
  }]);
  assert.equal(env.storageLocal.calls.set.length, 0);
  assert.equal(Object.hasOwn(env.storageLocal.values, 'youtubeJob'), false);

  const snapshot = await env.coordinator.handle(message(YOUTUBE_ACTIONS.START_DOWNLOAD, {
    url: `https://youtube.com/watch?v=${VIDEO_ID}`,
    height: 720,
  }));
  assert.equal(env.requests.filter(({ type }) => type === HOST_COMMANDS.LIST_FORMATS).length, 1);
  assert.deepEqual(env.requests.at(-1), {
    type: HOST_COMMANDS.START_DOWNLOAD,
    payload: { url: CANONICAL_URL, height: 720 },
  });
  assert.deepEqual(snapshot, persistedJob({ updatedAt: 1_000 }));
  assert.deepEqual(env.storageLocal.values.youtubeJob, snapshot);
  assert.deepEqual(Object.keys(env.coordinator), ['ready', 'handle', 'handleHostEvent']);
  assert.equal(Object.isFrozen(env.coordinator), true);
});

test('valida payload/altura, busca catálogo ausente e só resolve start após persistir', async () => {
  let releaseWrite;
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  const env = createEnv({ localOptions: { beforeSet: () => writeGate } });
  await env.coordinator.ready;

  for (const payload of [
    { url: 'https://example.test/video', height: 720 },
    { url: CANONICAL_URL, height: 143 },
    { url: CANONICAL_URL, height: 720, title: 'untrusted' },
  ]) {
    await assert.rejects(
      env.coordinator.handle(message(YOUTUBE_ACTIONS.START_DOWNLOAD, payload)),
      /inválida/i,
    );
  }
  await assert.rejects(
    env.coordinator.handle(message(YOUTUBE_ACTIONS.START_DOWNLOAD, { url: CANONICAL_URL, height: 480 })),
    /qualidade|inválida/i,
  );

  let settled = false;
  const pending = env.coordinator.handle(message(YOUTUBE_ACTIONS.START_DOWNLOAD, {
    url: CANONICAL_URL, height: 720,
  })).then((value) => { settled = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(env.requests.slice(-2), [
    { type: HOST_COMMANDS.LIST_FORMATS, payload: { url: CANONICAL_URL } },
    { type: HOST_COMMANDS.START_DOWNLOAD, payload: { url: CANONICAL_URL, height: 720 } },
  ]);
  releaseWrite();
  assert.deepEqual(await pending, env.storageLocal.values.youtubeJob);
});

test('serializa eventos e mantém estágio/progresso monotônicos', async () => {
  let blockNextWrite = false;
  let releaseWrite;
  let writeStarted;
  const writeStartedPromise = new Promise((resolve) => { writeStarted = resolve; });
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  const env = createEnv({
    localOptions: {
      async beforeSet(_snapshot, callNumber) {
        if (blockNextWrite && callNumber === 2) {
          writeStarted();
          await writeGate;
        }
      },
    },
  });
  await start(env);

  blockNextWrite = true;
  const advancing = env.coordinator.handleHostEvent(progress('job-1', 'video', 70, {
    downloadedBytes: 700, totalBytes: 1_000, speedBytesPerSecond: 50, etaSeconds: 6,
  }));
  await writeStartedPromise;
  const stale = env.coordinator.handleHostEvent(progress('job-1', 'preparing', 99));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(env.storageLocal.calls.set.length, 2);
  releaseWrite();
  await Promise.all([advancing, stale]);
  assert.equal(env.storageLocal.values.youtubeJob.stage, 'video');
  assert.equal(env.storageLocal.values.youtubeJob.percent, 70);

  await env.coordinator.handleHostEvent(progress('job-1', 'video', 60, { downloadedBytes: 600 }));
  assert.equal(env.storageLocal.values.youtubeJob.percent, 70);
  assert.equal(env.storageLocal.values.youtubeJob.downloadedBytes, 700);

  await env.coordinator.handleHostEvent(progress('job-1', 'audio', null));
  assert.equal(env.storageLocal.values.youtubeJob.stage, 'audio');
  assert.equal(env.storageLocal.values.youtubeJob.percent, null);
  assert.equal(env.storageLocal.values.youtubeJob.downloadedBytes, null);
  await env.coordinator.handleHostEvent(progress('job-1', 'audio', 30));
  await env.coordinator.handleHostEvent(progress('job-1', 'audio', 20));
  assert.equal(env.storageLocal.values.youtubeJob.percent, 30);
  await env.coordinator.handleHostEvent(progress('job-1', 'merge', 5));
  assert.equal(env.storageLocal.values.youtubeJob.stage, 'merge');
  assert.equal(env.storageLocal.values.youtubeJob.percent, 5);
});

test('persiste conclusão e envia uma única notificação sem expor caminho', async () => {
  const originalChrome = globalThis.chrome;
  globalThis.chrome = { runtime: { getURL: (path) => `chrome-extension://test/${path}` } };
  try {
    const env = createEnv();
    await start(env);
    const completed = {
      type: 'jobCompleted', requestId: 'start-1', jobId: 'job-1',
      path: 'C:/Users/Test/Downloads/video.mp4',
    };
    await Promise.all([
      env.coordinator.handleHostEvent(completed),
      env.coordinator.handleHostEvent(completed),
    ]);

    assert.equal(env.storageLocal.values.youtubeJob.stage, 'complete');
    assert.equal(env.storageLocal.values.youtubeJob.percent, 100);
    assert.equal(env.storageLocal.values.youtubeJob.path, completed.path);
    assert.deepEqual(env.notificationCalls, [{
      id: 'youtube-job-job-1',
      options: {
        type: 'basic',
        iconUrl: 'chrome-extension://test/assets/icon-128.png',
        title: 'Vídeo Radar',
        message: 'Download concluído',
      },
    }]);
    assert.equal(JSON.stringify(env.notificationCalls).includes(completed.path), false);
  } finally {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
  }
});

test('deduplica cancelamento e só o evento correlacionado altera o snapshot', async () => {
  const env = createEnv();
  await start(env);
  const before = clone(env.storageLocal.values.youtubeJob);

  assert.deepEqual(await env.coordinator.handle(message(YOUTUBE_ACTIONS.CANCEL_DOWNLOAD, {
    jobId: 'job-1',
  })), { requested: true });
  assert.deepEqual(await env.coordinator.handle(message(YOUTUBE_ACTIONS.CANCEL_DOWNLOAD, {
    jobId: 'job-1',
  })), { requested: true });
  assert.equal(env.requests.filter(({ type }) => type === HOST_COMMANDS.CANCEL_DOWNLOAD).length, 1);
  assert.deepEqual(env.storageLocal.values.youtubeJob, before);

  await env.coordinator.handleHostEvent({
    type: 'jobCancelled', requestId: 'start-1', jobId: 'other-job',
  });
  assert.deepEqual(env.storageLocal.values.youtubeJob, before);
  await env.coordinator.handleHostEvent({
    type: 'jobCancelled', requestId: 'start-1', jobId: 'job-1',
  });
  assert.equal(env.storageLocal.values.youtubeJob.stage, 'cancelled');
  assert.equal(env.storageLocal.values.youtubeJob.error, null);
});

test('ignora jobId divergente, salva falha segura e interrompe somente job ativo no disconnect', async () => {
  const env = createEnv();
  await start(env);
  const writes = env.storageLocal.calls.set.length;
  await env.coordinator.handleHostEvent(progress('other-job', 'video', 50));
  await env.coordinator.handleHostEvent({
    type: 'jobFailed', requestId: 'old-start', jobId: 'other-job',
    code: 'HOST_ERROR', message: 'não publicar detalhes', details: {},
  });
  assert.equal(env.storageLocal.calls.set.length, writes);

  await env.coordinator.handleHostEvent({
    type: 'jobFailed', requestId: 'old-start', jobId: 'job-1',
    code: 'HOST_ERROR', message: 'não publicar detalhes', details: { path: 'secret' },
  });
  assert.equal(env.storageLocal.values.youtubeJob.stage, 'failed');
  assert.equal(env.storageLocal.values.youtubeJob.error, 'HOST_ERROR');
  assert.equal(JSON.stringify(env.storageLocal.values.youtubeJob).includes('secret'), false);
  const terminal = clone(env.storageLocal.values.youtubeJob);
  await env.coordinator.handleHostEvent({ type: 'nativeDisconnected' });
  assert.deepEqual(env.storageLocal.values.youtubeJob, terminal);

  const active = createEnv();
  await start(active);
  await active.coordinator.handleHostEvent({ type: 'nativeDisconnected' });
  assert.equal(active.storageLocal.values.youtubeJob.stage, 'interrupted');
  assert.equal(active.storageLocal.values.youtubeJob.error, 'NATIVE_DISCONNECTED');
});

test('recriação consulta GET_JOB para ativo e reconcilia host nulo ou válido', async () => {
  const missing = createEnv({ initial: { youtubeJob: persistedJob() } });
  await missing.coordinator.ready;
  assert.deepEqual(missing.storageLocal.calls.get, ['youtubeJob']);
  assert.deepEqual(missing.requests, [{ type: HOST_COMMANDS.GET_JOB, payload: {} }]);
  assert.equal(missing.storageLocal.values.youtubeJob.stage, 'interrupted');
  assert.equal(missing.storageLocal.values.youtubeJob.error, 'NATIVE_JOB_MISSING');

  const reconciled = createEnv({
    initial: { youtubeJob: persistedJob({ percent: 10 }) },
    request(type) {
      assert.equal(type, HOST_COMMANDS.GET_JOB);
      return {
        type: 'ready', requestId: 'get-1',
        job: {
          jobId: 'job-1', videoId: VIDEO_ID, title: CATALOG.title,
          height: 720, stage: 'video', percent: 42, path: null, errorCode: null,
        },
      };
    },
  });
  await reconciled.coordinator.ready;
  assert.deepEqual(reconciled.storageLocal.values.youtubeJob, persistedJob({
    stage: 'video', percent: 42, updatedAt: 1_000,
  }));
});

test('mantém terminal sem conectar e remove storage corrompido com segurança', async () => {
  const terminal = persistedJob({ stage: 'complete', percent: 100, path: 'C:/Downloads/video.mp4' });
  const existing = createEnv({ initial: { youtubeJob: terminal } });
  await existing.coordinator.ready;
  assert.deepEqual(existing.requests, []);
  assert.deepEqual(existing.storageLocal.calls.set, []);
  assert.deepEqual(
    await existing.coordinator.handle(message(YOUTUBE_ACTIONS.GET_JOB, {})),
    terminal,
  );
  await assert.rejects(
    existing.coordinator.handle(message(YOUTUBE_ACTIONS.GET_JOB, { extra: true })),
    /inválida/i,
  );

  const corrupted = createEnv({ initial: { youtubeJob: { stage: 'video', path: 'x'.repeat(2_000) } } });
  await corrupted.coordinator.ready;
  assert.deepEqual(corrupted.storageLocal.calls.get, ['youtubeJob']);
  assert.deepEqual(corrupted.storageLocal.calls.remove, ['youtubeJob']);
  assert.equal(await corrupted.coordinator.handle(message(YOUTUBE_ACTIONS.GET_JOB, {})), null);
  assert.deepEqual(corrupted.requests, []);
});
