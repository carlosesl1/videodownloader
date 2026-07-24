import { assertJobSnapshot } from './job-view.js';

export const NATIVE_HOST = 'com.videoradar.helper';
export const MIN_NATIVE_PROTOCOL_VERSION = 2;
export const YOUTUBE_ACTIONS = Object.freeze({
  LIST_FORMATS: 'YOUTUBE_LIST_FORMATS', START_DOWNLOAD: 'YOUTUBE_START_DOWNLOAD',
  CANCEL_DOWNLOAD: 'YOUTUBE_CANCEL_DOWNLOAD', GET_JOB: 'YOUTUBE_GET_JOB',
});
export const HOST_COMMANDS = Object.freeze({
  PING: 'ping',
  LIST_FORMATS: 'listFormats',
  START_DOWNLOAD: 'startDownload',
  CANCEL_DOWNLOAD: 'cancelDownload',
  GET_JOB: 'getJob',
  CHOOSE_DOWNLOAD_FOLDER: 'chooseDownloadFolder',
  MOVE_DOWNLOADED_FILE: 'moveDownloadedFile',
});
export const HOST_EVENTS = Object.freeze({
  READY: 'ready',
  FORMATS: 'formats',
  JOB_STARTED: 'jobStarted',
  JOB_PROGRESS: 'jobProgress',
  JOB_COMPLETED: 'jobCompleted',
  JOB_CANCELLED: 'jobCancelled',
  JOB_FAILED: 'jobFailed',
  FOLDER_SELECTED: 'folderSelected',
  FOLDER_SELECTION_CANCELLED: 'folderSelectionCancelled',
  FILE_MOVED: 'fileMoved',
});

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const SAFE_CODE = /^[A-Z0-9_]{1,64}$/;
const STAGES = new Set(['preparing', 'video', 'audio', 'merge', 'finalize', 'complete', 'cancelled', 'failed', 'interrupted']);
const ALLOWED_HOST_EVENTS = new Set(Object.values(HOST_EVENTS));

function invalid() { throw new Error('Mensagem inválida'); }
function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function id(value) { return typeof value === 'string' && SAFE_ID.test(value); }
function text(value, maximum, empty = false) { return typeof value === 'string' && value.length <= maximum && (empty || value.length > 0); }
function finiteInteger(value, min = 0, max = Number.MAX_SAFE_INTEGER) { return Number.isSafeInteger(value) && value >= min && value <= max; }
function optionalNumber(value, minimum = 0) { return value === null || (typeof value === 'number' && Number.isFinite(value) && finiteInteger(value, minimum)); }
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

export function assertWindowsAbsolutePath(value) {
  if (!text(value, 1024) || value.includes('/') || /^\\\\[?.]\\/.test(value)) invalid();
  let segments;
  if (/^[A-Za-z]:\\/.test(value)) {
    segments = value.slice(3).split('\\');
  } else if (value.startsWith('\\\\')) {
    segments = value.slice(2).split('\\');
    if (
      segments.length < 2
      || segments[0].length === 0
      || segments[1].length === 0
      || segments[0] === '?'
      || segments[1] === '?'
    ) invalid();
  } else {
    invalid();
  }
  if (segments.some((segment) => segment === '.' || segment === '..')) invalid();
  return value;
}

export function hostCommand(type, requestId, payload = {}) {
  if (!Object.values(HOST_COMMANDS).includes(type) || !id(requestId) || !plainObject(payload)) invalid();
  try { if (JSON.stringify(payload).length > 16 * 1024) invalid(); } catch { invalid(); }
  return { type, requestId, payload };
}

function assertQuality(value, previousHeight, heights) {
  if (!plainObject(value) || !finiteInteger(value.height, 1, 4320) || value.height >= previousHeight || heights.has(value.height)
    || !text(value.label, 128) || typeof value.container !== 'string' || !/^(mp4|webm)$/i.test(value.container)
    || typeof value.combined !== 'boolean') invalid();
  heights.add(value.height);
  return { height: value.height, label: value.label, container: value.container.toLowerCase(), combined: value.combined };
}

function assertFormats(event) {
  if (!VIDEO_ID.test(event.videoId) || !text(event.title, 512) || !(event.durationSeconds === null || (typeof event.durationSeconds === 'number' && Number.isFinite(event.durationSeconds) && event.durationSeconds >= 0))
    || !Array.isArray(event.qualities) || event.qualities.length > 32) invalid();
  const heights = new Set(); let previous = Infinity;
  const qualities = event.qualities.map((quality) => {
    const parsed = assertQuality(quality, previous, heights); previous = parsed.height; return parsed;
  });
  return { type: HOST_EVENTS.FORMATS, requestId: event.requestId, videoId: event.videoId, title: event.title, durationSeconds: event.durationSeconds, qualities };
}

/** Validates host messages and returns a safe public event; internal host `download` becomes `video`. */
export function assertHostEvent(event) {
  if (!plainObject(event) || !ALLOWED_HOST_EVENTS.has(event.type) || !id(event.requestId)) invalid();
  if (event.type === HOST_EVENTS.READY) {
    if (Object.hasOwn(event, 'job')) return { type: HOST_EVENTS.READY, requestId: event.requestId, job: event.job === null ? null : assertJobSnapshot(event.job) };
    const ready = exactEvent(event, ['type', 'requestId', 'protocolVersion', 'nativeName', 'defaultFolder']);
    if (!finiteInteger(ready.protocolVersion, MIN_NATIVE_PROTOCOL_VERSION, 999) || !text(ready.nativeName, 128)) invalid();
    assertWindowsAbsolutePath(ready.defaultFolder);
    return ready;
  }
  if (event.type === HOST_EVENTS.FORMATS) return assertFormats(event);
  if (event.type === HOST_EVENTS.FOLDER_SELECTION_CANCELLED) {
    return exactEvent(event, ['type', 'requestId']);
  }
  if (event.type === HOST_EVENTS.FOLDER_SELECTED) {
    const selected = exactEvent(event, ['type', 'requestId', 'path']);
    assertWindowsAbsolutePath(selected.path);
    return selected;
  }
  if (event.type === HOST_EVENTS.FILE_MOVED) {
    const moved = exactEvent(event, ['type', 'requestId', 'downloadId', 'finalPath']);
    if (!finiteInteger(moved.downloadId)) invalid();
    assertWindowsAbsolutePath(moved.finalPath);
    return moved;
  }
  if (event.type !== HOST_EVENTS.JOB_FAILED && !id(event.jobId)) invalid();
  if (event.type === HOST_EVENTS.JOB_STARTED) return { type: HOST_EVENTS.JOB_STARTED, requestId: event.requestId, jobId: event.jobId, job: assertJobSnapshot(event.job) };
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
    if (!text(event.path, 1024)) invalid();
    return { type: HOST_EVENTS.JOB_COMPLETED, requestId: event.requestId, jobId: event.jobId, path: event.path };
  }
  if (event.type === HOST_EVENTS.JOB_CANCELLED) return { type: HOST_EVENTS.JOB_CANCELLED, requestId: event.requestId, jobId: event.jobId };
  const details = boundedDetails(event.details);
  if ((Object.hasOwn(event, 'jobId') && !id(event.jobId)) || !SAFE_CODE.test(event.code) || !text(event.message, 256) || !details) invalid();
  return Object.assign({ type: HOST_EVENTS.JOB_FAILED, requestId: event.requestId },
    Object.hasOwn(event, 'jobId') ? { jobId: event.jobId } : {},
    { code: event.code, message: event.message, details });
}

/** Reduces a validated `formats` event to the popup catalog shape. */
export function assertFormatsResult(event) {
  const result = assertHostEvent(event);
  if (result.type !== HOST_EVENTS.FORMATS) invalid();
  const { videoId, title, durationSeconds, qualities } = result;
  return { videoId, title, durationSeconds, qualities };
}
