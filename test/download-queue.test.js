import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDownloadQueueCoordinator,
  queueItemToPublicJob,
  sanitizePublicQueueJobs,
} from '../src/background/download-queue.js';
import { HOST_COMMANDS, YOUTUBE_ACTIONS } from '../src/youtube/protocol.js';

function queueItem(overrides = {}) {
  return {
    jobId: 'job-1', operationId: 'op-1',
    url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    selection: {
      height: 1080, audioOnly: false, subtitleLanguage: 'pt-BR',
      includeAutomaticSubtitles: false,
    },
    destinationFolder: 'C:\\Downloads\\Video Radar', state: 'queued',
    videoId: 'jNQXAC9IVRw', title: 'Me at the zoo', stage: 'queued', percent: null,
    downloadedBytes: null, totalBytes: null, speedBytesPerSecond: null,
    etaSeconds: null, path: null, errorCode: null, resumePartial: false,
    attemptCount: 0, position: 1, createdAt: '2026-08-12T12:00:00Z',
    updatedAt: '2026-08-12T12:00:00Z',
    ...overrides,
  };
}

function hostEvent(type, item, overrides = {}) {
  return {
    type,
    requestId: 'request-1',
    jobId: item.jobId,
    operationId: item.operationId,
    job: item,
    ...overrides,
  };
}

test('restaura fila completa e expõe o formato público sem perder seleção', async () => {
  const item = queueItem();
  const requests = [];
  const coordinator = createDownloadQueueCoordinator({
    nativeClient: {
      async request(type, payload) {
        requests.push({ type, payload });
        return {
          type: 'queueSnapshot', requestId: 'queue-1', maxActive: 1,
          maxPending: 32, jobs: [item],
        };
      },
    },
  });
  const jobs = await coordinator.handle({
    target: 'background', action: YOUTUBE_ACTIONS.GET_QUEUE, payload: {},
  });

  assert.deepEqual(requests, [{ type: HOST_COMMANDS.LIST_QUEUE, payload: {} }]);
  assert.equal(jobs[0].title, 'Me at the zoo');
  assert.equal(jobs[0].selection.subtitleLanguage, 'pt-BR');
  assert.equal(jobs[0].position, 1);
});

test('pausa, retoma e aplica eventos assíncronos duráveis', async () => {
  const paused = queueItem({ state: 'paused', stage: 'paused', position: null, resumePartial: true });
  const queued = queueItem({ state: 'queued', stage: 'queued', resumePartial: true });
  const requests = [];
  const coordinator = createDownloadQueueCoordinator({
    nativeClient: {
      async request(type, payload) {
        requests.push({ type, payload });
        if (type === HOST_COMMANDS.PAUSE_DOWNLOAD) return hostEvent('jobPaused', paused);
        return hostEvent('jobQueued', queued, { replayed: false, position: 1 });
      },
    },
  });

  assert.equal((await coordinator.handle({
    target: 'background', action: YOUTUBE_ACTIONS.PAUSE_DOWNLOAD,
    payload: { jobId: 'job-1' },
  })).state, 'paused');
  assert.equal((await coordinator.handle({
    target: 'background', action: YOUTUBE_ACTIONS.RESUME_DOWNLOAD,
    payload: { jobId: 'job-1' },
  })).state, 'queued');

  const observed = [];
  coordinator.subscribe((jobs) => observed.push(jobs));
  const complete = queueItem({
    state: 'complete', stage: 'complete', percent: 100, position: null,
    path: 'C:\\Downloads\\Video Radar\\video.mp4',
  });
  assert.equal(coordinator.handleHostEvent(hostEvent('jobCompleted', complete, {
    path: complete.path,
  })), true);
  assert.equal(observed.at(-1)[0].state, 'complete');
  assert.deepEqual(requests.map(({ type }) => type), [
    HOST_COMMANDS.PAUSE_DOWNLOAD,
    HOST_COMMANDS.RESUME_DOWNLOAD,
  ]);
});

test('rejeita seleção e mensagens de fila inseguras', async () => {
  assert.throws(() => queueItemToPublicJob(queueItem({
    selection: { height: null, audioOnly: false, subtitleLanguage: null, includeAutomaticSubtitles: false },
  })), /Mensagem inválida/);
  assert.throws(() => queueItemToPublicJob(queueItem({
    state: 'complete', stage: 'queued', position: null,
  })), /Mensagem inválida/);
  const coordinator = createDownloadQueueCoordinator({
    nativeClient: { async request() { throw new Error('não deveria enviar'); } },
  });
  await assert.rejects(coordinator.handle({
    target: 'background', action: YOUTUBE_ACTIONS.PAUSE_DOWNLOAD,
    payload: { jobId: '../job' },
  }), /Mensagem inválida/);
});

test('mantém jobs repetidos separados, persiste progresso e cancela qualquer item da fila', async () => {
  const first = queueItem();
  const second = queueItem({
    jobId: 'job-2', operationId: 'op-2', position: 2,
    createdAt: '2026-08-12T12:00:01Z', updatedAt: '2026-08-12T12:00:01Z',
  });
  const writes = [];
  const keepAlive = [];
  const requests = [];
  const cancelled = queueItem({
    jobId: 'job-2', operationId: 'op-2', state: 'cancelled', stage: 'cancelled',
    percent: null, position: null, createdAt: '2026-08-12T12:00:01Z',
    updatedAt: '2026-08-12T12:00:02Z',
  });
  const coordinator = createDownloadQueueCoordinator({
    storageLocal: { async set(value) { writes.push(structuredClone(value)); } },
    nativeClient: {
      setKeepAlive(reason, enabled) { keepAlive.push([reason, enabled]); },
      async request(type, payload) {
        requests.push({ type, payload });
        if (type === HOST_COMMANDS.LIST_QUEUE) {
          return {
            type: 'queueSnapshot', requestId: 'queue-two', maxActive: 1,
            maxPending: 32, jobs: [first, second],
          };
        }
        if (type === HOST_COMMANDS.CANCEL_DOWNLOAD) {
          return hostEvent('jobCancelled', cancelled, { requestId: 'cancel-job-2' });
        }
        throw new Error(`unexpected command ${type}`);
      },
    },
  });

  const restored = await coordinator.refresh();
  assert.equal(restored.length, 2);
  assert.equal(new Set(restored.map(({ jobId }) => jobId)).size, 2);
  assert.equal(coordinator.handleHostEvent({
    type: 'jobProgress', requestId: 'progress-job-2', jobId: 'job-2',
    stage: 'video', percent: 37, downloadedBytes: 37, totalBytes: 100,
    speedBytesPerSecond: 10, etaSeconds: 7,
  }), true);
  const cancelledResult = await coordinator.handle({
    target: 'background', action: YOUTUBE_ACTIONS.CANCEL_DOWNLOAD,
    payload: { jobId: 'job-2' },
  });
  assert.equal(cancelledResult.jobId, 'job-2');
  assert.equal(cancelledResult.state, 'cancelled');
  await new Promise((resolve) => setImmediate(resolve));

  const latest = writes.at(-1).downloadQueueJobs;
  assert.equal(latest.find(({ jobId }) => jobId === 'job-1').percent, null);
  assert.equal(latest.find(({ jobId }) => jobId === 'job-2').state, 'cancelled');
  assert.deepEqual(requests.at(-1), {
    type: HOST_COMMANDS.CANCEL_DOWNLOAD, payload: { jobId: 'job-2' },
  });
  assert.deepEqual(keepAlive.at(-1), ['download-queue', true]);
  assert.equal(sanitizePublicQueueJobs(latest).length, 2);
});

test('reinício do service worker restaura keepalive e reconcilia fila ativa com o host', async () => {
  const storedRunning = queueItemToPublicJob(queueItem({
    state: 'running', stage: 'video', percent: 42, position: null,
    downloadedBytes: 42, totalBytes: 100, speedBytesPerSecond: 10, etaSeconds: 6,
  }));
  const authoritativePaused = queueItem({
    state: 'paused', stage: 'paused', percent: 42, position: null,
    downloadedBytes: 42, totalBytes: 100, speedBytesPerSecond: null,
    etaSeconds: null, resumePartial: true,
    updatedAt: '2026-08-12T12:01:00Z',
  });
  const requests = [];
  const keepAlive = [];
  const coordinator = createDownloadQueueCoordinator({
    storageLocal: {
      async get() { return { downloadQueueJobs: [storedRunning] }; },
      async set() {},
    },
    nativeClient: {
      setKeepAlive(reason, enabled) { keepAlive.push([reason, enabled]); },
      async request(type, payload) {
        requests.push({ type, payload });
        return {
          type: 'queueSnapshot', requestId: 'restart-sync', maxActive: 1,
          maxPending: 32, jobs: [authoritativePaused],
        };
      },
    },
  });

  const restored = await coordinator.ready;
  assert.equal(restored[0].state, 'paused');
  assert.deepEqual(requests, [{ type: HOST_COMMANDS.LIST_QUEUE, payload: {} }]);
  assert.deepEqual(keepAlive, [
    ['download-queue', true],
    ['download-queue', false],
  ]);
});

test('reinício do service worker não abre o host apenas para histórico terminal', async () => {
  const complete = queueItemToPublicJob(queueItem({
    state: 'complete', stage: 'complete', percent: 100, position: null,
    path: 'C:\\Downloads\\Video Radar\\video.mp4',
  }));
  const requests = [];
  const keepAlive = [];
  const coordinator = createDownloadQueueCoordinator({
    storageLocal: {
      async get() { return { downloadQueueJobs: [complete] }; },
      async set() {},
    },
    nativeClient: {
      setKeepAlive(reason, enabled) { keepAlive.push([reason, enabled]); },
      async request(type, payload) { requests.push({ type, payload }); },
    },
  });

  const restored = await coordinator.ready;
  assert.equal(restored[0].state, 'complete');
  assert.deepEqual(requests, []);
  assert.deepEqual(keepAlive, [['download-queue', false]]);
});

test('GET_QUEUE aguarda a restauração e não deixa storage antigo vencer o host', async () => {
  const complete = queueItemToPublicJob(queueItem({
    state: 'complete', stage: 'complete', percent: 100, position: null,
    path: 'C:\\Downloads\\Video Radar\\old.mp4',
  }));
  const running = queueItem({
    state: 'running', stage: 'video', percent: 25, position: 1,
    downloadedBytes: 25, totalBytes: 100, speedBytesPerSecond: 5, etaSeconds: 15,
  });
  let resolveStorage;
  const storageReady = new Promise((resolve) => { resolveStorage = resolve; });
  const writes = [];
  const requests = [];
  const keepAlive = [];
  const coordinator = createDownloadQueueCoordinator({
    storageLocal: {
      async get() { await storageReady; return { downloadQueueJobs: [complete] }; },
      async set(value) { writes.push(structuredClone(value)); },
    },
    nativeClient: {
      setKeepAlive(reason, enabled) { keepAlive.push([reason, enabled]); },
      async request(type, payload) {
        requests.push({ type, payload });
        return {
          type: 'queueSnapshot', requestId: 'authoritative-running', maxActive: 1,
          maxPending: 32, jobs: [running],
        };
      },
    },
  });

  const refresh = coordinator.handle({
    target: 'background', action: YOUTUBE_ACTIONS.GET_QUEUE, payload: {},
  });
  await Promise.resolve();
  assert.deepEqual(requests, []);
  resolveStorage();
  const jobs = await refresh;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(jobs[0].state, 'running');
  assert.equal(writes.at(-1).downloadQueueJobs[0].state, 'running');
  assert.deepEqual(keepAlive.at(-1), ['download-queue', true]);
  assert.deepEqual(requests, [{ type: HOST_COMMANDS.LIST_QUEUE, payload: {} }]);
});

test('evento nativo recebido durante a restauração vence o storage terminal antigo', async () => {
  const complete = queueItemToPublicJob(queueItem({
    state: 'complete', stage: 'complete', percent: 100, position: null,
    path: 'C:\\Downloads\\Video Radar\\old.mp4',
  }));
  const running = queueItem({
    state: 'running', stage: 'video', percent: 25, position: null,
    downloadedBytes: 25, totalBytes: 100, speedBytesPerSecond: 5, etaSeconds: 15,
    updatedAt: '2026-08-12T12:00:02Z',
  });
  let resolveStorage;
  const storageReady = new Promise((resolve) => { resolveStorage = resolve; });
  const writes = [];
  const keepAlive = [];
  const coordinator = createDownloadQueueCoordinator({
    storageLocal: {
      async get() { await storageReady; return { downloadQueueJobs: [complete] }; },
      async set(value) { writes.push(structuredClone(value)); },
    },
    nativeClient: {
      setKeepAlive(reason, enabled) { keepAlive.push([reason, enabled]); },
      async request() {
        return {
          type: 'queueSnapshot', requestId: 'post-event-sync', maxActive: 1,
          maxPending: 32, jobs: [running],
        };
      },
    },
  });

  assert.equal(coordinator.handleHostEvent(hostEvent('jobStarted', running, {
    requestId: 'early-start', resumed: false,
  })), true);
  resolveStorage();
  const jobs = await coordinator.ready;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(jobs[0].state, 'running');
  assert.equal(writes.at(-1).downloadQueueJobs[0].state, 'running');
  assert.deepEqual(keepAlive.at(-1), ['download-queue', true]);
});

test('snapshot atrasado não ressuscita job concluído por evento concorrente', async () => {
  const running = queueItem({
    state: 'running', stage: 'video', percent: 90, position: null,
    downloadedBytes: 90, totalBytes: 100, speedBytesPerSecond: 5, etaSeconds: 2,
    updatedAt: '2026-08-12T12:00:01Z',
  });
  const complete = queueItem({
    state: 'complete', stage: 'complete', percent: 100, position: null,
    path: 'C:\\Downloads\\Video Radar\\video.mp4',
    updatedAt: '2026-08-12T12:00:02Z',
  });
  let resolveSnapshot;
  const snapshotReady = new Promise((resolve) => { resolveSnapshot = resolve; });
  const writes = [];
  const keepAlive = [];
  const coordinator = createDownloadQueueCoordinator({
    storageLocal: { async set(value) { writes.push(structuredClone(value)); } },
    nativeClient: {
      setKeepAlive(reason, enabled) { keepAlive.push([reason, enabled]); },
      async request() {
        await snapshotReady;
        return {
          type: 'queueSnapshot', requestId: 'stale-snapshot', maxActive: 1,
          maxPending: 32, jobs: [running],
        };
      },
    },
  });

  const refresh = coordinator.refresh();
  assert.equal(coordinator.handleHostEvent(hostEvent('jobCompleted', complete, {
    requestId: 'completion-wins', path: complete.path,
  })), true);
  resolveSnapshot();
  const jobs = await refresh;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(jobs[0].state, 'complete');
  assert.equal(writes.at(-1).downloadQueueJobs[0].state, 'complete');
  assert.deepEqual(keepAlive.at(-1), ['download-queue', false]);
});

test('falha temporária no helper agenda e executa nova reconciliação da fila ativa', async () => {
  const storedRunning = queueItemToPublicJob(queueItem({
    state: 'running', stage: 'video', percent: 10, position: null,
    downloadedBytes: 10, totalBytes: 100, speedBytesPerSecond: 5, etaSeconds: 18,
  }));
  const recovered = queueItem({
    state: 'running', stage: 'video', percent: 20, position: null,
    downloadedBytes: 20, totalBytes: 100, speedBytesPerSecond: 5, etaSeconds: 16,
    updatedAt: '2026-08-12T12:00:02Z',
  });
  let attempts = 0;
  let scheduled = 0;
  const coordinator = createDownloadQueueCoordinator({
    storageLocal: {
      async get() { return { downloadQueueJobs: [storedRunning] }; },
      async set() {},
    },
    scheduleMaintenance() { scheduled += 1; },
    nativeClient: {
      setKeepAlive() {},
      async request() {
        attempts += 1;
        if (attempts === 1) throw new Error('helper temporariamente indisponível');
        return {
          type: 'queueSnapshot', requestId: 'retry-success', maxActive: 1,
          maxPending: 32, jobs: [recovered],
        };
      },
    },
  });

  const initial = await coordinator.ready;
  assert.equal(initial[0].percent, 10);
  assert.equal(scheduled, 1);
  const reconciled = await coordinator.reconcile();
  assert.equal(reconciled[0].percent, 20);
  assert.equal(attempts, 2);
});

test('recalcula posições locais quando jobs terminam, pausam ou são cancelados', async () => {
  const running = queueItem({
    state: 'running', stage: 'video', percent: 10, position: 1,
    downloadedBytes: 10, totalBytes: 100, speedBytesPerSecond: 5, etaSeconds: 18,
  });
  const second = queueItem({
    jobId: 'job-2', operationId: 'op-2', position: 2,
    createdAt: '2026-08-12T12:00:01Z', updatedAt: '2026-08-12T12:00:01Z',
  });
  const third = queueItem({
    jobId: 'job-3', operationId: 'op-3', position: 3,
    createdAt: '2026-08-12T12:00:02Z', updatedAt: '2026-08-12T12:00:02Z',
  });
  const observed = [];
  const coordinator = createDownloadQueueCoordinator({
    nativeClient: { async request() { throw new Error('não deveria enviar'); } },
  });
  coordinator.subscribe((jobs) => observed.push(jobs));
  await coordinator.ready;

  assert.equal(coordinator.handleHostEvent({
    type: 'queueSnapshot', requestId: 'positions', maxActive: 1, maxPending: 32,
    jobs: [running, second, third],
  }), true);
  assert.deepEqual(observed.at(-1).map(({ jobId, position }) => [jobId, position]), [
    ['job-1', 1], ['job-2', 2], ['job-3', 3],
  ]);

  const complete = queueItem({
    state: 'complete', stage: 'complete', percent: 100, position: null,
    path: 'C:\\Downloads\\Video Radar\\one.mp4', updatedAt: '2026-08-12T12:01:00Z',
  });
  coordinator.handleHostEvent(hostEvent('jobCompleted', complete, { path: complete.path }));
  assert.deepEqual(observed.at(-1).map(({ jobId, position }) => [jobId, position]), [
    ['job-1', null], ['job-2', 1], ['job-3', 2],
  ]);

  const paused = queueItem({
    ...second, state: 'paused', stage: 'paused', position: null,
    resumePartial: true, updatedAt: '2026-08-12T12:01:01Z',
  });
  coordinator.handleHostEvent(hostEvent('jobPaused', paused));
  assert.deepEqual(observed.at(-1).map(({ jobId, position }) => [jobId, position]), [
    ['job-1', null], ['job-2', null], ['job-3', 1],
  ]);

  const cancelled = queueItem({
    ...third, state: 'cancelled', stage: 'cancelled', position: null,
    updatedAt: '2026-08-12T12:01:02Z',
  });
  coordinator.handleHostEvent(hostEvent('jobCancelled', cancelled));
  assert.equal(observed.at(-1).every(({ position }) => position === null), true);
});

test('retomada preserva a posição FIFO devolvida pelo host antes de createdAt', async () => {
  const olderPaused = queueItem({
    state: 'paused', stage: 'paused', position: null, resumePartial: true,
  });
  const newerQueued = queueItem({
    jobId: 'job-2', operationId: 'op-2', position: 1,
    createdAt: '2026-08-12T12:00:01Z', updatedAt: '2026-08-12T12:00:01Z',
  });
  const observed = [];
  const coordinator = createDownloadQueueCoordinator({
    nativeClient: { async request() { throw new Error('não deveria enviar'); } },
  });
  coordinator.subscribe((jobs) => observed.push(jobs));
  await coordinator.ready;
  coordinator.handleHostEvent({
    type: 'queueSnapshot', requestId: 'resume-order', maxActive: 1, maxPending: 32,
    jobs: [olderPaused, newerQueued],
  });

  const resumed = queueItem({
    state: 'queued', stage: 'queued', position: 2, resumePartial: true,
    updatedAt: '2026-08-12T12:01:00Z',
  });
  coordinator.handleHostEvent(hostEvent('jobQueued', resumed, {
    replayed: false, position: 2,
  }));

  assert.deepEqual(observed.at(-1).map(({ jobId, position }) => [jobId, position]), [
    ['job-1', 2],
    ['job-2', 1],
  ]);
});

test('notifica cada transição complete/failed uma vez e ignora replay terminal', async () => {
  const notifications = [];
  const coordinator = createDownloadQueueCoordinator({
    nativeClient: { async request() { throw new Error('não deveria enviar'); } },
    onTerminalJob(job) { notifications.push([job.jobId, job.state]); },
  });
  await coordinator.ready;
  coordinator.handleHostEvent(hostEvent('jobQueued', queueItem(), {
    replayed: false, position: 1,
  }));
  const complete = queueItem({
    state: 'complete', stage: 'complete', percent: 100, position: null,
    path: 'C:\\Downloads\\Video Radar\\complete.mp4',
    updatedAt: '2026-08-12T12:01:00Z',
  });
  coordinator.handleHostEvent(hostEvent('jobCompleted', complete, { path: complete.path }));
  coordinator.handleHostEvent(hostEvent('jobCompleted', complete, { path: complete.path }));

  const queuedAgain = queueItem({
    jobId: 'job-2', operationId: 'op-2', position: 1,
    createdAt: '2026-08-12T12:02:00Z', updatedAt: '2026-08-12T12:02:00Z',
  });
  coordinator.handleHostEvent(hostEvent('jobQueued', queuedAgain, {
    replayed: false, position: 1,
  }));
  const failed = queueItem({
    ...queuedAgain, state: 'failed', stage: 'failed', position: null,
    errorCode: 'NETWORK_TIMEOUT', updatedAt: '2026-08-12T12:02:01Z',
  });
  const failure = {
    code: failed.errorCode, message: 'Download failed', details: {},
  };
  coordinator.handleHostEvent(hostEvent('jobFailed', failed, failure));
  coordinator.handleHostEvent(hostEvent('jobFailed', {
    ...failed, updatedAt: '2026-08-12T12:02:02Z',
  }, failure));

  assert.deepEqual(notifications, [
    ['job-1', 'complete'],
    ['job-2', 'failed'],
  ]);
});

test('cancel retorna e publica o job mesmo quando a persistência local falha', async () => {
  const queued = queueItem();
  const cancelled = queueItem({
    state: 'cancelled', stage: 'cancelled', position: null,
    updatedAt: '2026-08-12T12:01:00Z',
  });
  const observed = [];
  const coordinator = createDownloadQueueCoordinator({
    storageLocal: {
      async set() { throw new Error('quota indisponível'); },
    },
    nativeClient: {
      async request(type) {
        if (type === HOST_COMMANDS.LIST_QUEUE) {
          return {
            type: 'queueSnapshot', requestId: 'storage-failure-list', maxActive: 1,
            maxPending: 32, jobs: [queued],
          };
        }
        if (type === HOST_COMMANDS.CANCEL_DOWNLOAD) {
          return hostEvent('jobCancelled', cancelled, { requestId: 'storage-failure-cancel' });
        }
        throw new Error(`unexpected command ${type}`);
      },
    },
  });
  coordinator.subscribe((jobs) => observed.push(jobs));
  await coordinator.refresh();

  const result = await coordinator.handle({
    target: 'background', action: YOUTUBE_ACTIONS.CANCEL_DOWNLOAD,
    payload: { jobId: 'job-1' },
  });

  assert.equal(result.state, 'cancelled');
  assert.equal(observed.at(-1)[0].state, 'cancelled');
});
