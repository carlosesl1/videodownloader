import {
  HOST_COMMANDS,
  HOST_EVENTS,
  YOUTUBE_ACTIONS,
  assertDownloadSelection,
  assertFormatsResult,
  assertHostEvent,
} from '../youtube/protocol.js';
import {
  normalizeWindowsFolder,
  readDownloadPreferences,
} from '../shared/download-preferences.js';
import { assertJobSnapshot } from '../youtube/job-view.js';
import { canonicalMediaPage } from '../media/page-url.js';

const STORAGE_KEY = 'youtubeJob';
const START_INTENT_KEY = 'mediaStartIntent';
const ACTIVE_STAGES = new Set(['queued', 'running', 'preparing', 'video', 'audio', 'merge', 'finalize']);
const TERMINAL_STAGES = new Set(['complete', 'cancelled', 'failed', 'interrupted']);
const TERMINAL_JOB_EVENTS = new Set(['jobCompleted', 'jobCancelled', 'jobFailed']);
const STAGE_RANK = Object.freeze({ queued: -2, running: -1, preparing: 0, video: 1, audio: 2, merge: 3, finalize: 4 });
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SAFE_ERROR = /^[A-Za-z0-9_]{1,64}$/;
const CATALOG_TTL_MS = 30 * 60_000;
const MAX_CATALOGS = 50;
const MAX_PENDING_START_EVENTS = 64;
const SNAPSHOT_FIELDS = [
  'jobId', 'operationId', 'videoId', 'title', 'url', 'height', 'format',
  'stage', 'percent', 'downloadedBytes', 'totalBytes', 'speedBytesPerSecond', 'etaSeconds',
  'path', 'error', 'updatedAt',
];
const LEGACY_START_INTENT_FIELDS = [
  'operationId', 'url', 'height', 'destinationFolder', 'catalog', 'createdAt',
];
const LEGACY_START_INTENT_WITHOUT_CATALOG_FIELDS = LEGACY_START_INTENT_FIELDS
  .filter((field) => field !== 'catalog');
const START_INTENT_FIELDS = [
  'operationId', 'url', 'selection', 'destinationFolder', 'catalog', 'createdAt',
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

function copyQuality(format) {
  const base = copyFormat(format);
  if (!Object.hasOwn(format, 'fps')) return base;
  return {
    ...base,
    fps: format.fps,
    hdr: format.hdr,
    dynamicRange: format.dynamicRange,
    videoCodec: format.videoCodec,
    audioCodec: format.audioCodec,
    bitrateKbps: format.bitrateKbps,
    estimatedSizeBytes: format.estimatedSizeBytes,
    estimatedSizeApproximate: format.estimatedSizeApproximate,
  };
}

function copyCatalog(catalog) {
  return {
    ...(catalog.platform ? { platform: catalog.platform } : {}),
    videoId: catalog.videoId,
    title: catalog.title,
    durationSeconds: catalog.durationSeconds,
    qualities: catalog.qualities.map(copyQuality),
    ...(catalog.formats ? {
      formats: catalog.formats.map((format) => ({ ...format })),
      subtitles: catalog.subtitles.map((subtitle) => ({
        ...subtitle,
        containers: [...subtitle.containers],
      })),
      audioLanguages: [...catalog.audioLanguages],
    } : {}),
  };
}

function copySnapshot(snapshot) {
  if (snapshot === null) return null;
  return {
    ...snapshot,
    operationId: snapshot.operationId ?? null,
    format: copyFormat(snapshot.format),
  };
}

function createOperationId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `media-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function activeSnapshot(snapshot) {
  return Boolean(snapshot && ACTIVE_STAGES.has(snapshot.stage));
}

function legacyActiveSnapshot(snapshot) {
  return Boolean(snapshot && !['queued', 'running'].includes(snapshot.stage)
    && ACTIVE_STAGES.has(snapshot.stage));
}

function videoSelection(height) {
  return {
    height,
    audioOnly: false,
    subtitleLanguage: null,
    includeAutomaticSubtitles: false,
  };
}

function selectionForIntent(intent) {
  return intent.selection ?? videoSelection(intent.height);
}

function selectionsEqual(left, right) {
  return left?.height === right?.height
    && left?.audioOnly === right?.audioOnly
    && left?.subtitleLanguage === right?.subtitleLanguage
    && left?.includeAutomaticSubtitles === right?.includeAutomaticSubtitles;
}

function formatForSelection(catalog, selection) {
  if (!selection.audioOnly) {
    return catalog.qualities.find((quality) => quality.height === selection.height) ?? null;
  }
  const audio = catalog.formats?.filter((format) => format.audioOnly)
    .sort((left, right) => (right.bitrateKbps ?? 0) - (left.bitrateKbps ?? 0))[0];
  if (!audio) return null;
  return { height: 0, label: 'Somente áudio', container: 'm4a', combined: false };
}

function sanitizeSnapshotFormat(format, height) {
  if (!plainObject(format) || !hasOnlyKeys(format, ['height', 'label', 'container', 'combined'])
    || !Number.isSafeInteger(format.height) || format.height !== height
    || height < 0 || height > 4320
    || typeof format.label !== 'string' || !format.label.trim() || format.label.length > 128
    || typeof format.container !== 'string' || !/^(mp4|webm|m4a)$/i.test(format.container)
    || typeof format.combined !== 'boolean') invalid();
  return {
    height,
    label: format.label,
    container: format.container.toLowerCase(),
    combined: format.combined,
  };
}

function sanitizeStartIntent(value) {
  const rich = plainObject(value) && Object.hasOwn(value, 'selection');
  if (!plainObject(value)
    || (!hasOnlyKeys(value, START_INTENT_FIELDS)
      && !hasOnlyKeys(value, LEGACY_START_INTENT_FIELDS)
      && !hasOnlyKeys(value, LEGACY_START_INTENT_WITHOUT_CATALOG_FIELDS))
    || typeof value.operationId !== 'string'
    || !SAFE_ID.test(value.operationId)
    || !Number.isSafeInteger(value.createdAt)
    || value.createdAt < 0) invalid();
  const selection = rich
    ? assertDownloadSelection(value.selection)
    : assertDownloadSelection(videoSelection(value.height));
  const page = canonicalMediaPage(value.url);
  if (!page || page.canonicalUrl !== value.url) invalid();
  let destinationFolder;
  try {
    destinationFolder = normalizeWindowsFolder(value.destinationFolder);
  } catch {
    invalid();
  }
  if (destinationFolder !== value.destinationFolder) invalid();

  let catalog = null;
  if (Object.hasOwn(value, 'catalog')) {
    catalog = assertFormatsResult({
      type: HOST_EVENTS.FORMATS,
      requestId: 'start-intent',
      ...value.catalog,
    });
    if ((catalog.platform && catalog.platform !== page.platform)
      || (page.platform === 'youtube' && catalog.videoId !== page.mediaId)
      || !formatForSelection(catalog, selection)) invalid();
    catalog = copyCatalog(catalog);
  }
  return {
    operationId: value.operationId,
    url: page.canonicalUrl,
    ...(rich ? { selection } : { height: selection.height }),
    destinationFolder,
    catalog,
    createdAt: value.createdAt,
  };
}

/** Validates the only durable YouTube record and returns its fixed public shape. */
export function sanitizeYouTubeJobSnapshot(value) {
  const legacyFields = SNAPSHOT_FIELDS.filter((field) => field !== 'operationId');
  if (!plainObject(value)
    || (!hasOnlyKeys(value, SNAPSHOT_FIELDS) && !hasOnlyKeys(value, legacyFields))) invalid();
  const {
    jobId, operationId = null, videoId, title, url, height, format, stage, percent,
    downloadedBytes, totalBytes, speedBytesPerSecond, etaSeconds,
    path, error, updatedAt,
  } = value;

  const core = assertJobSnapshot({
    jobId, operationId, videoId, title, height, stage, percent, path, errorCode: error,
  });
  const page = canonicalMediaPage(url);
  if (!videoId || !title || !page || page.canonicalUrl !== url
    || (page.platform === 'youtube' && page.mediaId !== videoId)) invalid();
  if (!(percent === null || (Number.isSafeInteger(percent) && percent >= 0 && percent <= 100))) invalid();
  if (![downloadedBytes, totalBytes, speedBytesPerSecond, etaSeconds].every(nullableNonnegativeInteger)) invalid();
  if (!(error === null || (typeof error === 'string' && SAFE_ERROR.test(error)))) invalid();
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) invalid();
  const validatedFormat = sanitizeSnapshotFormat(format, height);

  return {
    jobId: core.jobId,
    operationId: core.operationId ?? null,
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
    const page = canonicalMediaPage(message.payload.url);
    if (!page) invalid();
    return { action: message.action, url: page.canonicalUrl };
  }
  if (message.action === YOUTUBE_ACTIONS.START_DOWNLOAD) {
    const rich = plainObject(message.payload) && Object.hasOwn(message.payload, 'selection');
    assertPayload(message.payload, rich ? ['url', 'selection'] : ['url', 'height']);
    const page = canonicalMediaPage(message.payload.url);
    const selection = rich
      ? assertDownloadSelection(message.payload.selection)
      : assertDownloadSelection(videoSelection(message.payload.height));
    if (!page) invalid();
    return {
      action: message.action,
      url: page.canonicalUrl,
      selection,
      legacy: !rich,
    };
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

function isTerminalJobEvent(event) {
  return Object.hasOwn(event, 'jobId') && TERMINAL_JOB_EVENTS.has(event.type);
}

function bufferPendingStartEvent(events, event) {
  if (events.length < MAX_PENDING_START_EVENTS) {
    events.push(event);
    return;
  }
  if (isTerminalJobEvent(event)) {
    const duplicate = events.findIndex((candidate) => (
      isTerminalJobEvent(candidate) && candidate.jobId === event.jobId
    ));
    if (duplicate >= 0) {
      events[duplicate] = event;
      return;
    }
    const replaceable = events.findIndex((candidate) => !isTerminalJobEvent(candidate));
    if (replaceable >= 0) {
      events[replaceable] = event;
      return;
    }
    events.shift();
    events.push(event);
    return;
  }
  const replaceable = events.findLastIndex((candidate) => !isTerminalJobEvent(candidate));
  if (replaceable >= 0) events[replaceable] = event;
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

export function createYouTubeCoordinator({
  nativeClient,
  storageLocal,
  notifications,
  now,
  createStartOperationId = createOperationId,
  onQueueEvent = () => {},
}) {
  if (typeof nativeClient?.request !== 'function'
    || typeof storageLocal?.get !== 'function'
    || typeof storageLocal?.set !== 'function'
    || typeof storageLocal?.remove !== 'function'
    || typeof now !== 'function'
    || typeof createStartOperationId !== 'function'
    || typeof onQueueEvent !== 'function') {
    throw new TypeError('Dependências inválidas do coordenador YouTube.');
  }

  let current = null;
  let pendingStart = null;
  let unresolvedStartIntent = null;
  const pendingCancellations = new Set();
  const catalogs = new Map();
  let stateQueue = Promise.resolve();
  let commandQueue = Promise.resolve();

  function updateNativeKeepAlive() {
    if (typeof nativeClient.setKeepAlive !== 'function') return;
    nativeClient.setKeepAlive(
      'media-job',
      legacyActiveSnapshot(current) || Boolean(pendingStart) || Boolean(unresolvedStartIntent),
    );
  }

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
    updateNativeKeepAlive();
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
    const page = canonicalMediaPage(url);
    if (!page || page.canonicalUrl !== url) invalid();
    const event = assertFormatsResult(await nativeClient.request(HOST_COMMANDS.LIST_FORMATS, { url }));
    if ((event.platform && event.platform !== page.platform)
      || (page.platform === 'youtube' && page.mediaId !== event.videoId)) invalid();
    const catalog = copyCatalog(event);
    catalogs.delete(url);
    catalogs.set(url, { catalog, expiresAt: timestamp() + CATALOG_TTL_MS });
    while (catalogs.size > MAX_CATALOGS) catalogs.delete(catalogs.keys().next().value);
    return copyCatalog(catalog);
  }

  async function catalogForStart(url) {
    const cached = catalogs.get(url);
    if (!cached || cached.expiresAt <= timestamp()) {
      catalogs.delete(url);
      return requestCatalog(url);
    }
    catalogs.delete(url);
    catalogs.set(url, cached);
    return copyCatalog(cached.catalog);
  }

  function startingSnapshot(event, context) {
    if (!['jobStarted', 'jobQueued'].includes(event.type)
      || event.jobId !== event.job.jobId
      || (event.job.operationId ?? event.operationId) !== context.operationId
      || (event.job.selection
        ? !selectionsEqual(event.job.selection, context.selection)
        : event.job.height !== context.height)
      || (event.job.videoId && event.job.videoId !== context.catalog.videoId)
      || (event.job.title && event.job.title !== context.catalog.title)) invalid();
    return {
      jobId: event.jobId,
      operationId: context.operationId,
      videoId: context.catalog.videoId,
      title: context.catalog.title,
      url: context.url,
      height: context.height,
      format: copyFormat(context.format),
      stage: event.job.stage === 'download' ? 'video' : event.job.stage,
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

  async function clearStartIntent(intent) {
    await storageLocal.remove(START_INTENT_KEY);
    if (unresolvedStartIntent?.operationId === intent.operationId) {
      unresolvedStartIntent = null;
      updateNativeKeepAlive();
    }
  }

  async function queryStartIntent(intent, requestId = 'reconcile-intent') {
    if (Object.hasOwn(intent, 'selection')) {
      const response = assertHostEvent(await nativeClient.request(HOST_COMMANDS.LIST_QUEUE, {}));
      if (response.type !== HOST_EVENTS.QUEUE_SNAPSHOT) invalid();
      onQueueEvent(response);
      const job = response.jobs.find((candidate) => candidate.operationId === intent.operationId);
      if (!job) {
        await clearStartIntent(intent);
        return null;
      }
      return {
        type: HOST_EVENTS.JOB_QUEUED,
        requestId: typeof requestId === 'string' && SAFE_ID.test(requestId)
          ? requestId
          : 'reconcile-intent',
        jobId: job.jobId,
        operationId: job.operationId,
        job,
      };
    }
    const response = assertHostEvent(await nativeClient.request(HOST_COMMANDS.GET_JOB, {}));
    if (response.type !== HOST_EVENTS.READY) invalid();
    if (response.job?.operationId !== intent.operationId) {
      await clearStartIntent(intent);
      return null;
    }
    return {
      type: HOST_EVENTS.JOB_STARTED,
      requestId: typeof requestId === 'string' && SAFE_ID.test(requestId)
        ? requestId
        : 'reconcile-intent',
      jobId: response.job.jobId,
      job: response.job,
    };
  }

  async function reconcileUnresolvedStartIntent() {
    const intent = unresolvedStartIntent;
    if (!intent) return { state: 'none', snapshot: null };

    const alreadyPersisted = await serializedState(() => (
      current?.operationId === intent.operationId ? copySnapshot(current) : null
    ));
    if (alreadyPersisted) {
      await clearStartIntent(intent);
      return {
        state: 'adopted',
        snapshot: await serializedState(() => copySnapshot(current)),
      };
    }

    const event = await queryStartIntent(intent);
    if (!event) return { state: 'absent', snapshot: null };
    const catalog = intent.catalog ?? await catalogForStart(intent.url);
    const selection = selectionForIntent(intent);
    const format = formatForSelection(catalog, selection);
    if (!format) invalid('Qualidade inválida');
    const snapshot = await serializedState(() => persistLocked(startingSnapshot(event, {
      ...intent,
      selection,
      height: selection.height ?? 0,
      catalog,
      format,
    })));
    await clearStartIntent(intent);
    return {
      state: 'adopted',
      snapshot: await serializedState(() => copySnapshot(current ?? snapshot)),
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
      bufferPendingStartEvent(pendingStart.events, event);
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

  async function handleStart(url, selection, legacy = false) {
    await reconcileUnresolvedStartIntent();
    await serializedState(() => {
      if ((legacy && current && ACTIVE_STAGES.has(current.stage)) || pendingStart) {
        throw new Error('Já existe um download YouTube ativo.');
      }
    });
    const catalog = await catalogForStart(url);
    const format = formatForSelection(catalog, selection);
    if (!format) invalid('Qualidade inválida');
    const destination = await resolveYouTubeDestination(nativeClient, storageLocal);
    if (destination.cancelled) {
      return { cancelled: true, code: 'DOWNLOAD_CANCELLED' };
    }
    const operationId = createStartOperationId();
    if (typeof operationId !== 'string' || !SAFE_ID.test(operationId)) invalid();
    const height = selection.height ?? 0;
    const context = {
      operationId, url, height, selection, catalog, format, events: [], legacy,
    };
    const intent = {
      operationId,
      url,
      ...(legacy ? { height } : { selection: { ...selection } }),
      destinationFolder: destination.destinationFolder,
      catalog: copyCatalog(catalog),
      createdAt: timestamp(),
    };

    await serializedState(() => {
      if ((legacy && current && ACTIVE_STAGES.has(current.stage)) || pendingStart) {
        throw new Error('Já existe um download YouTube ativo.');
      }
      pendingStart = context;
      updateNativeKeepAlive();
    });

    try {
      await storageLocal.set({
        [START_INTENT_KEY]: intent,
      });
      unresolvedStartIntent = intent;
      updateNativeKeepAlive();
    } catch (error) {
      await serializedState(() => {
        if (pendingStart === context) pendingStart = null;
        updateNativeKeepAlive();
      });
      throw error;
    }

    let event;
    try {
      event = assertHostEvent(await nativeClient.request(HOST_COMMANDS.START_DOWNLOAD, {
        operationId,
        url,
        ...(legacy ? { height } : { selection: { ...selection } }),
        ...(!legacy ? { media: { videoId: catalog.videoId, title: catalog.title } } : {}),
        destinationFolder: destination.destinationFolder,
      }));
      if (event.type !== (legacy ? HOST_EVENTS.JOB_STARTED : HOST_EVENTS.JOB_QUEUED)) invalid();
    } catch (error) {
      try {
        event = await queryStartIntent(intent, error?.requestId);
      } catch {
        // The durable intent remains authoritative until a conclusive host response.
      }
      if (event) {
        // Adopted after an ambiguous transport/result failure; use the normal commit below.
      } else {
        await serializedState(() => {
          if (pendingStart === context) pendingStart = null;
          updateNativeKeepAlive();
        });
        throw error;
      }
    }

    if (!legacy) {
      try { onQueueEvent(event); } catch {
        // The durable queue is refreshed from the host if a local observer rejects the update.
      }
    }

    let result;
    try {
      result = await serializedState(async () => {
        if (pendingStart !== context) invalid();
        const buffered = context.events.splice(0);
        const snapshot = await persistLocked(startingSnapshot(event, context));
        pendingStart = null;
        updateNativeKeepAlive();
        let notifyJobId = null;
        for (const bufferedEvent of buffered) {
          const applied = await applyEventLocked(bufferedEvent);
          notifyJobId ??= applied.notifyJobId;
        }
        return { snapshot: copySnapshot(current ?? snapshot), notifyJobId };
      });
    } catch (error) {
      await serializedState(() => {
        if (pendingStart === context) pendingStart = null;
        updateNativeKeepAlive();
      });
      throw error;
    }
    await clearStartIntent(intent);
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
      const event = assertHostEvent(
        await nativeClient.request(HOST_COMMANDS.CANCEL_DOWNLOAD, { jobId }),
      );
      if (event.type !== HOST_EVENTS.JOB_CANCELLED) invalid();
      await handleHostEvent(event);
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
    if (current.operationId && hostJob.operationId !== current.operationId) {
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
        operationId: current.operationId ?? hostJob.operationId ?? null,
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
      operationId: current.operationId ?? hostJob.operationId ?? null,
      stage: hostJob.stage,
      percent: hostJob.stage === 'complete' ? 100 : hostJob.percent,
      path: hostJob.path,
      error: hostJob.errorCode,
    });
  }

  async function reconcileQueueCurrent() {
    const local = await serializedState(() => copySnapshot(current));
    if (!local || !['queued', 'running'].includes(local.stage)) return local;
    const response = assertHostEvent(await nativeClient.request(HOST_COMMANDS.LIST_QUEUE, {}));
    if (response.type !== HOST_EVENTS.QUEUE_SNAPSHOT) invalid();
    try { onQueueEvent(response); } catch {
      // The queue stays authoritative even if a local observer cannot consume this refresh.
    }
    const queued = response.jobs.find((job) => job.operationId === local.operationId);
    if (!queued) {
      return serializedState(() => persistLocked({
        ...current,
        stage: 'interrupted',
        error: 'NATIVE_JOB_MISSING',
      }));
    }
    return serializedState(() => persistLocked({
      ...current,
      jobId: queued.jobId,
      videoId: queued.videoId || current.videoId,
      title: queued.title || current.title,
      stage: queued.stage,
      percent: queued.percent,
      downloadedBytes: queued.downloadedBytes,
      totalBytes: queued.totalBytes,
      speedBytesPerSecond: queued.speedBytesPerSecond,
      etaSeconds: queued.etaSeconds,
      path: queued.path,
      error: queued.errorCode,
    }));
  }

  async function initialize() {
    const stored = await storageLocal.get([STORAGE_KEY, START_INTENT_KEY]);
    let adoptedIntent = false;
    if (plainObject(stored) && Object.hasOwn(stored, START_INTENT_KEY)) {
      let intent = null;
      if (!plainObject(stored[START_INTENT_KEY])) {
        await storageLocal.remove(START_INTENT_KEY);
      } else {
        try {
          intent = sanitizeStartIntent(stored[START_INTENT_KEY]);
        } catch {
          await storageLocal.remove(START_INTENT_KEY);
        }
      }
      if (intent) {
        unresolvedStartIntent = intent;
        updateNativeKeepAlive();
        try {
          const reconciled = await reconcileUnresolvedStartIntent();
          adoptedIntent = reconciled.state === 'adopted';
        } catch {
          // A transport failure is inconclusive; retain the durable intent for the next wake-up.
        }
      }
    }
    if (adoptedIntent) return copySnapshot(current);
    if (!plainObject(stored) || !Object.hasOwn(stored, STORAGE_KEY)) {
      updateNativeKeepAlive();
      return copySnapshot(current);
    }
    let snapshot;
    try {
      snapshot = sanitizeYouTubeJobSnapshot(stored[STORAGE_KEY]);
    } catch {
      await storageLocal.remove(STORAGE_KEY);
      return null;
    }
    await serializedState(() => { current = snapshot; });
    updateNativeKeepAlive();
    if (unresolvedStartIntent) return copySnapshot(snapshot);
    if (!ACTIVE_STAGES.has(snapshot.stage)) return copySnapshot(snapshot);
    if (['queued', 'running'].includes(snapshot.stage)) {
      try {
        return await reconcileQueueCurrent();
      } catch {
        return copySnapshot(current);
      }
    }

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
    const execute = async () => {
      await ready;
      const message = assertExtensionMessage(raw);
      if (message.action === YOUTUBE_ACTIONS.LIST_FORMATS) return requestCatalog(message.url);
      if (message.action === YOUTUBE_ACTIONS.START_DOWNLOAD) {
        return handleStart(message.url, message.selection, message.legacy);
      }
      if (message.action === YOUTUBE_ACTIONS.CANCEL_DOWNLOAD) return handleCancel(message.jobId);
      if (message.action === YOUTUBE_ACTIONS.REVEAL_DOWNLOADED_FILE) return handleReveal(message.path);
      const recovered = await reconcileUnresolvedStartIntent();
      if (recovered.state === 'adopted') return recovered.snapshot;
      const local = await serializedState(() => copySnapshot(current));
      if (!activeSnapshot(local)) return local;
      if (['queued', 'running'].includes(local.stage)) return reconcileQueueCurrent();
      const response = assertHostEvent(await nativeClient.request(HOST_COMMANDS.GET_JOB, {}));
      if (response.type === HOST_EVENTS.READY) {
        await serializedState(() => reconcileHostLocked(response.job));
      }
      return serializedState(() => copySnapshot(current));
    };
    const action = raw?.action;
    if (action === YOUTUBE_ACTIONS.CANCEL_DOWNLOAD) return execute();
    return serializedCommand(execute);
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
