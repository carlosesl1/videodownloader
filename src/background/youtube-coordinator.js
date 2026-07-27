import {
  HOST_COMMANDS,
  HOST_EVENTS,
  YOUTUBE_ACTIONS,
  assertFormatsResult,
  assertHostEvent,
} from '../youtube/protocol.js';
import {
  normalizeWindowsFolder,
  readDownloadPreferences,
} from '../shared/download-preferences.js';
import { assertJobSnapshot } from '../youtube/job-view.js';
import { canonicalYouTubePageUrl } from '../youtube/page-url.js';

const STORAGE_KEY = 'youtubeJob';
const ACTIVE_STAGES = new Set(['preparing', 'video', 'audio', 'merge', 'finalize']);
const TERMINAL_STAGES = new Set(['complete', 'cancelled', 'failed', 'interrupted']);
const STAGE_RANK = Object.freeze({ preparing: 0, video: 1, audio: 2, merge: 3, finalize: 4 });
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SAFE_ERROR = /^[A-Za-z0-9_]{1,64}$/;
const SNAPSHOT_FIELDS = [
  'jobId', 'videoId', 'title', 'url', 'height', 'format',
  'stage', 'percent', 'downloadedBytes', 'totalBytes', 'speedBytesPerSecond', 'etaSeconds',
  'path', 'error', 'updatedAt',
];

function invalid(message = 'Mensagem inválida') {
  throw new Error(message);
}

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value, expected) {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function nullableNonnegativeInteger(value) {
  return value === null || (Number.isSafeInteger(value) && value >= 0);
}

function copyFormat(format) {
  return {
    height: format.height,
    label: format.label,
    container: format.container,
    combined: format.combined,
  };
}

function copyCatalog(catalog) {
  return {
    videoId: catalog.videoId,
    title: catalog.title,
    durationSeconds: catalog.durationSeconds,
    qualities: catalog.qualities.map(copyFormat),
  };
}

function copySnapshot(snapshot) {
  if (snapshot === null) return null;
  return { ...snapshot, format: copyFormat(snapshot.format) };
}

/** Validates the only durable YouTube record and returns its fixed public shape. */
export function sanitizeYouTubeJobSnapshot(value) {
  if (!plainObject(value) || !hasOnlyKeys(value, SNAPSHOT_FIELDS)) invalid();
  const {
    jobId, videoId, title, url, height, format, stage, percent,
    downloadedBytes, totalBytes, speedBytesPerSecond, etaSeconds,
    path, error, updatedAt,
  } = value;

  const core = assertJobSnapshot({
    jobId, videoId, title, height, stage, percent, path, errorCode: error,
  });
  if (!videoId || !title || canonicalYouTubePageUrl(url) !== url || !url.endsWith(`v=${videoId}`)) invalid();
  if (!(percent === null || (Number.isSafeInteger(percent) && percent >= 0 && percent <= 100))) invalid();
  if (![downloadedBytes, totalBytes, speedBytesPerSecond, etaSeconds].every(nullableNonnegativeInteger)) invalid();
  if (!(error === null || SAFE_ERROR.test(error))) invalid();
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) invalid();
  if (!plainObject(format) || !hasOnlyKeys(format, ['height', 'label', 'container', 'combined'])) invalid();

  const validatedFormat = assertFormatsResult({
    type: 'formats', requestId: 'persisted', videoId, title, durationSeconds: null,
    qualities: [format],
  }).qualities[0];
  if (validatedFormat.height !== height) invalid();

  return {
    jobId: core.jobId,
    videoId,
    title,
    url,
    height: core.height,
    format: copyFormat(validatedFormat),
    stage: core.stage,
    percent,
    downloadedBytes,
    totalBytes,
    speedBytesPerSecond,
    etaSeconds,
    path: core.path,
    error,
    updatedAt,
  };
}

function assertPayload(payload, fields) {
  if (!plainObject(payload) || !hasOnlyKeys(payload, fields)) invalid();
}

function assertExtensionMessage(message) {
  if (!plainObject(message) || message.target !== 'background'
    || !Object.values(YOUTUBE_ACTIONS).includes(message.action)) invalid();
  if (message.action === YOUTUBE_ACTIONS.LIST_FORMATS) {
    assertPayload(message.payload, ['url']);
    const url = canonicalYouTubePageUrl(message.payload.url);
    if (!url) invalid();
    return { action: message.action, url };
  }
  if (message.action === YOUTUBE_ACTIONS.START_DOWNLOAD) {
    assertPayload(message.payload, ['url', 'height']);
    const url = canonicalYouTubePageUrl(message.payload.url);
    const { height } = message.payload;
    if (!url || !Number.isSafeInteger(height) || height < 144 || height > 4320) invalid();
    return { action: message.action, url, height };
  }
  if (message.action === YOUTUBE_ACTIONS.CANCEL_DOWNLOAD) {
    assertPayload(message.payload, ['jobId']);
    if (typeof message.payload.jobId !== 'string' || !SAFE_ID.test(message.payload.jobId)) invalid();
    return { action: message.action, jobId: message.payload.jobId };
  }
  if (message.action === YOUTUBE_ACTIONS.REVEAL_DOWNLOADED_FILE) {
    assertPayload(message.payload, ['path']);
    let path;
    try {
      path = normalizeWindowsFolder(message.payload.path);
    } catch {
      invalid();
    }
    return { action: message.action, path };
  }
  assertPayload(message.payload, []);
  return { action: message.action };
}

function isJobEvent(event) {
  return event.type === 'jobStarted' || event.type === 'jobProgress'
    || event.type === 'jobCompleted' || event.type === 'jobCancelled'
    || event.type === 'jobFailed';
}

async function resolveYouTubeDestination(nativeClient, storageLocal) {
  const preferences = await readDownloadPreferences(storageLocal);
  if (!preferences.askEveryTime) {
    return { cancelled: false, destinationFolder: preferences.defaultFolder };
  }

  const event = assertHostEvent(
    await nativeClient.request(HOST_COMMANDS.CHOOSE_DOWNLOAD_FOLDER, {}),
  );
  if (event.type === HOST_EVENTS.FOLDER_SELECTION_CANCELLED) {
    return { cancelled: true, destinationFolder: null };
  }
  if (event.type !== HOST_EVENTS.FOLDER_SELECTED) invalid();
  return { cancelled: false, destinationFolder: event.path };
}

export function createYouTubeCoordinator({ nativeClient, storageLocal, notifications, now }) {
  if (typeof nativeClient?.request !== 'function' || typeof now !== 'function') {
    throw new TypeError('Dependências inválidas do coordenador YouTube.');
  }

  let current = null;
  let pendingStart = null;
  const pendingCancellations = new Set();
  const catalogs = new Map();
  let stateQueue = Promise.resolve();
  let commandQueue = Promise.resolve();

  function serializedState(operation) {
    const task = stateQueue.then(operation, operation);
    stateQueue = task.catch(() => {});
    return task;
  }

  function serializedCommand(operation) {
    const task = commandQueue.then(operation, operation);
    commandQueue = task.catch(() => {});
    return task;
  }

  function timestamp() {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Relógio inválido.');
    return value;
  }

  async function persistLocked(candidate) {
    const snapshot = sanitizeYouTubeJobSnapshot({ ...candidate, updatedAt: timestamp() });
    await storageLocal.set({ [STORAGE_KEY]: snapshot });
    current = snapshot;
    return copySnapshot(snapshot);
  }

  async function notifyCompleted(jobId) {
    if (typeof notifications?.create !== 'function') return;
    const iconUrl = globalThis.chrome?.runtime?.getURL?.('assets/icon-128.png')
      ?? 'assets/icon-128.png';
    await notifications.create(`youtube-job-${jobId}`, {
      type: 'basic',
      iconUrl,
      title: 'Vídeo Radar',
      message: 'Download concluído',
    });
  }

  async function requestCatalog(url) {
    const event = assertFormatsResult(await nativeClient.request(HOST_COMMANDS.LIST_FORMATS, { url }));
    if (!url.endsWith(`v=${event.videoId}`)) invalid();
    const catalog = copyCatalog(event);
    catalogs.set(url, catalog);
    return copyCatalog(catalog);
  }

  async function catalogForStart(url) {
    const cached = catalogs.get(url);
    return cached ? copyCatalog(cached) : requestCatalog(url);
  }

  function startingSnapshot(event, context) {
    if (event.type !== 'jobStarted' || event.jobId !== event.job.jobId
      || event.job.height !== context.height
      || (event.job.videoId && event.job.videoId !== context.catalog.videoId)
      || (event.job.title && event.job.title !== context.catalog.title)) invalid();
    return {
      jobId: event.jobId,
      videoId: context.catalog.videoId,
      title: context.catalog.title,
      url: context.url,
      height: context.height,
      format: copyFormat(context.format),
      stage: event.job.stage,
      percent: event.job.percent,
      downloadedBytes: null,
      totalBytes: null,
      speedBytesPerSecond: null,
      etaSeconds: null,
      path: event.job.path,
      error: event.job.errorCode,
      updatedAt: 0,
    };
  }

  function progressValue(event, field, existing, advanced) {
    if (!Object.hasOwn(event, field)) return advanced ? null : existing;
    const incoming = event[field];
    if (advanced) return incoming;
    if (incoming === null) return existing;
    if ((field === 'percent' || field === 'downloadedBytes')
      && existing !== null && incoming < existing) return existing;
    return incoming;
  }

  async function applyEventLocked(event) {
    if (!isJobEvent(event)) return { notifyJobId: null };

    if (pendingStart && (!current || TERMINAL_STAGES.has(current.stage))
      && event.type !== 'jobStarted') {
      if (pendingStart.events.length < 64) pendingStart.events.push(event);
      return { notifyJobId: null };
    }
    if (event.type === 'jobStarted') return { notifyJobId: null };
    if (!current || !Object.hasOwn(event, 'jobId') || event.jobId !== current.jobId
      || TERMINAL_STAGES.has(current.stage)) return { notifyJobId: null };

    if (event.type === 'jobProgress') {
      if (!ACTIVE_STAGES.has(event.stage)) return { notifyJobId: null };
      const currentRank = STAGE_RANK[current.stage];
      const nextRank = STAGE_RANK[event.stage];
      if (nextRank < currentRank) return { notifyJobId: null };
      const advanced = nextRank > currentRank;
      if (!advanced && event.percent !== null && current.percent !== null
        && event.percent < current.percent) return { notifyJobId: null };
      await persistLocked({
        ...current,
        stage: event.stage,
        percent: progressValue(event, 'percent', current.percent, advanced),
        downloadedBytes: progressValue(event, 'downloadedBytes', current.downloadedBytes, advanced),
        totalBytes: progressValue(event, 'totalBytes', current.totalBytes, advanced),
        speedBytesPerSecond: progressValue(
          event, 'speedBytesPerSecond', current.speedBytesPerSecond, advanced,
        ),
        etaSeconds: progressValue(event, 'etaSeconds', current.etaSeconds, advanced),
        path: null,
        error: null,
      });
      return { notifyJobId: null };
    }

    pendingCancellations.delete(current.jobId);
    if (event.type === 'jobCompleted') {
      const jobId = current.jobId;
      await persistLocked({ ...current, stage: 'complete', percent: 100, path: event.path, error: null });
      return { notifyJobId: jobId };
    }
    if (event.type === 'jobCancelled') {
      await persistLocked({ ...current, stage: 'cancelled', error: null });
      return { notifyJobId: null };
    }
    if (event.type === 'jobFailed') {
      await persistLocked({ ...current, stage: 'failed', error: event.code });
    }
    return { notifyJobId: null };
  }

  async function handleStart(url, height) {
    const catalog = await catalogForStart(url);
    const format = catalog.qualities.find((quality) => quality.height === height);
    if (!format) invalid('Qualidade inválida');
    const destination = await resolveYouTubeDestination(nativeClient, storageLocal);
    if (destination.cancelled) {
      return { cancelled: true, code: 'DOWNLOAD_CANCELLED' };
    }
    const context = { url, height, catalog, format, events: [] };

    await serializedState(() => {
      if ((current && ACTIVE_STAGES.has(current.stage)) || pendingStart) {
        throw new Error('Já existe um download YouTube ativo.');
      }
      pendingStart = context;
    });

    let event;
    try {
      event = assertHostEvent(await nativeClient.request(HOST_COMMANDS.START_DOWNLOAD, {
        url,
        height,
        destinationFolder: destination.destinationFolder,
      }));
      if (event.type !== 'jobStarted') invalid();
    } catch (error) {
      await serializedState(() => {
        if (pendingStart === context) pendingStart = null;
      });
      throw error;
    }

    const result = await serializedState(async () => {
      if (pendingStart !== context) invalid();
      const buffered = context.events.splice(0);
      const snapshot = await persistLocked(startingSnapshot(event, context));
      pendingStart = null;
      let notifyJobId = null;
      for (const bufferedEvent of buffered) {
        const applied = await applyEventLocked(bufferedEvent);
        notifyJobId ??= applied.notifyJobId;
      }
      return { snapshot: copySnapshot(current ?? snapshot), notifyJobId };
    });
    if (result.notifyJobId) await notifyCompleted(result.notifyJobId);
    return result.snapshot;
  }

  async function handleCancel(jobId) {
    const shouldRequest = await serializedState(() => {
      if (!current || current.jobId !== jobId || !ACTIVE_STAGES.has(current.stage)) invalid();
      if (pendingCancellations.has(jobId)) return false;
      pendingCancellations.add(jobId);
      return true;
    });
    if (!shouldRequest) return { requested: true };
    try {
      await nativeClient.request(HOST_COMMANDS.CANCEL_DOWNLOAD, { jobId });
      return { requested: true };
    } catch (error) {
      await serializedState(() => pendingCancellations.delete(jobId));
      throw error;
    }
  }

  async function handleReveal(path) {
    const event = assertHostEvent(
      await nativeClient.request(HOST_COMMANDS.REVEAL_DOWNLOADED_FILE, { path }),
    );
    if (event.type !== HOST_EVENTS.FILE_REVEALED) invalid();
    return { revealed: true };
  }

  async function reconcileHostLocked(hostJob) {
    if (!current || !ACTIVE_STAGES.has(current.stage)) return;
    if (hostJob === null) {
      pendingCancellations.delete(current.jobId);
      await persistLocked({ ...current, stage: 'interrupted', error: 'NATIVE_JOB_MISSING' });
      return;
    }
    if (hostJob.jobId !== current.jobId || hostJob.height !== current.height) {
      pendingCancellations.delete(current.jobId);
      await persistLocked({ ...current, stage: 'interrupted', error: 'NATIVE_JOB_MISMATCH' });
      return;
    }

    if (ACTIVE_STAGES.has(hostJob.stage)) {
      const currentRank = STAGE_RANK[current.stage];
      const hostRank = STAGE_RANK[hostJob.stage];
      if (hostRank < currentRank) return;
      if (hostRank === currentRank && hostJob.percent !== null && current.percent !== null
        && hostJob.percent < current.percent) return;
      await persistLocked({
        ...current,
        stage: hostJob.stage,
        percent: hostJob.percent === null && hostRank === currentRank ? current.percent : hostJob.percent,
        downloadedBytes: hostRank === currentRank ? current.downloadedBytes : null,
        totalBytes: hostRank === currentRank ? current.totalBytes : null,
        speedBytesPerSecond: hostRank === currentRank ? current.speedBytesPerSecond : null,
        etaSeconds: hostRank === currentRank ? current.etaSeconds : null,
        path: null,
        error: null,
      });
      return;
    }

    pendingCancellations.delete(current.jobId);
    await persistLocked({
      ...current,
      stage: hostJob.stage,
      percent: hostJob.stage === 'complete' ? 100 : hostJob.percent,
      path: hostJob.path,
      error: hostJob.errorCode,
    });
  }

  async function initialize() {
    const stored = await storageLocal.get(STORAGE_KEY);
    if (!plainObject(stored) || !Object.hasOwn(stored, STORAGE_KEY)) return null;
    let snapshot;
    try {
      snapshot = sanitizeYouTubeJobSnapshot(stored[STORAGE_KEY]);
    } catch {
      await storageLocal.remove(STORAGE_KEY);
      return null;
    }
    await serializedState(() => { current = snapshot; });
    if (!ACTIVE_STAGES.has(snapshot.stage)) return copySnapshot(snapshot);

    let response;
    try {
      response = assertHostEvent(await nativeClient.request(HOST_COMMANDS.GET_JOB, {}));
      if (response.type !== 'ready' || !Object.hasOwn(response, 'job')) invalid();
    } catch (error) {
      await serializedState(async () => {
        if (current && ACTIVE_STAGES.has(current.stage)) {
          await persistLocked({ ...current, stage: 'interrupted', error: 'NATIVE_DISCONNECTED' });
        }
      });
      return copySnapshot(current);
    }
    await serializedState(() => reconcileHostLocked(response.job));
    return copySnapshot(current);
  }

  const ready = initialize();

  function handle(raw) {
    return serializedCommand(async () => {
      await ready;
      const message = assertExtensionMessage(raw);
      if (message.action === YOUTUBE_ACTIONS.LIST_FORMATS) return requestCatalog(message.url);
      if (message.action === YOUTUBE_ACTIONS.START_DOWNLOAD) return handleStart(message.url, message.height);
      if (message.action === YOUTUBE_ACTIONS.CANCEL_DOWNLOAD) return handleCancel(message.jobId);
      if (message.action === YOUTUBE_ACTIONS.REVEAL_DOWNLOADED_FILE) return handleReveal(message.path);
      return serializedState(() => copySnapshot(current));
    });
  }

  function handleHostEvent(raw) {
    if (raw?.type === 'nativeDisconnected') {
      return serializedState(async () => {
        if (!current || !ACTIVE_STAGES.has(current.stage)) return;
        pendingCancellations.delete(current.jobId);
        await persistLocked({ ...current, stage: 'interrupted', error: 'NATIVE_DISCONNECTED' });
      });
    }
    let event;
    try {
      event = assertHostEvent(raw);
    } catch (error) {
      return Promise.reject(error);
    }
    return serializedState(() => applyEventLocked(event)).then(async ({ notifyJobId }) => {
      if (notifyJobId) await notifyCompleted(notifyJobId);
    });
  }

  return Object.freeze({ ready, handle, handleHostEvent });
}
