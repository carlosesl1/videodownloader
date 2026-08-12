import { assertJobSnapshot } from './job-view.js';
import { normalizeWindowsFolder } from '../shared/download-preferences.js';

export const NATIVE_HOST = 'com.videoradar.helper';
export const MIN_NATIVE_PROTOCOL_VERSION = 5;
export const YOUTUBE_ACTIONS = Object.freeze({
  LIST_FORMATS: 'YOUTUBE_LIST_FORMATS', START_DOWNLOAD: 'YOUTUBE_START_DOWNLOAD',
  CANCEL_DOWNLOAD: 'YOUTUBE_CANCEL_DOWNLOAD', PAUSE_DOWNLOAD: 'YOUTUBE_PAUSE_DOWNLOAD',
  RESUME_DOWNLOAD: 'YOUTUBE_RESUME_DOWNLOAD', GET_QUEUE: 'YOUTUBE_GET_QUEUE',
  GET_JOB: 'YOUTUBE_GET_JOB',
  REVEAL_DOWNLOADED_FILE: 'YOUTUBE_REVEAL_DOWNLOADED_FILE',
});
export const HOST_COMMANDS = Object.freeze({
  PING: 'ping',
  LIST_FORMATS: 'listFormats',
  START_DOWNLOAD: 'startDownload',
  CANCEL_DOWNLOAD: 'cancelDownload',
  PAUSE_DOWNLOAD: 'pauseDownload',
  RESUME_DOWNLOAD: 'resumeDownload',
  LIST_QUEUE: 'listQueue',
  GET_JOB: 'getJob',
  CHOOSE_DOWNLOAD_FOLDER: 'chooseDownloadFolder',
  MOVE_DOWNLOADED_FILE: 'moveDownloadedFile',
  REVEAL_DOWNLOADED_FILE: 'revealDownloadedFile',
  GET_DIAGNOSTICS: 'getDiagnostics',
  SET_DIAGNOSTICS: 'setDiagnostics',
  EXPORT_DIAGNOSTICS: 'exportDiagnostics',
  CLEAR_DIAGNOSTICS: 'clearDiagnostics',
});
export const HOST_EVENTS = Object.freeze({
  READY: 'ready',
  FORMATS: 'formats',
  JOB_STARTED: 'jobStarted',
  JOB_QUEUED: 'jobQueued',
  JOB_PAUSED: 'jobPaused',
  JOB_PROGRESS: 'jobProgress',
  JOB_COMPLETED: 'jobCompleted',
  JOB_CANCELLED: 'jobCancelled',
  JOB_FAILED: 'jobFailed',
  QUEUE_SNAPSHOT: 'queueSnapshot',
  FOLDER_SELECTED: 'folderSelected',
  FOLDER_SELECTION_CANCELLED: 'folderSelectionCancelled',
  FILE_MOVED: 'fileMoved',
  FILE_REVEALED: 'fileRevealed',
  DIAGNOSTICS: 'diagnostics',
  DIAGNOSTICS_EXPORTED: 'diagnosticsExported',
  DIAGNOSTICS_CLEARED: 'diagnosticsCleared',
});

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MEDIA_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const PLATFORMS = new Set(['youtube', 'tiktok', 'instagram', 'x']);
const SAFE_CODE = /^[A-Z0-9_]{1,64}$/;
const STAGES = new Set([
  'queued', 'running', 'paused', 'preparing', 'download', 'video', 'audio', 'merge', 'finalize',
  'complete', 'cancelled', 'failed', 'interrupted',
]);
const QUEUE_STATES = new Set(['queued', 'running', 'paused', 'complete', 'failed', 'cancelled']);
const ALLOWED_HOST_EVENTS = new Set(Object.values(HOST_EVENTS));

function queueStateMatchesStage(state, stage) {
  if (state === 'running') {
    return ['running', 'preparing', 'video', 'audio', 'merge', 'finalize'].includes(stage);
  }
  return state === stage;
}

function invalid() { throw new Error('Mensagem inválida'); }
function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function hasOnlyKeys(value, expected) {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}
function id(value) { return typeof value === 'string' && SAFE_ID.test(value); }
function text(value, maximum, empty = false) { return typeof value === 'string' && value.length <= maximum && (empty || value.length > 0); }
function finiteInteger(value, min = 0, max = Number.MAX_SAFE_INTEGER) { return Number.isSafeInteger(value) && value >= min && value <= max; }
function optionalNumber(value, minimum = 0) { return value === null || (typeof value === 'number' && Number.isFinite(value) && finiteInteger(value, minimum)); }
function nullableText(value, maximum) { return value === null || text(value, maximum); }
function nullableFinite(value, minimum = 0, maximum = Number.MAX_VALUE) {
  return value === null || (typeof value === 'number' && Number.isFinite(value)
    && value >= minimum && value <= maximum);
}
function safeDetail(value, depth = 0) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return text(value, 256, true) ? value : undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (depth >= 4) return undefined;
  if (Array.isArray(value)) {
    if (value.length > 32) return undefined;
    const array = value.map((entry) => safeDetail(entry, depth + 1));
    return array.some((entry) => entry === undefined) ? undefined : array;
  }
  if (!plainObject(value) || Object.keys(value).length > 16) return undefined;
  const output = {};
  for (const key of Object.keys(value)) {
    if (!text(key, 64) || key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
    const entry = safeDetail(value[key], depth + 1);
    if (entry === undefined) return undefined;
    output[key] = entry;
  }
  return output;
}
function boundedDetails(value) {
  const safe = safeDetail(value);
  if (safe === undefined || !plainObject(safe)) return null;
  try { return JSON.stringify(safe).length <= 4096 ? safe : null; } catch { return null; }
}
function outputOptional(event, key, predicate) {
  if (!Object.hasOwn(event, key)) return {};
  if (!predicate(event[key])) invalid();
  return { [key]: event[key] };
}

function exactEvent(event, keys) {
  if (Object.keys(event).length !== keys.length || keys.some((key) => !Object.hasOwn(event, key))) invalid();
  return Object.fromEntries(keys.map((key) => [key, event[key]]));
}

function assertWindowsAbsolutePath(value) {
  if (!text(value, 1024)) invalid();
  let normalized;
  try {
    normalized = normalizeWindowsFolder(value);
  } catch {
    invalid();
  }
  if (normalized !== value) invalid();
  return value;
}

export function hostCommand(type, requestId, payload = {}) {
  if (!Object.values(HOST_COMMANDS).includes(type) || !id(requestId) || !plainObject(payload)) invalid();
  try { if (JSON.stringify(payload).length > 16 * 1024) invalid(); } catch { invalid(); }
  return { type, requestId, payload };
}

const LEGACY_QUALITY_FIELDS = ['height', 'label', 'container', 'combined'];
const RICH_QUALITY_FIELDS = [
  ...LEGACY_QUALITY_FIELDS,
  'fps', 'hdr', 'dynamicRange', 'videoCodec', 'audioCodec', 'bitrateKbps',
  'estimatedSizeBytes', 'estimatedSizeApproximate',
];
const FORMAT_FIELDS = [
  'formatId', 'height', 'container', 'combined', 'audioOnly', 'fps', 'hdr',
  'dynamicRange', 'videoCodec', 'audioCodec', 'bitrateKbps', 'fileSizeBytes',
  'fileSizeApproximate', 'language',
];
const SUBTITLE_FIELDS = ['language', 'label', 'automatic', 'containers'];

function assertQuality(value, previousHeight, heights) {
  if (!plainObject(value) || !finiteInteger(value.height, 1, 4320) || value.height >= previousHeight || heights.has(value.height)
    || !text(value.label, 128) || typeof value.container !== 'string' || !/^(mp4|webm)$/i.test(value.container)
    || typeof value.combined !== 'boolean'
    || (!hasOnlyKeys(value, LEGACY_QUALITY_FIELDS) && !hasOnlyKeys(value, RICH_QUALITY_FIELDS))) invalid();
  heights.add(value.height);
  const base = {
    height: value.height,
    label: value.label,
    container: value.container.toLowerCase(),
    combined: value.combined,
  };
  if (hasOnlyKeys(value, LEGACY_QUALITY_FIELDS)) return base;
  if (!nullableFinite(value.fps, 1, 1000)
    || typeof value.hdr !== 'boolean'
    || !nullableText(value.dynamicRange, 64)
    || !nullableText(value.videoCodec, 128)
    || !nullableText(value.audioCodec, 128)
    || !nullableFinite(value.bitrateKbps, 0, 10_000_000)
    || !optionalNumber(value.estimatedSizeBytes)
    || typeof value.estimatedSizeApproximate !== 'boolean') invalid();
  return {
    ...base,
    fps: value.fps,
    hdr: value.hdr,
    dynamicRange: value.dynamicRange,
    videoCodec: value.videoCodec,
    audioCodec: value.audioCodec,
    bitrateKbps: value.bitrateKbps,
    estimatedSizeBytes: value.estimatedSizeBytes,
    estimatedSizeApproximate: value.estimatedSizeApproximate,
  };
}

function assertFormat(value) {
  if (!plainObject(value) || !hasOnlyKeys(value, FORMAT_FIELDS)
    || !(value.formatId === null || text(value.formatId, 128))
    || !(value.height === null || finiteInteger(value.height, 1, 4320))
    || !text(value.container, 16)
    || !/^[A-Za-z0-9]+$/.test(value.container)
    || typeof value.combined !== 'boolean'
    || typeof value.audioOnly !== 'boolean'
    || !nullableFinite(value.fps, 1, 1000)
    || typeof value.hdr !== 'boolean'
    || !nullableText(value.dynamicRange, 64)
    || !nullableText(value.videoCodec, 128)
    || !nullableText(value.audioCodec, 128)
    || !nullableFinite(value.bitrateKbps, 0, 10_000_000)
    || !optionalNumber(value.fileSizeBytes)
    || typeof value.fileSizeApproximate !== 'boolean'
    || !nullableText(value.language, 64)) invalid();
  if (value.audioOnly && value.height !== null) invalid();
  return { ...value, container: value.container.toLowerCase() };
}

function assertSubtitle(value) {
  if (!plainObject(value) || !hasOnlyKeys(value, SUBTITLE_FIELDS)
    || !text(value.language, 64)
    || !/^[A-Za-z0-9]{1,8}(?:-[A-Za-z0-9]{1,8}){0,3}$/.test(value.language)
    || !nullableText(value.label, 128)
    || typeof value.automatic !== 'boolean'
    || !Array.isArray(value.containers)
    || value.containers.length > 16
    || value.containers.some((container) => !text(container, 16)
      || !/^[A-Za-z0-9]+$/.test(container))) invalid();
  return { ...value, containers: [...value.containers] };
}

function assertFormats(event) {
  const hasPlatform = Object.hasOwn(event, 'platform');
  const hasRichCatalog = Object.hasOwn(event, 'formats')
    || Object.hasOwn(event, 'subtitles')
    || Object.hasOwn(event, 'audioLanguages');
  if ((hasPlatform && !PLATFORMS.has(event.platform))
    || typeof event.videoId !== 'string' || !MEDIA_ID.test(event.videoId)
    || !text(event.title, 512) || !(event.durationSeconds === null || (typeof event.durationSeconds === 'number' && Number.isFinite(event.durationSeconds) && event.durationSeconds >= 0))
    || !Array.isArray(event.qualities) || event.qualities.length > 32) invalid();
  const heights = new Set(); let previous = Infinity;
  const qualities = event.qualities.map((quality) => {
    const parsed = assertQuality(quality, previous, heights); previous = parsed.height; return parsed;
  });
  const output = {
    type: HOST_EVENTS.FORMATS,
    requestId: event.requestId,
    ...(hasPlatform ? { platform: event.platform } : {}),
    videoId: event.videoId,
    title: event.title,
    durationSeconds: event.durationSeconds,
    qualities,
  };
  if (!hasRichCatalog) return output;
  if (!Object.hasOwn(event, 'formats') || !Object.hasOwn(event, 'subtitles')
    || !Object.hasOwn(event, 'audioLanguages')
    || !Array.isArray(event.formats) || event.formats.length > 256
    || !Array.isArray(event.subtitles) || event.subtitles.length > 128
    || !Array.isArray(event.audioLanguages) || event.audioLanguages.length > 64) invalid();
  const formats = event.formats.map(assertFormat);
  const subtitles = event.subtitles.map(assertSubtitle);
  const audioLanguages = event.audioLanguages.map((language) => {
    if (!text(language, 64)
      || !/^[A-Za-z0-9]{1,8}(?:-[A-Za-z0-9]{1,8}){0,3}$/.test(language)) invalid();
    return language;
  });
  if (new Set(audioLanguages.map((language) => language.toLowerCase())).size
    !== audioLanguages.length) invalid();
  return { ...output, formats, subtitles, audioLanguages };
}

function assertDiagnosticTool(value) {
  if (!plainObject(value)
    || !text(value.name, 64)
    || !/^[A-Za-z0-9._-]+$/.test(value.name)
    || typeof value.available !== 'boolean'
    || !(value.version === null || text(value.version, 96))
    || !optionalNumber(value.sizeBytes)
    || !(value.sha256 === null
      || (typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256)))) invalid();
  return exactEvent(value, ['name', 'available', 'version', 'sizeBytes', 'sha256']);
}

function assertDiagnostics(event) {
  const value = exactEvent(event, [
    'type', 'requestId', 'generatedAt', 'hostVersion', 'protocolVersion', 'architecture',
    'operatingSystem', 'availableBytes', 'loggingEnabled', 'logFileCount', 'tools',
  ]);
  if (!text(value.generatedAt, 64) || Number.isNaN(Date.parse(value.generatedAt))
    || !text(value.hostVersion, 64)
    || !finiteInteger(value.protocolVersion, MIN_NATIVE_PROTOCOL_VERSION, 999)
    || !['x64', 'arm64'].includes(value.architecture)
    || !text(value.operatingSystem, 160)
    || !optionalNumber(value.availableBytes)
    || typeof value.loggingEnabled !== 'boolean'
    || !finiteInteger(value.logFileCount, 0, 8)
    || !Array.isArray(value.tools)
    || value.tools.length > 8) invalid();
  return { ...value, tools: value.tools.map(assertDiagnosticTool) };
}

export function assertDownloadSelection(value) {
  const fields = ['height', 'audioOnly', 'subtitleLanguage', 'includeAutomaticSubtitles'];
  if (!plainObject(value) || !hasOnlyKeys(value, fields)
    || !(value.height === null || finiteInteger(value.height, 144, 4320))
    || typeof value.audioOnly !== 'boolean'
    || !(value.subtitleLanguage === null
      || (text(value.subtitleLanguage, 64)
        && /^[A-Za-z0-9]{1,8}(?:-[A-Za-z0-9]{1,8}){0,3}$/.test(value.subtitleLanguage)))
    || typeof value.includeAutomaticSubtitles !== 'boolean'
    || value.audioOnly !== (value.height === null)
    || (value.audioOnly && value.subtitleLanguage !== null)
    || (value.includeAutomaticSubtitles && value.subtitleLanguage === null)) invalid();
  return { ...value };
}

const QUEUE_ITEM_FIELDS = [
  'jobId', 'operationId', 'url', 'selection', 'destinationFolder', 'state', 'stage',
  'percent', 'path', 'errorCode', 'resumePartial', 'attemptCount', 'position',
  'createdAt', 'updatedAt',
];
const QUEUE_ITEM_MEDIA_FIELDS = [
  'jobId', 'operationId', 'url', 'selection', 'destinationFolder', 'state',
  'videoId', 'title', 'stage', 'percent', 'downloadedBytes', 'totalBytes',
  'speedBytesPerSecond', 'etaSeconds', 'path', 'errorCode', 'resumePartial',
  'attemptCount', 'position', 'createdAt', 'updatedAt',
];

function assertQueueItem(value) {
  const normalizedStage = value?.stage === 'download' ? 'video' : value?.stage;
  if (!plainObject(value)
    || (!hasOnlyKeys(value, QUEUE_ITEM_FIELDS) && !hasOnlyKeys(value, QUEUE_ITEM_MEDIA_FIELDS))
    || !id(value.jobId) || !id(value.operationId)
    || !text(value.url, 8192)
    || !QUEUE_STATES.has(value.state)
    || !text(value.stage, 64) || !STAGES.has(value.stage)
    || !queueStateMatchesStage(value.state, normalizedStage)
    || !(value.percent === null || finiteInteger(value.percent, 0, 100))
    || !(value.destinationFolder === null || text(value.destinationFolder, 1024))
    || !(value.path === null || text(value.path, 1024))
    || !(value.errorCode === null || (typeof value.errorCode === 'string' && SAFE_CODE.test(value.errorCode)))
    || typeof value.resumePartial !== 'boolean'
    || !finiteInteger(value.attemptCount, 0, 100)
    || !(value.position === null || finiteInteger(value.position, 1, 32))
    || !text(value.createdAt, 64) || Number.isNaN(Date.parse(value.createdAt))
    || !text(value.updatedAt, 64) || Number.isNaN(Date.parse(value.updatedAt))) invalid();
  if ((value.state === 'complete'
      && (value.path === null || value.percent !== 100 || value.errorCode !== null))
    || (value.state === 'failed' && value.errorCode === null)
    || (value.state !== 'failed' && value.errorCode !== null)
    || (value.state !== 'complete' && value.path !== null)) invalid();
  let url;
  try { url = new URL(value.url); } catch { invalid(); }
  if (url.protocol !== 'https:' || url.href !== value.url) invalid();
  if (value.destinationFolder !== null) assertWindowsAbsolutePath(value.destinationFolder);
  if (value.path !== null) assertWindowsAbsolutePath(value.path);
  const output = {
    ...value,
    stage: normalizedStage,
    selection: assertDownloadSelection(value.selection),
  };
  if (hasOnlyKeys(value, QUEUE_ITEM_MEDIA_FIELDS)) {
    if (!text(value.videoId, 128, true) || (value.videoId && !MEDIA_ID.test(value.videoId))
      || !text(value.title, 512, true)
      || ![value.downloadedBytes, value.totalBytes, value.speedBytesPerSecond, value.etaSeconds]
        .every((entry) => optionalNumber(entry))) invalid();
  }
  return output;
}

function assertQueueEvent(event) {
  if (event.type === HOST_EVENTS.QUEUE_SNAPSHOT) {
    const snapshot = exactEvent(event, [
      'type', 'requestId', 'maxActive', 'maxPending', 'jobs',
    ]);
    if (!finiteInteger(snapshot.maxActive, 1, 8)
      || !finiteInteger(snapshot.maxPending, 1, 64)
      || !Array.isArray(snapshot.jobs)
      || snapshot.jobs.length > 64) invalid();
    const jobs = snapshot.jobs.map(assertQueueItem);
    if (new Set(jobs.map(({ jobId }) => jobId)).size !== jobs.length
      || new Set(jobs.map(({ operationId }) => operationId)).size !== jobs.length) invalid();
    return { ...snapshot, jobs };
  }
  if (event.type === HOST_EVENTS.JOB_QUEUED) {
    const queued = exactEvent(event, [
      'type', 'requestId', 'jobId', 'operationId', 'replayed', 'position', 'job',
    ]);
    const job = assertQueueItem(queued.job);
    if (!id(queued.jobId) || !id(queued.operationId)
      || queued.jobId !== job.jobId || queued.operationId !== job.operationId
      || typeof queued.replayed !== 'boolean'
      || !(queued.position === null || finiteInteger(queued.position, 1, 32))
      || (job.state === 'queued' && queued.position === null)
      || queued.position !== job.position) invalid();
    return { ...queued, job };
  }
  const paused = exactEvent(event, [
    'type', 'requestId', 'jobId', 'operationId', 'job',
  ]);
  const job = assertQueueItem(paused.job);
  if (!id(paused.jobId) || !id(paused.operationId)
    || paused.jobId !== job.jobId || paused.operationId !== job.operationId) invalid();
  return { ...paused, job };
}

/** Validates host messages and returns a safe public event; internal host `download` becomes `video`. */
export function assertHostEvent(event) {
  if (!plainObject(event) || !ALLOWED_HOST_EVENTS.has(event.type) || !id(event.requestId)) invalid();
  if (event.type === HOST_EVENTS.READY) {
    if (Object.hasOwn(event, 'job')) return { type: HOST_EVENTS.READY, requestId: event.requestId, job: event.job === null ? null : assertJobSnapshot(event.job) };
    const ready = exactEvent(event, [
      'type', 'requestId', 'protocolVersion', 'nativeName', 'hostVersion', 'capabilities',
      'defaultFolder',
    ]);
    if (!finiteInteger(ready.protocolVersion, MIN_NATIVE_PROTOCOL_VERSION, 999) || !text(ready.nativeName, 128)) invalid();
    if (!text(ready.hostVersion, 64)
      || !Array.isArray(ready.capabilities)
      || ready.capabilities.length > 32
      || ready.capabilities.some((capability) => !text(capability, 64) || !/^[a-z][A-Za-z0-9]*$/.test(capability))) invalid();
    assertWindowsAbsolutePath(ready.defaultFolder);
    return ready;
  }
  if (event.type === HOST_EVENTS.FORMATS) return assertFormats(event);
  if (event.type === HOST_EVENTS.QUEUE_SNAPSHOT
    || event.type === HOST_EVENTS.JOB_QUEUED
    || event.type === HOST_EVENTS.JOB_PAUSED) return assertQueueEvent(event);
  if (event.type === HOST_EVENTS.DIAGNOSTICS) return assertDiagnostics(event);
  if (event.type === HOST_EVENTS.DIAGNOSTICS_EXPORTED) {
    const exported = exactEvent(event, ['type', 'requestId', 'path']);
    assertWindowsAbsolutePath(exported.path);
    return exported;
  }
  if (event.type === HOST_EVENTS.DIAGNOSTICS_CLEARED) {
    return exactEvent(event, ['type', 'requestId']);
  }
  if (event.type === HOST_EVENTS.FOLDER_SELECTION_CANCELLED) {
    return exactEvent(event, ['type', 'requestId']);
  }
  if (event.type === HOST_EVENTS.FOLDER_SELECTED) {
    const selected = exactEvent(event, ['type', 'requestId', 'path']);
    assertWindowsAbsolutePath(selected.path);
    return selected;
  }
  if (event.type === HOST_EVENTS.FILE_MOVED) {
    const moved = exactEvent(event, ['type', 'requestId', 'operationId', 'downloadId', 'finalPath']);
    if (!id(moved.operationId) || !finiteInteger(moved.downloadId)) invalid();
    assertWindowsAbsolutePath(moved.finalPath);
    return moved;
  }
  if (event.type === HOST_EVENTS.FILE_REVEALED) {
    return exactEvent(event, ['type', 'requestId']);
  }
  if (event.type !== HOST_EVENTS.JOB_FAILED && !id(event.jobId)) invalid();
  if (event.type === HOST_EVENTS.JOB_STARTED) {
    if (Object.hasOwn(event, 'operationId')) {
      const started = exactEvent(event, [
        'type', 'requestId', 'jobId', 'operationId', 'resumed', 'job',
      ]);
      const job = assertQueueItem(started.job);
      if (!id(started.jobId) || !id(started.operationId)
        || started.jobId !== job.jobId || started.operationId !== job.operationId
        || typeof started.resumed !== 'boolean') invalid();
      return { ...started, job };
    }
    return { type: HOST_EVENTS.JOB_STARTED, requestId: event.requestId, jobId: event.jobId, job: assertJobSnapshot(event.job) };
  }
  if (event.type === HOST_EVENTS.JOB_PROGRESS) {
    const stage = event.stage === 'download' ? 'video' : event.stage;
    if (!STAGES.has(stage)) invalid();
    return {
      type: HOST_EVENTS.JOB_PROGRESS, requestId: event.requestId, jobId: event.jobId, stage,
      ...outputOptional(event, 'percent', (value) => value === null || finiteInteger(value, 0, 100)),
      ...outputOptional(event, 'downloadedBytes', (value) => optionalNumber(value)),
      ...outputOptional(event, 'totalBytes', (value) => optionalNumber(value)),
      ...outputOptional(event, 'speedBytesPerSecond', (value) => optionalNumber(value)),
      ...outputOptional(event, 'etaSeconds', (value) => optionalNumber(value)),
    };
  }
  if (event.type === HOST_EVENTS.JOB_COMPLETED) {
    if (Object.hasOwn(event, 'job')) {
      const completed = exactEvent(event, [
        'type', 'requestId', 'jobId', 'operationId', 'path', 'job',
      ]);
      const job = assertQueueItem(completed.job);
      assertWindowsAbsolutePath(completed.path);
      if (completed.jobId !== job.jobId
        || completed.operationId !== job.operationId
        || completed.path !== job.path) invalid();
      return { ...completed, job };
    }
    assertWindowsAbsolutePath(event.path);
    return { type: HOST_EVENTS.JOB_COMPLETED, requestId: event.requestId, jobId: event.jobId, path: event.path };
  }
  if (event.type === HOST_EVENTS.JOB_CANCELLED) {
    if (Object.hasOwn(event, 'job')) {
      const cancelled = exactEvent(event, ['type', 'requestId', 'jobId', 'operationId', 'job']);
      const job = assertQueueItem(cancelled.job);
      if (cancelled.jobId !== job.jobId || cancelled.operationId !== job.operationId) invalid();
      return { ...cancelled, job };
    }
    return { type: HOST_EVENTS.JOB_CANCELLED, requestId: event.requestId, jobId: event.jobId };
  }
  const details = boundedDetails(event.details);
  if (Object.hasOwn(event, 'job')) {
    const failed = exactEvent(event, [
      'type', 'requestId', 'jobId', 'operationId', 'code', 'message', 'details', 'job',
    ]);
    const job = assertQueueItem(failed.job);
    if (!id(failed.jobId) || !id(failed.operationId)
      || failed.jobId !== job.jobId || failed.operationId !== job.operationId
      || typeof failed.code !== 'string' || !SAFE_CODE.test(failed.code)
      || !text(failed.message, 256) || !details) invalid();
    return { ...failed, details, job };
  }
  if ((Object.hasOwn(event, 'jobId') && !id(event.jobId))
    || typeof event.code !== 'string' || !SAFE_CODE.test(event.code)
    || !text(event.message, 256) || !details) invalid();
  return Object.assign({ type: HOST_EVENTS.JOB_FAILED, requestId: event.requestId },
    Object.hasOwn(event, 'jobId') ? { jobId: event.jobId } : {},
    { code: event.code, message: event.message, details });
}

/** Reduces a validated `formats` event to the popup catalog shape. */
export function assertFormatsResult(event) {
  const result = assertHostEvent(event);
  if (result.type !== HOST_EVENTS.FORMATS) invalid();
  const {
    videoId, title, durationSeconds, qualities, formats, subtitles, audioLanguages,
  } = result;
  return {
    ...(result.platform ? { platform: result.platform } : {}),
    videoId,
    title,
    durationSeconds,
    qualities,
    ...(formats ? { formats, subtitles, audioLanguages } : {}),
  };
}
