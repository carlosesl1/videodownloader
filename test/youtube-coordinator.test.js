import assert from 'node:assert/strict';
import test from 'node:test';

import { createYouTubeCoordinator } from '../src/background/youtube-coordinator.js';
import { HOST_COMMANDS, YOUTUBE_ACTIONS } from '../src/youtube/protocol.js';

const VIDEO_ID = 'jNQXAC9IVRw';
const CANONICAL_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
const JOB_FIELDS = [
  'jobId', 'operationId', 'videoId', 'title', 'url', 'height', 'format',
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
const RICH_CATALOG = Object.freeze({
  ...CATALOG,
  formats: Object.freeze([Object.freeze({
    formatId: '140', height: null, container: 'm4a', combined: false,
    audioOnly: true, fps: null, hdr: false, dynamicRange: null,
    videoCodec: null, audioCodec: 'mp4a.40.2', bitrateKbps: 128,
    fileSizeBytes: 1_000_000, fileSizeApproximate: false, language: 'pt-BR',
  })]),
  subtitles: Object.freeze([Object.freeze({
    language: 'pt-BR', label: 'Português', automatic: false,
    containers: Object.freeze(['vtt']),
  })]),
  audioLanguages: Object.freeze(['pt-BR']),
});

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function memoryLocal(initial = {}, { beforeSet } = {}) {
  const values = clone(initial);
  const calls = { get: [], set: [], remove: [] };
  let youtubeWriteCount = 0;
  return {
    values,
    calls,
    async get(key) {
      calls.get.push(clone(key));
      const keys = Array.isArray(key) ? key : [key];
      return Object.fromEntries(keys.filter((name) => Object.hasOwn(values, name))
        .map((name) => [name, clone(values[name])]));
    },
    async set(entries) {
      calls.set.push(clone(entries));
      const keys = Object.keys(entries);
      if (keys.length === 1 && keys[0] === 'youtubeJob') {
        assert.deepEqual(Object.keys(entries.youtubeJob), JOB_FIELDS);
        youtubeWriteCount += 1;
        await beforeSet?.(entries.youtubeJob, youtubeWriteCount);
      }
      Object.assign(values, clone(entries));
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
      jobId, operationId: 'media-test', videoId: '', title: '', height: 720, stage: 'preparing',
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
    jobId: 'job-1', operationId: null, videoId: VIDEO_ID, title: CATALOG.title, url: CANONICAL_URL,
    height: 720, format: clone(CATALOG.qualities[1]),
    stage: 'preparing', percent: null,
    downloadedBytes: null, totalBytes: null, speedBytesPerSecond: null, etaSeconds: null,
    path: null, error: null, updatedAt: 100,
    ...overrides,
  };
}

function createEnv({
  initial,
  request,
  localOptions,
  createStartOperationId = () => 'media-test',
  preferences = {
    schemaVersion: 2,
    askEveryTime: false,
    defaultFolder: String.raw`C:\Downloads\Video Radar`,
  },
  onQueueEvent = () => {},
} = {}) {
  const storageLocal = memoryLocal({ downloadPreferences: preferences, ...initial }, localOptions);
  const requests = [];
  const notificationCalls = [];
  const keepAliveCalls = [];
  let tick = 1_000;
  const nativeClient = {
    setKeepAlive(reason, active) {
      keepAliveCalls.push({ reason, active });
    },
    async request(type, payload) {
      requests.push({ type, payload: clone(payload) });
      if (request) return request(type, payload, requests.length);
      if (type === HOST_COMMANDS.LIST_FORMATS) return formatsEvent();
      if (type === HOST_COMMANDS.START_DOWNLOAD) return startedEvent();
      if (type === HOST_COMMANDS.CANCEL_DOWNLOAD) {
        return { type: 'jobCancelled', requestId: 'cancel-1', jobId: payload.jobId };
      }
      if (type === HOST_COMMANDS.REVEAL_DOWNLOADED_FILE) {
        return { type: 'fileRevealed', requestId: 'reveal-1' };
      }
      if (type === HOST_COMMANDS.GET_JOB) return { type: 'ready', requestId: 'get-1', job: null };
      throw new Error(`unexpected command ${type}`);
    },
  };
  const notifications = {
    async create(id, options) { notificationCalls.push({ id, options: clone(options) }); },
  };
  const coordinator = createYouTubeCoordinator({
    nativeClient, storageLocal, notifications, now: () => tick++,
    createStartOperationId, onQueueEvent,
  });
  return { coordinator, storageLocal, requests, notificationCalls, keepAliveCalls };
}

function queuedEvent({ operationId, jobId, selection, position, media = null }) {
  const job = {
    jobId,
    operationId,
    url: CANONICAL_URL,
    selection: clone(selection),
    destinationFolder: String.raw`C:\Downloads\Video Radar`,
    state: 'queued',
    videoId: media?.videoId ?? '',
    title: media?.title ?? '',
    stage: 'queued',
    percent: null,
    downloadedBytes: null,
    totalBytes: null,
    speedBytesPerSecond: null,
    etaSeconds: null,
    path: null,
    errorCode: null,
    resumePartial: false,
    attemptCount: 0,
    position,
    createdAt: '2026-08-12T12:00:00Z',
    updatedAt: '2026-08-12T12:00:00Z',
  };
  return {
    type: 'jobQueued', requestId: `start-${position}`, jobId, operationId,
    replayed: false, position, job,
  };
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
    payload: {
      operationId: 'media-test',
      url: CANONICAL_URL,
      height: 720,
      destinationFolder: String.raw`C:\Downloads\Video Radar`,
    },
  });
  assert.deepEqual(snapshot, persistedJob({ operationId: 'media-test', updatedAt: 1_003 }));
  assert.deepEqual(env.storageLocal.values.youtubeJob, snapshot);
  assert.deepEqual(Object.keys(env.coordinator), ['ready', 'handle', 'handleHostEvent']);
  assert.equal(Object.isFrozen(env.coordinator), true);
});

test('v5 enfileira seleções ricas consecutivas, incluindo áudio, sem bloqueio de job único', async () => {
  const operations = ['media-rich-video', 'media-rich-audio'];
  const observed = [];
  const env = createEnv({
    createStartOperationId: () => operations.shift(),
    onQueueEvent: (event) => observed.push(clone(event)),
    request(type, payload) {
      if (type === HOST_COMMANDS.LIST_FORMATS) {
        return { type: 'formats', requestId: 'rich-formats', ...clone(RICH_CATALOG) };
      }
      if (type === HOST_COMMANDS.START_DOWNLOAD) {
        const suffix = payload.selection.audioOnly ? 'audio' : 'video';
        return queuedEvent({
          operationId: payload.operationId,
          jobId: `job-${suffix}`,
          selection: payload.selection,
          position: suffix === 'video' ? 1 : 2,
          media: payload.media,
        });
      }
      throw new Error(`unexpected command ${type}`);
    },
  });
  await env.coordinator.ready;
  await env.coordinator.handle(message(YOUTUBE_ACTIONS.LIST_FORMATS, { url: CANONICAL_URL }));

  const videoSelection = {
    height: 720, audioOnly: false, subtitleLanguage: 'pt-BR',
    includeAutomaticSubtitles: false,
  };
  const audioSelection = {
    height: null, audioOnly: true, subtitleLanguage: null,
    includeAutomaticSubtitles: false,
  };
  const video = await env.coordinator.handle(message(YOUTUBE_ACTIONS.START_DOWNLOAD, {
    url: CANONICAL_URL, selection: videoSelection,
  }));
  const audio = await env.coordinator.handle(message(YOUTUBE_ACTIONS.START_DOWNLOAD, {
    url: CANONICAL_URL, selection: audioSelection,
  }));

  assert.equal(video.stage, 'queued');
  assert.equal(video.height, 720);
  assert.equal(audio.stage, 'queued');
  assert.equal(audio.height, 0);
  assert.deepEqual(audio.format, {
    height: 0, label: 'Somente áudio', container: 'm4a', combined: false,
  });
  assert.deepEqual(
    env.requests.filter(({ type }) => type === HOST_COMMANDS.START_DOWNLOAD)
      .map(({ payload }) => payload),
    [
      {
        operationId: 'media-rich-video', url: CANONICAL_URL,
        selection: videoSelection,
        media: { videoId: VIDEO_ID, title: RICH_CATALOG.title },
        destinationFolder: String.raw`C:\Downloads\Video Radar`,
      },
      {
        operationId: 'media-rich-audio', url: CANONICAL_URL,
        selection: audioSelection,
        media: { videoId: VIDEO_ID, title: RICH_CATALOG.title },
        destinationFolder: String.raw`C:\Downloads\Video Radar`,
      },
    ],
  );
  assert.equal(observed.length, 2);
  assert.deepEqual(observed.map(({ job }) => [job.videoId, job.title]), [
    [VIDEO_ID, RICH_CATALOG.title],
    [VIDEO_ID, RICH_CATALOG.title],
  ]);
  assert.equal(Object.hasOwn(env.storageLocal.values, 'mediaStartIntent'), false);
});

test('lista formatos sociais allowlisted usando o mesmo coordenador persistente', async () => {
  const url = 'https://www.tiktok.com/@video.radar/video/7488298911734435077';
  const catalog = {
    platform: 'tiktok',
    videoId: '7488298911734435077',
    title: 'Public TikTok',
    durationSeconds: 12,
    qualities: [{ height: 720, label: '720p', container: 'mp4', combined: true }],
  };
  const env = createEnv({
    request(type) {
      if (type === HOST_COMMANDS.LIST_FORMATS) {
        return { type: 'formats', requestId: 'social-formats', ...catalog };
      }
      throw new Error(`unexpected command ${type}`);
    },
  });
  await env.coordinator.ready;

  assert.deepEqual(
    await env.coordinator.handle(message(YOUTUBE_ACTIONS.LIST_FORMATS, { url })),
    catalog,
  );
  assert.deepEqual(env.requests, [{
    type: HOST_COMMANDS.LIST_FORMATS,
    payload: { url },
  }]);
});

test('aceita no X um vídeo incorporado cujo ID difere do post allowlisted', async () => {
  const url = 'https://x.com/Reuters/status/2041474345386783199';
  const env = createEnv({
    request(type) {
      if (type === HOST_COMMANDS.LIST_FORMATS) {
        return {
          type: 'formats',
          requestId: 'x-formats',
          platform: 'x',
          videoId: '2041472949631483904',
          title: 'Reuters video',
          durationSeconds: 30,
          qualities: [{ height: 720, label: '720p', container: 'mp4', combined: true }],
        };
      }
      throw new Error(`unexpected command ${type}`);
    },
  });
  await env.coordinator.ready;

  const catalog = await env.coordinator.handle(message(YOUTUBE_ACTIONS.LIST_FORMATS, { url }));

  assert.equal(catalog.platform, 'x');
  assert.equal(catalog.videoId, '2041472949631483904');
});

test('manda o auxiliar selecionar no Explorer somente um caminho Windows absoluto', async () => {
  const env = createEnv();
  await env.coordinator.ready;

  assert.deepEqual(
    await env.coordinator.handle(message(YOUTUBE_ACTIONS.REVEAL_DOWNLOADED_FILE, {
      path: String.raw`C:\Users\Carlos\Downloads\Video Radar\aula.mp4`,
    })),
    { revealed: true },
  );
  assert.deepEqual(env.requests.at(-1), {
    type: HOST_COMMANDS.REVEAL_DOWNLOADED_FILE,
    payload: { path: String.raw`C:\Users\Carlos\Downloads\Video Radar\aula.mp4` },
  });

  for (const path of ['aula.mp4', 'C:/Downloads/aula.mp4', String.raw`C:\Downloads\..\Windows\aula.mp4`]) {
    await assert.rejects(
      env.coordinator.handle(message(YOUTUBE_ACTIONS.REVEAL_DOWNLOADED_FILE, { path })),
      /inválida/i,
    );
  }
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
    {
      type: HOST_COMMANDS.START_DOWNLOAD,
      payload: {
        operationId: 'media-test',
        url: CANONICAL_URL,
        height: 720,
        destinationFolder: String.raw`C:\Downloads\Video Radar`,
      },
    },
  ]);
  releaseWrite();
  assert.deepEqual(await pending, env.storageLocal.values.youtubeJob);
});

test('rejeita operationId não textual antes de persistir ou iniciar no host', async () => {
  const env = createEnv({ createStartOperationId: () => 42 });

  await assert.rejects(start(env), /inválida/i);

  assert.equal(
    env.requests.some(({ type }) => type === HOST_COMMANDS.START_DOWNLOAD),
    false,
  );
  assert.equal(Object.hasOwn(env.storageLocal.values, 'mediaStartIntent'), false);
});

test('preserva evento terminal quando o buffer pré-start atinge o limite', async () => {
  let signalStartRequest;
  const startRequested = new Promise((resolve) => { signalStartRequest = resolve; });
  let releaseStart;
  const startResponse = new Promise((resolve) => { releaseStart = resolve; });
  const env = createEnv({
    request(type) {
      if (type === HOST_COMMANDS.LIST_FORMATS) return formatsEvent();
      if (type === HOST_COMMANDS.START_DOWNLOAD) {
        signalStartRequest();
        return startResponse;
      }
      throw new Error(`unexpected command ${type}`);
    },
  });

  const pending = start(env);
  await startRequested;
  for (let percent = 0; percent < 64; percent += 1) {
    await env.coordinator.handleHostEvent(progress('job-1', 'video', percent));
  }
  await env.coordinator.handleHostEvent({
    type: 'jobCompleted', requestId: 'completed-before-start-response', jobId: 'job-1',
    path: 'C:\\Downloads\\video.mp4',
  });
  await env.coordinator.handleHostEvent({
    type: 'jobCancelled', requestId: 'stale-terminal', jobId: 'old-job',
  });
  await env.coordinator.handleHostEvent(progress('job-1', 'video', 99));
  releaseStart(startedEvent());

  const snapshot = await pending;
  assert.equal(snapshot.stage, 'complete');
  assert.equal(snapshot.percent, 100);
  assert.equal(snapshot.path, 'C:\\Downloads\\video.mp4');
  assert.equal(env.notificationCalls.length, 1);
});

test('youtube pergunta a pasta antes de iniciar', async () => {
  const env = createEnv({
    preferences: { schemaVersion: 2, askEveryTime: true, defaultFolder: null },
    request(type) {
      if (type === HOST_COMMANDS.LIST_FORMATS) return formatsEvent();
      if (type === HOST_COMMANDS.CHOOSE_DOWNLOAD_FOLDER) {
        return { type: 'folderSelected', requestId: 'folder-1', path: String.raw`D:\Aulas` };
      }
      if (type === HOST_COMMANDS.START_DOWNLOAD) return startedEvent();
      throw new Error(`unexpected command ${type}`);
    },
  });

  await start(env);

  assert.deepEqual(
    env.requests.filter(({ type }) => (
      type === HOST_COMMANDS.CHOOSE_DOWNLOAD_FOLDER
      || type === HOST_COMMANDS.START_DOWNLOAD
    )),
    [
      { type: HOST_COMMANDS.CHOOSE_DOWNLOAD_FOLDER, payload: {} },
      {
        type: HOST_COMMANDS.START_DOWNLOAD,
        payload: {
          operationId: 'media-test',
          url: CANONICAL_URL,
          height: 720,
          destinationFolder: String.raw`D:\Aulas`,
        },
      },
    ],
  );
});

test('youtube automático usa a pasta padrão', async () => {
  const env = createEnv({
    preferences: {
      schemaVersion: 2,
      askEveryTime: false,
      defaultFolder: String.raw`E:\Vídeos`,
    },
  });

  await start(env);

  assert.equal(
    env.requests.find(({ type }) => type === HOST_COMMANDS.START_DOWNLOAD)
      .payload.destinationFolder,
    String.raw`E:\Vídeos`,
  );
  assert.equal(
    env.requests.some(({ type }) => type === HOST_COMMANDS.CHOOSE_DOWNLOAD_FOLDER),
    false,
  );
});

test('cancelar seletor não inicia youtube', async () => {
  const env = createEnv({
    preferences: { schemaVersion: 2, askEveryTime: true, defaultFolder: null },
    request(type) {
      if (type === HOST_COMMANDS.LIST_FORMATS) return formatsEvent();
      if (type === HOST_COMMANDS.CHOOSE_DOWNLOAD_FOLDER) {
        return { type: 'folderSelectionCancelled', requestId: 'folder-1' };
      }
      throw new Error(`unexpected command ${type}`);
    },
  });

  assert.deepEqual(await start(env), {
    cancelled: true,
    code: 'DOWNLOAD_CANCELLED',
  });
  assert.equal(
    env.requests.some(({ type }) => type === HOST_COMMANDS.START_DOWNLOAD),
    false,
  );
  assert.equal(env.storageLocal.calls.set.filter((entry) => Object.hasOwn(entry, 'youtubeJob')).length, 0);
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
  assert.equal(
    env.storageLocal.calls.set.filter((entry) => Object.hasOwn(entry, 'youtubeJob')).length,
    2,
  );
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
      path: 'C:\\Users\\Test\\Downloads\\video.mp4',
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
  let confirmCancel;
  const env = createEnv({
    request(type, payload) {
      if (type === HOST_COMMANDS.LIST_FORMATS) return formatsEvent();
      if (type === HOST_COMMANDS.START_DOWNLOAD) return startedEvent();
      if (type === HOST_COMMANDS.CANCEL_DOWNLOAD) {
        return new Promise((resolve) => {
          confirmCancel = () => resolve({
            type: 'jobCancelled', requestId: 'cancel-1', jobId: payload.jobId,
          });
        });
      }
      throw new Error(`unexpected command ${type}`);
    },
  });
  await start(env);
  const before = clone(env.storageLocal.values.youtubeJob);

  const first = env.coordinator.handle(message(YOUTUBE_ACTIONS.CANCEL_DOWNLOAD, {
    jobId: 'job-1',
  }));
  const second = env.coordinator.handle(message(YOUTUBE_ACTIONS.CANCEL_DOWNLOAD, {
    jobId: 'job-1',
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(env.requests.filter(({ type }) => type === HOST_COMMANDS.CANCEL_DOWNLOAD).length, 1);
  assert.deepEqual(env.storageLocal.values.youtubeJob, before);
  confirmCancel();
  assert.deepEqual(await Promise.all([first, second]), [
    { requested: true }, { requested: true },
  ]);
  assert.equal(env.storageLocal.values.youtubeJob.stage, 'cancelled');

  await env.coordinator.handleHostEvent({
    type: 'jobCancelled', requestId: 'start-1', jobId: 'other-job',
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
  assert.deepEqual(missing.storageLocal.calls.get, [['youtubeJob', 'mediaStartIntent']]);
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
  assert.deepEqual(corrupted.storageLocal.calls.get, [['youtubeJob', 'mediaStartIntent']]);
  assert.deepEqual(corrupted.storageLocal.calls.remove, ['youtubeJob']);
  assert.equal(await corrupted.coordinator.handle(message(YOUTUBE_ACTIONS.GET_JOB, {})), null);
  assert.deepEqual(corrupted.requests, []);

  const coercedError = createEnv({
    initial: { youtubeJob: persistedJob({ stage: 'failed', error: 123 }) },
  });
  await coercedError.coordinator.ready;
  assert.equal(Object.hasOwn(coercedError.storageLocal.values, 'youtubeJob'), false);
  assert.deepEqual(coercedError.requests, []);
});

test('recupera intenção com catálogo durável sem sobrescrever com o job terminal anterior', async () => {
  const intent = {
    operationId: 'media-recovered',
    url: CANONICAL_URL,
    height: 720,
    destinationFolder: String.raw`C:\Downloads\Video Radar`,
    catalog: clone(CATALOG),
    createdAt: 50,
  };
  const previous = persistedJob({
    jobId: 'old-job',
    stage: 'complete',
    percent: 100,
    path: String.raw`C:\Downloads\old.mp4`,
  });
  const env = createEnv({
    initial: { youtubeJob: previous, mediaStartIntent: intent },
    request(type) {
      assert.equal(type, HOST_COMMANDS.GET_JOB);
      return {
        type: 'ready',
        requestId: 'recover-1',
        job: {
          jobId: 'new-job',
          operationId: 'media-recovered',
          videoId: VIDEO_ID,
          title: CATALOG.title,
          height: 720,
          stage: 'video',
          percent: 30,
          path: null,
          errorCode: null,
        },
      };
    },
  });

  const recovered = await env.coordinator.ready;

  assert.equal(recovered.jobId, 'new-job');
  assert.equal(recovered.operationId, 'media-recovered');
  assert.equal(recovered.stage, 'video');
  assert.equal(env.storageLocal.values.youtubeJob.jobId, 'new-job');
  assert.equal(Object.hasOwn(env.storageLocal.values, 'mediaStartIntent'), false);
  assert.deepEqual(env.requests, [{ type: HOST_COMMANDS.GET_JOB, payload: {} }]);
});

test('remove intenção corrompida sem encaminhar URL não allowlisted ao host', async () => {
  const env = createEnv({
    initial: {
      mediaStartIntent: {
        operationId: 'media-corrupt',
        url: 'https://evil.test/video',
        height: 720,
        destinationFolder: String.raw`C:\Downloads\Video Radar`,
        createdAt: 50,
      },
    },
    request() {
      throw new Error('host must not receive a corrupt intent');
    },
  });

  assert.equal(await env.coordinator.ready, null);
  assert.deepEqual(env.requests, []);
  assert.equal(Object.hasOwn(env.storageLocal.values, 'mediaStartIntent'), false);

  const nonObject = createEnv({ initial: { mediaStartIntent: 'corrupt' } });
  assert.equal(await nonObject.coordinator.ready, null);
  assert.deepEqual(nonObject.requests, []);
  assert.equal(Object.hasOwn(nonObject.storageLocal.values, 'mediaStartIntent'), false);
});

test('preserva intenção válida quando a reconciliação falha de modo transitório', async () => {
  const intent = {
    operationId: 'media-retry',
    url: CANONICAL_URL,
    height: 720,
    destinationFolder: String.raw`C:\Downloads\Video Radar`,
    catalog: clone(CATALOG),
    createdAt: 50,
  };
  const env = createEnv({
    initial: { mediaStartIntent: intent },
    request(type) {
      assert.equal(type, HOST_COMMANDS.GET_JOB);
      throw Object.assign(new Error('host unavailable'), { code: 'NATIVE_DISCONNECTED' });
    },
  });

  assert.equal(await env.coordinator.ready, null);
  assert.deepEqual(env.storageLocal.values.mediaStartIntent, intent);
  assert.deepEqual(env.storageLocal.calls.remove, []);
  assert.deepEqual(env.requests, [{ type: HOST_COMMANDS.GET_JOB, payload: {} }]);
  assert.deepEqual(env.keepAliveCalls.at(-1), { reason: 'media-job', active: true });
});

test('remove intenção válida após resposta conclusiva sem job correspondente', async () => {
  const intent = {
    operationId: 'media-missing',
    url: CANONICAL_URL,
    height: 720,
    destinationFolder: String.raw`C:\Downloads\Video Radar`,
    catalog: clone(CATALOG),
    createdAt: 50,
  };
  const env = createEnv({ initial: { mediaStartIntent: intent } });

  assert.equal(await env.coordinator.ready, null);
  assert.equal(Object.hasOwn(env.storageLocal.values, 'mediaStartIntent'), false);
  assert.deepEqual(env.storageLocal.calls.remove, ['mediaStartIntent']);
});

test('falha START não-timeout preserva intenção e novo START a reconcilia sem overwrite', async () => {
  let reconcileAvailable = false;
  let generated = 0;
  const env = createEnv({
    createStartOperationId() {
      generated += 1;
      return generated === 1 ? 'media-first' : 'media-overwrite';
    },
    request(type) {
      if (type === HOST_COMMANDS.LIST_FORMATS) return formatsEvent();
      if (type === HOST_COMMANDS.START_DOWNLOAD) {
        throw Object.assign(new Error('native port disconnected'), {
          code: 'NATIVE_DISCONNECTED',
        });
      }
      if (type === HOST_COMMANDS.GET_JOB) {
        if (!reconcileAvailable) {
          throw Object.assign(new Error('native port still unavailable'), {
            code: 'NATIVE_DISCONNECTED',
          });
        }
        return {
          type: 'ready',
          requestId: 'recover-after-disconnect',
          job: {
            jobId: 'job-orphan',
            operationId: 'media-first',
            videoId: VIDEO_ID,
            title: CATALOG.title,
            height: 720,
            stage: 'video',
            percent: 25,
            path: null,
            errorCode: null,
          },
        };
      }
      throw new Error(`unexpected command ${type}`);
    },
  });

  await assert.rejects(start(env), /disconnected/);
  assert.equal(env.storageLocal.values.mediaStartIntent.operationId, 'media-first');
  assert.deepEqual(env.keepAliveCalls.at(-1), { reason: 'media-job', active: true });

  await assert.rejects(start(env), /still unavailable/);
  assert.equal(generated, 1);
  assert.equal(env.storageLocal.values.mediaStartIntent.operationId, 'media-first');
  assert.equal(
    env.requests.filter(({ type }) => type === HOST_COMMANDS.START_DOWNLOAD).length,
    1,
  );

  reconcileAvailable = true;
  await assert.rejects(start(env), /download YouTube ativo/);
  assert.equal(generated, 1);
  assert.equal(Object.hasOwn(env.storageLocal.values, 'mediaStartIntent'), false);
  assert.equal(env.storageLocal.values.youtubeJob.jobId, 'job-orphan');
  assert.equal(
    env.requests.filter(({ type }) => type === HOST_COMMANDS.START_DOWNLOAD).length,
    1,
  );

  const recovered = await env.coordinator.handle(message(YOUTUBE_ACTIONS.GET_JOB, {}));
  assert.equal(recovered.jobId, 'job-orphan');
  assert.equal(recovered.operationId, 'media-first');
  assert.equal(recovered.stage, 'video');
  assert.equal(Object.hasOwn(env.storageLocal.values, 'mediaStartIntent'), false);
});

test('falha genérica ao postar START reconcilia imediatamente qualquer job correlacionado', async () => {
  const env = createEnv({
    request(type) {
      if (type === HOST_COMMANDS.LIST_FORMATS) return formatsEvent();
      if (type === HOST_COMMANDS.START_DOWNLOAD) throw new Error('postMessage failed');
      if (type === HOST_COMMANDS.GET_JOB) {
        return {
          type: 'ready',
          requestId: 'recover-post-message',
          job: {
            jobId: 'job-posted',
            operationId: 'media-test',
            videoId: VIDEO_ID,
            title: CATALOG.title,
            height: 720,
            stage: 'preparing',
            percent: null,
            path: null,
            errorCode: null,
          },
        };
      }
      throw new Error(`unexpected command ${type}`);
    },
  });

  const recovered = await start(env);
  assert.equal(recovered.jobId, 'job-posted');
  assert.equal(recovered.operationId, 'media-test');
  assert.equal(Object.hasOwn(env.storageLocal.values, 'mediaStartIntent'), false);
  assert.deepEqual(env.requests.map(({ type }) => type), [
    HOST_COMMANDS.LIST_FORMATS,
    HOST_COMMANDS.START_DOWNLOAD,
    HOST_COMMANDS.GET_JOB,
  ]);
});

test('resposta READY sem job encerra intenção ambígua e permite uma nova operação', async () => {
  let operationNumber = 0;
  let startNumber = 0;
  const env = createEnv({
    createStartOperationId() {
      operationNumber += 1;
      return `media-attempt-${operationNumber}`;
    },
    request(type) {
      if (type === HOST_COMMANDS.LIST_FORMATS) return formatsEvent();
      if (type === HOST_COMMANDS.START_DOWNLOAD) {
        startNumber += 1;
        if (startNumber === 1) throw new Error('ambiguous send failure');
        return {
          ...startedEvent('job-second', 'start-second'),
          job: {
            ...startedEvent('job-second', 'start-second').job,
            operationId: 'media-attempt-2',
          },
        };
      }
      if (type === HOST_COMMANDS.GET_JOB) {
        return { type: 'ready', requestId: 'first-is-absent', job: null };
      }
      throw new Error(`unexpected command ${type}`);
    },
  });

  await assert.rejects(start(env), /ambiguous send failure/);
  assert.equal(Object.hasOwn(env.storageLocal.values, 'mediaStartIntent'), false);

  const second = await start(env);
  assert.equal(second.operationId, 'media-attempt-2');
  assert.equal(startNumber, 2);
  assert.equal(Object.hasOwn(env.storageLocal.values, 'mediaStartIntent'), false);
});
