import {
  HOST_COMMANDS,
  HOST_EVENTS,
  YOUTUBE_ACTIONS,
  assertDownloadSelection,
  assertHostEvent,
} from '../youtube/protocol.js';
import { DOWNLOAD_QUEUE_JOBS } from '../shared/persistence-keys.js';

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MEDIA_ACTIONS = new Set([
  YOUTUBE_ACTIONS.GET_QUEUE,
  YOUTUBE_ACTIONS.CANCEL_DOWNLOAD,
  YOUTUBE_ACTIONS.PAUSE_DOWNLOAD,
  YOUTUBE_ACTIONS.RESUME_DOWNLOAD,
]);
const ACTIVE_QUEUE_STATES = new Set(['queued', 'running']);
const TERMINAL_QUEUE_STATES = new Set(['complete', 'failed', 'cancelled']);
const QUEUE_STATES = new Set(['queued', 'running', 'paused', 'complete', 'failed', 'cancelled']);
const QUEUE_STAGES = new Set([
  'queued', 'running', 'paused', 'preparing', 'video', 'audio', 'merge', 'finalize',
  'complete', 'failed', 'cancelled',
]);
const SAFE_CODE = /^[A-Z0-9_]{1,64}$/;
const PUBLIC_JOB_FIELDS = [
  'jobId', 'operationId', 'videoId', 'title', 'url', 'height', 'selection', 'state',
  'stage', 'percent', 'downloadedBytes', 'totalBytes', 'speedBytesPerSecond',
  'etaSeconds', 'path', 'error', 'position', 'resumePartial', 'attemptCount',
  'createdAt', 'updatedAt',
];

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nullableInteger(value, minimum = 0) {
  return value === null || (Number.isSafeInteger(value) && value >= minimum);
}

function clonePublicJob(job) {
  return { ...job, selection: { ...job.selection } };
}

function publicJobEquals(left, right) {
  if (left === undefined || right === undefined) return left === right;
  return JSON.stringify(left) === JSON.stringify(right);
}

function sortPublicJobs(jobs) {
  return jobs.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
}

function recalculateQueuePositions(jobs) {
  const pending = jobs
    .filter((job) => ACTIVE_QUEUE_STATES.has(job.state))
    .sort((left, right) => {
      const stateOrder = Number(right.state === 'running') - Number(left.state === 'running');
      const positionOrder = (left.position ?? Number.MAX_SAFE_INTEGER)
        - (right.position ?? Number.MAX_SAFE_INTEGER);
      return stateOrder
        || positionOrder
        || Date.parse(left.createdAt) - Date.parse(right.createdAt)
        || left.jobId.localeCompare(right.jobId);
    });
  if (pending.length > 32) throw new Error('Mensagem inválida');
  const positions = new Map(pending.map((job, index) => [job.jobId, index + 1]));
  return jobs.map((job) => ({
    ...job,
    selection: { ...job.selection },
    position: positions.get(job.jobId) ?? null,
  }));
}

function queueStateMatchesStage(state, stage) {
  if (state === 'running') {
    return ['running', 'preparing', 'video', 'audio', 'merge', 'finalize'].includes(stage);
  }
  return state === stage;
}

export function sanitizePublicQueueJob(value) {
  if (!plainObject(value)
    || Object.keys(value).length !== PUBLIC_JOB_FIELDS.length
    || !PUBLIC_JOB_FIELDS.every((field) => Object.hasOwn(value, field))
    || typeof value.jobId !== 'string' || !SAFE_ID.test(value.jobId)
    || typeof value.operationId !== 'string' || !SAFE_ID.test(value.operationId)
    || typeof value.videoId !== 'string' || !SAFE_ID.test(value.videoId)
    || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 512
    || !QUEUE_STATES.has(value.state) || !QUEUE_STAGES.has(value.stage)
    || !queueStateMatchesStage(value.state, value.stage)
    || !nullableInteger(value.percent)
    || (value.percent !== null && value.percent > 100)
    || ![value.downloadedBytes, value.totalBytes, value.speedBytesPerSecond, value.etaSeconds]
      .every((entry) => nullableInteger(entry))
    || !(value.path === null || (typeof value.path === 'string' && value.path.length <= 1024))
    || !(value.error === null || (typeof value.error === 'string' && SAFE_CODE.test(value.error)))
    || !(value.position === null || (Number.isSafeInteger(value.position)
      && value.position >= 1 && value.position <= 32))
    || typeof value.resumePartial !== 'boolean'
    || !Number.isSafeInteger(value.attemptCount) || value.attemptCount < 0
    || typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt))
    || typeof value.updatedAt !== 'string' || Number.isNaN(Date.parse(value.updatedAt))) {
    throw new Error('Mensagem inválida');
  }
  if ((value.state === 'complete'
      && (value.path === null || value.percent !== 100 || value.error !== null))
    || (value.state === 'failed' && value.error === null)
    || (value.state !== 'failed' && value.error !== null)
    || (value.state !== 'complete' && value.path !== null)) {
    throw new Error('Mensagem inválida');
  }
  let url;
  try { url = new URL(value.url); } catch { throw new Error('Mensagem inválida'); }
  const selection = assertDownloadSelection(value.selection);
  if (url.protocol !== 'https:' || url.href !== value.url
    || value.height !== (selection.height ?? 0)) throw new Error('Mensagem inválida');
  return clonePublicJob({ ...value, selection });
}

export function sanitizePublicQueueJobs(value) {
  if (!Array.isArray(value) || value.length > 64) throw new Error('Mensagem inválida');
  const jobs = value.map(sanitizePublicQueueJob);
  if (new Set(jobs.map(({ jobId }) => jobId)).size !== jobs.length
    || new Set(jobs.map(({ operationId }) => operationId)).size !== jobs.length) {
    throw new Error('Mensagem inválida');
  }
  return jobs;
}

function assertMessage(raw) {
  if (!plainObject(raw) || raw.target !== 'background' || !MEDIA_ACTIONS.has(raw.action)
    || !plainObject(raw.payload)) throw new Error('Mensagem inválida');
  if (raw.action === YOUTUBE_ACTIONS.GET_QUEUE) {
    if (Object.keys(raw.payload).length !== 0) throw new Error('Mensagem inválida');
    return { action: raw.action };
  }
  if (Object.keys(raw.payload).length !== 1
    || typeof raw.payload.jobId !== 'string'
    || !SAFE_ID.test(raw.payload.jobId)) throw new Error('Mensagem inválida');
  return { action: raw.action, jobId: raw.payload.jobId };
}

export function queueItemToPublicJob(item) {
  const selection = assertDownloadSelection(item.selection);
  return sanitizePublicQueueJob({
    jobId: item.jobId,
    operationId: item.operationId,
    videoId: item.videoId || item.operationId,
    title: item.title || 'Download de mídia',
    url: item.url,
    height: selection.height ?? 0,
    selection,
    state: item.state,
    stage: item.stage,
    percent: item.percent,
    downloadedBytes: item.downloadedBytes ?? null,
    totalBytes: item.totalBytes ?? null,
    speedBytesPerSecond: item.speedBytesPerSecond ?? null,
    etaSeconds: item.etaSeconds ?? null,
    path: item.path,
    error: item.errorCode,
    position: item.position,
    resumePartial: item.resumePartial,
    attemptCount: item.attemptCount,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  });
}

export function createDownloadQueueCoordinator({
  nativeClient,
  storageLocal = null,
  scheduleMaintenance = () => {},
  onTerminalJob = () => {},
}) {
  if (typeof nativeClient?.request !== 'function') {
    throw new TypeError('Dependência inválida da fila de downloads.');
  }
  if (typeof scheduleMaintenance !== 'function' || typeof onTerminalJob !== 'function') {
    throw new TypeError('Dependência inválida da fila de downloads.');
  }
  let current = [];
  const listeners = new Set();
  let refreshTask = null;
  let storageWrite = Promise.resolve();

  function snapshotCurrent() {
    return current.map(clonePublicJob);
  }

  function preserveConcurrentChanges(candidate, baseline) {
    const next = new Map(candidate.map((job) => [job.jobId, clonePublicJob(job)]));
    const before = new Map(baseline.map((job) => [job.jobId, job]));
    const now = new Map(current.map((job) => [job.jobId, job]));
    const ids = new Set([...before.keys(), ...now.keys()]);

    for (const jobId of ids) {
      const previous = before.get(jobId);
      const latest = now.get(jobId);
      if (publicJobEquals(previous, latest)) continue;
      if (latest === undefined) next.delete(jobId);
      else next.set(jobId, clonePublicJob(latest));
    }
    return sortPublicJobs([...next.values()]);
  }

  function preserveNewerJobs(candidate) {
    const next = new Map(candidate.map((job) => [job.jobId, clonePublicJob(job)]));
    for (const existing of current) {
      const incoming = next.get(existing.jobId);
      if (incoming !== undefined
        && Date.parse(existing.updatedAt) >= Date.parse(incoming.updatedAt)) {
        next.set(existing.jobId, clonePublicJob(existing));
      }
    }
    return sortPublicJobs([...next.values()]);
  }

  function publish(jobs) {
    current = recalculateQueuePositions(sanitizePublicQueueJobs(jobs));
    nativeClient.setKeepAlive?.(
      'download-queue',
      current.some((job) => ACTIVE_QUEUE_STATES.has(job.state)),
    );
    if (typeof storageLocal?.set === 'function') {
      const snapshot = current.map(clonePublicJob);
      storageWrite = storageWrite
        .then(() => storageLocal.set({ [DOWNLOAD_QUEUE_JOBS]: snapshot }))
        .catch(() => {
          // The native queue remains authoritative and is refreshed on the next popup/worker wake-up.
        });
    }
    for (const listener of listeners) {
      try { listener(current.map(clonePublicJob)); } catch { }
    }
    return current.map(clonePublicJob);
  }

  function notifyTerminal(job) {
    try {
      Promise.resolve(onTerminalJob(clonePublicJob(job))).catch(() => {});
    } catch {
      // Notification failures must not roll back or duplicate a durable host event.
    }
  }

  function merge(item, { notify = false } = {}) {
    const job = queueItemToPublicJob(item);
    const existing = current.find((entry) => entry.jobId === job.jobId);
    if (existing && (Date.parse(existing.updatedAt) > Date.parse(job.updatedAt)
      || (existing.updatedAt === job.updatedAt
        && (publicJobEquals(existing, job)
          || (TERMINAL_QUEUE_STATES.has(existing.state)
            && !TERMINAL_QUEUE_STATES.has(job.state)))))) {
      return snapshotCurrent();
    }
    const jobs = publish(sortPublicJobs([
      ...current.filter((entry) => entry.jobId !== job.jobId), job,
    ]));
    if (notify && ['complete', 'failed'].includes(job.state)
      && existing?.state !== job.state) {
      notifyTerminal(jobs.find((entry) => entry.jobId === job.jobId) ?? job);
    }
    return jobs;
  }

  async function refresh() {
    if (!refreshTask) {
      const baseline = snapshotCurrent();
      refreshTask = (async () => {
        try {
          const event = assertHostEvent(await nativeClient.request(HOST_COMMANDS.LIST_QUEUE, {}));
          if (event.type !== HOST_EVENTS.QUEUE_SNAPSHOT) throw new Error('Mensagem inválida');
          const candidate = event.jobs.map(queueItemToPublicJob);
          return publish(preserveConcurrentChanges(candidate, baseline));
        } catch (error) {
          if (current.some((job) => ACTIVE_QUEUE_STATES.has(job.state))) {
            try { scheduleMaintenance(); } catch { }
          }
          throw error;
        }
      })().finally(() => { refreshTask = null; });
    }
    return refreshTask;
  }

  async function initialize() {
    const baseline = snapshotCurrent();
    if (typeof storageLocal?.get !== 'function') return [];
    let stored;
    try {
      stored = await storageLocal.get(DOWNLOAD_QUEUE_JOBS);
    } catch {
      return snapshotCurrent();
    }
    if (!plainObject(stored) || !Object.hasOwn(stored, DOWNLOAD_QUEUE_JOBS)) {
      return snapshotCurrent();
    }

    let jobs;
    try {
      const candidate = sanitizePublicQueueJobs(stored[DOWNLOAD_QUEUE_JOBS]);
      const changedDuringRestore = !publicJobEquals(baseline, current);
      jobs = publish(preserveConcurrentChanges(candidate, baseline));
      if (!changedDuringRestore
        && !jobs.some((job) => ACTIVE_QUEUE_STATES.has(job.state))) return jobs;
    } catch {
      return snapshotCurrent();
    }

    try {
      return await refresh();
    } catch {
      // Keep the native port alive while the durable snapshot is active. A
      // later popup, startup event or worker wake retries authoritative sync.
      return jobs;
    }
  }

  async function handle(raw) {
    await ready;
    const message = assertMessage(raw);
    if (message.action === YOUTUBE_ACTIONS.GET_QUEUE) return refresh();
    const type = message.action === YOUTUBE_ACTIONS.PAUSE_DOWNLOAD
      ? HOST_COMMANDS.PAUSE_DOWNLOAD
      : message.action === YOUTUBE_ACTIONS.RESUME_DOWNLOAD
        ? HOST_COMMANDS.RESUME_DOWNLOAD
        : HOST_COMMANDS.CANCEL_DOWNLOAD;
    if (type === HOST_COMMANDS.CANCEL_DOWNLOAD) {
      const event = assertHostEvent(await nativeClient.request(type, { jobId: message.jobId }));
      if (event.type !== HOST_EVENTS.JOB_CANCELLED || !event.job) {
        throw new Error('Mensagem inválida');
      }
      const jobs = merge(event.job);
      const job = jobs.find((entry) => entry.jobId === message.jobId);
      if (!job) throw new Error('Mensagem inválida');
      return job;
    }
    const event = assertHostEvent(await nativeClient.request(type, { jobId: message.jobId }));
    const expected = type === HOST_COMMANDS.PAUSE_DOWNLOAD
      ? HOST_EVENTS.JOB_PAUSED
      : type === HOST_COMMANDS.RESUME_DOWNLOAD
        ? HOST_EVENTS.JOB_QUEUED
        : HOST_EVENTS.JOB_CANCELLED;
    if (event.type !== expected || !event.job) throw new Error('Mensagem inválida');
    merge(event.job);
    return queueItemToPublicJob(event.job);
  }

  async function reconcile() {
    await ready;
    if (!current.some((job) => ACTIVE_QUEUE_STATES.has(job.state))) return snapshotCurrent();
    return refresh();
  }

  function handleHostEvent(raw) {
    let event;
    try { event = assertHostEvent(raw); } catch { return false; }
    if (event.type === HOST_EVENTS.QUEUE_SNAPSHOT) {
      publish(preserveNewerJobs(event.jobs.map(queueItemToPublicJob)));
      return true;
    }
    if (event.type === HOST_EVENTS.JOB_PROGRESS) {
      const existing = current.find((job) => job.jobId === event.jobId);
      if (!existing) return false;
      const advanced = event.stage !== existing.stage;
      const next = {
        ...existing,
        state: 'running',
        stage: event.stage,
        percent: Object.hasOwn(event, 'percent')
          ? (advanced || existing.percent === null || event.percent === null
            ? event.percent
            : Math.max(existing.percent, event.percent))
          : existing.percent,
      };
      for (const field of [
        'downloadedBytes', 'totalBytes', 'speedBytesPerSecond', 'etaSeconds',
      ]) {
        if (Object.hasOwn(event, field)) next[field] = event[field];
      }
      publish(current.map((job) => job.jobId === next.jobId ? next : job));
      return true;
    }
    if (event.job && [
      HOST_EVENTS.JOB_QUEUED,
      HOST_EVENTS.JOB_STARTED,
      HOST_EVENTS.JOB_PAUSED,
      HOST_EVENTS.JOB_COMPLETED,
      HOST_EVENTS.JOB_CANCELLED,
      HOST_EVENTS.JOB_FAILED,
    ].includes(event.type)) {
      merge(event.job, {
        notify: event.type === HOST_EVENTS.JOB_COMPLETED
          || event.type === HOST_EVENTS.JOB_FAILED,
      });
      return true;
    }
    return false;
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('Listener inválido.');
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  const ready = initialize();
  return Object.freeze({ handle, handleHostEvent, refresh, reconcile, subscribe, ready });
}
