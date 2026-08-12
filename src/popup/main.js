import { groupDirectVariants, normalizeCandidates } from '../detection/media-candidates.js';
import {
  DISCOVERY_ACTIONS,
  DISCOVERY_PREFIX,
  sanitizeDiscoverySnapshot,
} from '../detection/discovery-protocol.js';
import { buildDownloadFilename } from '../shared/filename.js';
import { ACTIONS } from '../shared/messages.js';
import {
  DELIVERY_RESULT_INDEX,
  DELIVERY_RESULT_PREFIX,
  HLS_OPERATION_INDEX,
  HLS_OPERATION_PREFIX,
  RELOCATION_INDEX,
  RELOCATION_PREFIX,
  DOWNLOAD_QUEUE_JOBS,
  downloadIdIndex,
  stringIndex,
} from '../shared/persistence-keys.js';
import { YOUTUBE_ACTIONS, assertFormatsResult } from '../youtube/protocol.js';
import { sanitizePublicQueueJobs } from '../background/download-queue.js';
import { canonicalMediaPage } from '../media/page-url.js';
import { assertJobSnapshot } from '../youtube/job-view.js';
import { initialState, reduceState } from './state.js';
import { renderPopup } from './render.js';

const OPERATION_PREFIX = HLS_OPERATION_PREFIX;
const OPERATION_STATES = new Set([
  'starting',
  'assembling',
  'assembled',
  'downloading',
  'complete',
  'interrupted',
  'failed',
]);
const ACTIVE_OPERATION_STATES = new Set(['starting', 'assembling', 'assembled', 'downloading']);
const OPERATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const ERROR_CODE = /^[A-Za-z0-9_]{1,64}$/;
const RELOCATION_STATUSES = new Set([
  'downloading', 'moving', 'complete', 'moveFailed', 'interrupted',
]);
const RELOCATION_MEDIA_KINDS = new Set(['direct', 'hls']);
const YOUTUBE_SNAPSHOT_FIELDS = [
  'jobId', 'operationId', 'videoId', 'title', 'url', 'height', 'format', 'stage', 'percent',
  'downloadedBytes', 'totalBytes', 'speedBytesPerSecond', 'etaSeconds', 'path', 'error', 'updatedAt',
];
const LEGACY_YOUTUBE_SNAPSHOT_FIELDS = YOUTUBE_SNAPSHOT_FIELDS
  .filter((field) => field !== 'operationId');

function createPermissionClaimId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `permission-${globalThis.crypto.randomUUID()}`;
  }
  return `permission-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function isObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value, expected) {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function sanitizeRelocationRecord(value) {
  if (!isObject(value)
    || !Number.isSafeInteger(value.downloadId)
    || value.downloadId < 0
    || typeof value.operationId !== 'string'
    || !OPERATION_ID.test(value.operationId)
    || !RELOCATION_MEDIA_KINDS.has(value.mediaKind)
    || typeof value.displayName !== 'string'
    || !value.displayName.trim()
    || value.displayName.length > 255
    || !RELOCATION_STATUSES.has(value.status)
    || !Number.isSafeInteger(value.updatedAt)
    || value.updatedAt < 0) {
    throw new Error('Registro de entrega inválido.');
  }
  httpUrl(value.mediaUrl);
  for (const field of ['stagingPath', 'finalPath']) {
    if (value[field] !== null && (typeof value[field] !== 'string' || value[field].length > 32767)) {
      throw new Error('Registro de entrega inválido.');
    }
  }
  if (value.status === 'complete' && !value.finalPath?.trim()) {
    throw new Error('Registro de entrega inválido.');
  }
  if (value.status === 'moveFailed' && !value.stagingPath?.trim()) {
    throw new Error('Registro de entrega inválido.');
  }
  return value;
}

function isYouTubeStartCancelled(response) {
  return isObject(response)
    && response.ok === true
    && isObject(response.value)
    && hasOnlyKeys(response.value, ['cancelled', 'code'])
    && response.value.cancelled === true
    && response.value.code === 'DOWNLOAD_CANCELLED';
}

function httpUrl(value) {
  if (typeof value !== 'string') throw new Error('URL de mídia inválida');
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('URL de mídia inválida');
  }
  return parsed;
}

export function canonicalMediaUrl(value) {
  const parsed = httpUrl(value);
  parsed.hash = '';
  return parsed.href;
}

function canonicalHlsIdentity(value) {
  const parsed = httpUrl(value);
  return `${parsed.origin}${parsed.pathname}`;
}

export function buildOriginGrant(values) {
  const origins = [];
  const seen = new Set();
  for (const value of values) {
    const origin = httpUrl(value).origin;
    if (seen.has(origin)) continue;
    seen.add(origin);
    origins.push(origin);
  }
  return {
    origins,
    patterns: origins.map((origin) => `${origin}/*`),
  };
}

export async function releaseHostPermissionClaim(chromeApi, claimId) {
  if (claimId === null) return true;
  try {
    const response = await chromeApi.runtime.sendMessage({
      target: 'background',
      action: ACTIONS.RELEASE_HOST_PERMISSION_CLAIM,
      payload: { claimId },
    });
    unwrap(response, (value) => (
      isObject(value)
      && hasOnlyKeys(value, ['claimId', 'state'])
      && value.claimId === claimId
      && value.state === 'released'
    ));
    return true;
  } catch {
    // The durable claim is retried and expires through background maintenance.
    return false;
  }
}

export async function requestHostOriginGrant(values, {
  chromeApi = globalThis.chrome,
  createClaimId = createPermissionClaimId,
  claimHeartbeatMs = 60_000,
  setIntervalFn = globalThis.setInterval,
  clearIntervalFn = globalThis.clearInterval,
} = {}) {
  const grant = buildOriginGrant(values);
  if (grant.patterns.length === 0) {
    throw Object.assign(new Error('Sem origem para autorizar'), { code: 'PERMISSION_DENIED' });
  }
  const preexisting = await Promise.all(grant.patterns.map((pattern) => (
    chromeApi.permissions.contains({ origins: [pattern] })
  )));
  const ownedPatterns = grant.patterns.filter((_, index) => !preexisting[index]);
  if (ownedPatterns.length === 0) return { ...grant, permissionClaimId: null };

  const claimId = createClaimId();
  if (typeof claimId !== 'string' || !OPERATION_ID.test(claimId)) {
    throw new Error('Identificador de autorização inválido.');
  }
  let permissionGranted = false;
  let heartbeatId;
  let heartbeatFailure;
  let heartbeatWork = Promise.resolve();
  const renewClaim = async () => {
    const response = await chromeApi.runtime.sendMessage({
      target: 'background',
      action: ACTIONS.CLAIM_HOST_PERMISSIONS,
      payload: { claimId, permissionPatterns: ownedPatterns },
    });
    unwrap(response, (value) => (
      isObject(value)
      && hasOnlyKeys(value, ['claimId', 'state'])
      && value.claimId === claimId
      && value.state === 'claimed'
    ));
  };
  try {
    await renewClaim();
    if (typeof setIntervalFn === 'function' && claimHeartbeatMs > 0) {
      heartbeatId = setIntervalFn(() => {
        heartbeatWork = heartbeatWork
          .then(renewClaim)
          .catch((error) => { heartbeatFailure ??= error; });
      }, claimHeartbeatMs);
    }
    permissionGranted = await chromeApi.permissions.request({ origins: ownedPatterns });
    if (heartbeatId !== undefined && typeof clearIntervalFn === 'function') {
      clearIntervalFn(heartbeatId);
      heartbeatId = undefined;
    }
    await heartbeatWork;
    if (heartbeatFailure) throw heartbeatFailure;
    if (!permissionGranted) {
      throw Object.assign(new Error('Acesso negado'), { code: 'PERMISSION_DENIED' });
    }
    const confirmation = await chromeApi.runtime.sendMessage({
      target: 'background',
      action: ACTIONS.CONFIRM_HOST_PERMISSION_CLAIM,
      payload: { claimId, permissionPatterns: ownedPatterns },
    });
    unwrap(confirmation, (value) => (
      isObject(value)
      && hasOnlyKeys(value, ['claimId', 'state'])
      && value.claimId === claimId
      && value.state === 'confirmed'
    ));
    return { ...grant, permissionClaimId: claimId };
  } catch (error) {
    if (heartbeatId !== undefined && typeof clearIntervalFn === 'function') {
      clearIntervalFn(heartbeatId);
    }
    await heartbeatWork;
    const released = await releaseHostPermissionClaim(chromeApi, claimId);
    if (permissionGranted && !released && typeof chromeApi.permissions?.remove === 'function') {
      try {
        await chromeApi.permissions.remove({ origins: ownedPatterns });
      } catch {
        // A manutenção do worker ainda pode recuperar a reserva durável original.
      }
    }
    throw error;
  }
}

export async function runWithHostOriginGrant({
  chromeApi = globalThis.chrome,
  values,
  existingGrant,
  createClaimId,
}, operation) {
  if (typeof operation !== 'function') throw new TypeError('Operação de permissão inválida.');
  let grant;
  try {
    grant = existingGrant ?? await requestHostOriginGrant(values, { chromeApi, createClaimId });
    return await operation(grant);
  } catch (error) {
    await releaseHostPermissionClaim(chromeApi, grant?.permissionClaimId ?? null);
    throw error;
  }
}

function safeDetails(value) {
  if (!isObject(value)) return {};
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length > 16 * 1024) return {};
    const parsed = JSON.parse(serialized);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function responseError(value) {
  if (!isObject(value)) return null;
  const details = safeDetails(value.details);
  if (
    typeof value.code !== 'string'
    || !ERROR_CODE.test(value.code)
    || typeof value.message !== 'string'
    || !value.message.trim()
    || value.message.length > 500
  ) return null;
  const error = new Error(value.message);
  error.code = value.code;
  error.details = details;
  return error;
}

function unwrap(response, validate) {
  if (!isObject(response) || typeof response.ok !== 'boolean') {
    throw Object.assign(new Error('Resposta inválida do processamento.'), { code: 'INVALID_RESPONSE' });
  }
  if (!response.ok) {
    throw responseError(response.error)
      ?? Object.assign(new Error('Resposta inválida do processamento.'), { code: 'INVALID_RESPONSE' });
  }
  if (!Object.hasOwn(response, 'value') || !validate(response.value)) {
    throw Object.assign(new Error('Resposta inválida do processamento.'), { code: 'INVALID_RESPONSE' });
  }
  return response.value;
}

export function unwrapDirectResponse(response) {
  return unwrap(response, (value) => isObject(value) && Number.isInteger(value.downloadId) && value.downloadId >= 0);
}

function validVariant(variant) {
  if (!isObject(variant)) return false;
  try {
    httpUrl(variant.url);
  } catch {
    return false;
  }
  return (
    typeof variant.label === 'string'
    && variant.label.trim().length > 0
    && variant.label.length <= 200
    && Number.isSafeInteger(variant.width)
    && variant.width >= 0
    && Number.isSafeInteger(variant.height)
    && variant.height >= 0
    && Number.isSafeInteger(variant.bandwidth)
    && variant.bandwidth >= 0
    && (variant.codecs === null || typeof variant.codecs === 'string')
  );
}

export function unwrapInspectResponse(response) {
  return unwrap(response, (value) => (
    isObject(value)
    && (value.kind === 'master' || value.kind === 'media')
    && Array.isArray(value.variants)
    && value.variants.length > 0
    && value.variants.every(validVariant)
  ));
}

export function unwrapQueuedResponse(response) {
  return unwrap(response, (value) => (
    isObject(value)
    && typeof value.operationId === 'string'
    && OPERATION_ID.test(value.operationId)
    && value.state === 'assembling'
  ));
}

function invalidYouTubeResponse() {
  return Object.assign(new Error('Resposta inválida do processamento.'), { code: 'INVALID_RESPONSE' });
}

function sanitizeYouTubeJobSnapshot(value) {
  if (!isObject(value)
    || (!hasOnlyKeys(value, YOUTUBE_SNAPSHOT_FIELDS)
      && !hasOnlyKeys(value, LEGACY_YOUTUBE_SNAPSHOT_FIELDS))) throw invalidYouTubeResponse();
  const {
    jobId, operationId = null, videoId, title, url, height, format, stage, percent,
    downloadedBytes, totalBytes, speedBytesPerSecond, etaSeconds,
    path, error, updatedAt,
  } = value;
  let core;
  try {
    core = assertJobSnapshot({
      jobId, operationId, videoId, title, height, stage, percent, path, errorCode: error,
    });
  } catch {
    throw invalidYouTubeResponse();
  }
  const page = canonicalMediaPage(url);
  if (!videoId || !title || !page || page.canonicalUrl !== url
    || (page.platform === 'youtube' && page.mediaId !== videoId)
    || !(percent === null || (Number.isSafeInteger(percent) && percent >= 0 && percent <= 100))
    || ![downloadedBytes, totalBytes, speedBytesPerSecond, etaSeconds].every((entry) => entry === null || (Number.isSafeInteger(entry) && entry >= 0))
    || !(error === null || (typeof error === 'string' && ERROR_CODE.test(error)))
    || !Number.isSafeInteger(updatedAt) || updatedAt < 0
    || !isObject(format) || !hasOnlyKeys(format, ['height', 'label', 'container', 'combined'])) throw invalidYouTubeResponse();
  let validatedFormat;
  if (height === 0) {
    if (format.height !== 0 || format.container.toLowerCase() !== 'm4a'
      || typeof format.label !== 'string' || !format.label.trim()
      || format.label.length > 128 || format.combined !== false) throw invalidYouTubeResponse();
    validatedFormat = { ...format, container: 'm4a' };
  } else {
    try {
      validatedFormat = assertFormatsResult({
        type: 'formats', requestId: 'popup', videoId, title, durationSeconds: null, qualities: [format],
      }).qualities[0];
    } catch {
      throw invalidYouTubeResponse();
    }
  }
  if (validatedFormat.height !== core.height) throw invalidYouTubeResponse();
  return {
    jobId: core.jobId, operationId: core.operationId ?? null,
    videoId, title, url, height: core.height,
    format: { ...validatedFormat }, stage: core.stage, percent,
    downloadedBytes, totalBytes, speedBytesPerSecond, etaSeconds,
    path: core.path, error, updatedAt,
  };
}

export function unwrapYouTubeFormats(response) {
  const catalog = unwrap(response, (value) => {
    const rich = value && Object.hasOwn(value, 'formats');
    const keys = value && Object.hasOwn(value, 'platform')
      ? ['platform', 'videoId', 'title', 'durationSeconds', 'qualities',
        ...(rich ? ['formats', 'subtitles', 'audioLanguages'] : [])]
      : ['videoId', 'title', 'durationSeconds', 'qualities',
        ...(rich ? ['formats', 'subtitles', 'audioLanguages'] : [])];
    if (!isObject(value) || !hasOnlyKeys(value, keys)
      || !Array.isArray(value.qualities)
      || !value.qualities.every((quality) => isObject(quality))) return false;
    try {
      assertFormatsResult({ type: 'formats', requestId: 'popup', ...value });
      return true;
    } catch {
      return false;
    }
  });
  const parsed = assertFormatsResult({ type: 'formats', requestId: 'popup', ...catalog });
  return {
    ...parsed,
    qualities: parsed.qualities.map((quality) => ({ ...quality })),
    ...(parsed.formats ? {
      formats: parsed.formats.map((format) => ({ ...format })),
      subtitles: parsed.subtitles.map((subtitle) => ({
        ...subtitle,
        containers: [...subtitle.containers],
      })),
      audioLanguages: [...parsed.audioLanguages],
    } : {}),
  };
}

export function unwrapYouTubeJob(response) {
  const value = unwrap(response, (candidate) => candidate === null || isObject(candidate));
  return value === null ? null : sanitizeYouTubeJobSnapshot(value);
}

export function unwrapDownloadQueue(response) {
  return sanitizePublicQueueJobs(unwrap(response, Array.isArray));
}

function unwrapDiscovery(response) {
  const value = unwrap(response, (candidate) => candidate === null || isObject(candidate));
  return value === null ? null : sanitizeDiscoverySnapshot(value);
}

function compactCodec(codec) {
  if (typeof codec !== 'string' || !codec.trim()) return null;
  const normalized = codec.trim().toLowerCase();
  if (normalized.startsWith('avc1') || normalized === 'h264') return 'H.264';
  if (normalized.startsWith('hev1') || normalized.startsWith('hvc1') || normalized === 'hevc') return 'HEVC';
  if (normalized.startsWith('vp09') || normalized.startsWith('vp9')) return 'VP9';
  if (normalized.startsWith('av01') || normalized === 'av1') return 'AV1';
  if (normalized.startsWith('mp4a') || normalized === 'aac') return 'AAC';
  return codec.trim().slice(0, 18).toUpperCase();
}

function compactBytes(bytes, approximate = false) {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  const digits = value >= 100 || unit === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${approximate ? '~' : ''}${value.toFixed(digits).replace('.', ',')} ${units[unit]}`;
}

export function richMediaLabel(format, fallback = 'Qualidade única') {
  const parts = [format.label || fallback];
  if (Number.isFinite(format.fps) && !parts[0].includes(String(format.fps))) {
    parts.push(`${Math.round(format.fps)} fps`);
  }
  if (format.hdr) parts.push(format.dynamicRange || 'HDR');
  const codecs = [format.videoCodec, format.audioCodec]
    .map(compactCodec)
    .filter((codec, index, values) => codec && values.indexOf(codec) === index);
  parts.push(...codecs);
  if (Number.isFinite(format.bitrateKbps)) {
    parts.push(`${Math.round(format.bitrateKbps)} kb/s`);
  }
  const size = compactBytes(
    format.estimatedSizeBytes ?? format.fileSizeBytes,
    format.estimatedSizeApproximate ?? format.fileSizeApproximate,
  );
  if (size) parts.push(size);
  return parts.join(' · ');
}

function bestAudioVariant(formats, title) {
  const audioFormats = (formats ?? [])
    .filter((format) => format.audioOnly && format.audioCodec);
  // Keep the label and size aligned with the yt-dlp selector
  // `ba[ext=m4a]/ba`: prefer an M4A source even when an Opus/WebM stream
  // advertises a higher bitrate.
  const compatible = audioFormats.filter((format) => format.container === 'm4a');
  const audio = (compatible.length > 0 ? compatible : audioFormats)
    .sort((left, right) => (right.bitrateKbps ?? 0) - (left.bitrateKbps ?? 0)
      || (right.fileSizeBytes ?? 0) - (left.fileSizeBytes ?? 0))[0];
  if (!audio) return null;
  const display = {
    ...audio,
    label: 'Somente áudio',
    estimatedSizeBytes: audio.fileSizeBytes,
    estimatedSizeApproximate: audio.fileSizeApproximate || audio.container !== 'm4a',
  };
  return {
    ...display,
    container: 'm4a',
    label: richMediaLabel(display, 'Somente áudio'),
    filename: `${title}-audio.m4a`,
    selection: {
      height: null,
      audioOnly: true,
      subtitleLanguage: null,
      includeAutomaticSubtitles: false,
    },
  };
}

export function youtubeItem(formats, url) {
  const page = canonicalMediaPage(url);
  if (!page || (formats.platform && formats.platform !== page.platform)) {
    throw invalidYouTubeResponse();
  }
  const platform = formats.platform ?? page.platform;
  const variants = formats.qualities.map((quality) => ({
    ...quality,
    label: richMediaLabel(quality, quality.label),
    filename: `${formats.title}-${quality.label}.${quality.container}`,
    selection: {
      height: quality.height,
      audioOnly: false,
      subtitleLanguage: null,
      includeAutomaticSubtitles: false,
    },
  }));
  const audio = bestAudioVariant(formats.formats, formats.title);
  if (audio) variants.push(audio);
  const first = variants[0];
  const item = {
    id: `${platform}:${formats.videoId}`,
    kind: platform === 'youtube' ? 'youtube' : 'remote-media',
    platform, url, title: formats.title, filename: first.filename, variants,
    selectedIndex: 0, predictedFormat: first.container, phase: 'ready', jobId: null,
    active: false, progress: null, statusLabel: '', path: null, error: null,
  };
  if (formats.formats) {
    item.subtitles = formats.subtitles.map((subtitle) => ({ ...subtitle }));
    item.selectedSubtitleIndex = -1;
    item.audioLanguages = [...formats.audioLanguages];
  }
  return item;
}

export function permissionOriginsFromError(error) {
  if (!isObject(error) || error.code !== 'HLS_PERMISSION' || !Array.isArray(error.details?.origins)) return [];
  const origins = [];
  const seen = new Set();
  for (const value of error.details.origins) {
    try {
      const origin = httpUrl(value).origin;
      if (!seen.has(origin)) {
        seen.add(origin);
        origins.push(origin);
      }
    } catch {
      // Invalid origins never become permission requests.
    }
  }
  return origins;
}

function validOperationRecord(record) {
  if (
    !isObject(record)
    || typeof record.operationId !== 'string'
    || !OPERATION_ID.test(record.operationId)
    || !OPERATION_STATES.has(record.state)
  ) return false;
  try {
    canonicalMediaUrl(record.url);
  } catch {
    return false;
  }
  return true;
}

function operationPriority(record) {
  const active = ACTIVE_OPERATION_STATES.has(record.state) ? 2 : 1;
  const timestamp = Number.isFinite(record.updatedAt)
    ? record.updatedAt
    : Number.isFinite(record.createdAt) ? record.createdAt : 0;
  return [active, timestamp];
}

export function findMatchingOperation(item, records) {
  const exactUrls = new Set();
  const fallbackIdentities = new Set();
  for (const variant of item?.variants ?? []) {
    try {
      exactUrls.add(canonicalMediaUrl(variant.url));
      fallbackIdentities.add(canonicalHlsIdentity(variant.url));
    } catch {
      // Invalid scan candidates are ignored before rendering.
    }
  }
  const byPriority = (left, right) => {
      const [leftActive, leftTime] = operationPriority(left);
      const [rightActive, rightTime] = operationPriority(right);
      return rightActive - leftActive || rightTime - leftTime;
  };
  const valid = records.filter(validOperationRecord);
  const exact = valid
    .filter((record) => exactUrls.has(canonicalMediaUrl(record.url)))
    .sort(byPriority);
  if (exact.length > 0) return exact[0];

  const fallback = valid.filter((record) => (
    fallbackIdentities.has(canonicalHlsIdentity(record.url))
  ));
  return fallback.length === 1 ? fallback[0] : undefined;
}

function candidateLabel(variant, kind) {
  if (variant.height) return `${variant.height}p`;
  if (kind === 'hls') return 'Qualidade a verificar';
  try {
    const extension = httpUrl(variant.url).pathname.split('.').at(-1)?.toUpperCase();
    return extension && extension.length <= 5 ? extension : 'Qualidade única';
  } catch {
    return 'Qualidade única';
  }
}

function mediaFormat(url, kind) {
  if (kind === 'hls') return 'ts';
  const extension = httpUrl(url).pathname.split('.').at(-1)?.toLowerCase();
  return ['mp4', 'webm', 'mov'].includes(extension) ? extension : 'vídeo';
}

function scanItems(result) {
  if (!isObject(result) || !Array.isArray(result.candidates)) throw new Error('Resultado de varredura inválido');
  const pageTitle = typeof result.pageTitle === 'string' ? result.pageTitle : '';
  return groupDirectVariants(normalizeCandidates(result.candidates)).map((group) => {
    const variants = group.variants.map((variant) => ({
      ...variant,
      label: candidateLabel(variant, group.kind),
      filename: buildDownloadFilename({
        url: variant.url,
        kind: group.kind,
        pageTitle,
        type: variant.type,
      }),
    }));
    return {
      ...group,
      variants,
      inspected: group.kind === 'direct',
      selectedIndex: 0,
      allowedOrigins: [],
      filename: variants[0].filename,
      format: mediaFormat(variants[0].url, group.kind),
    };
  });
}

export function bootPopup({ chromeApi = globalThis.chrome, documentApi = globalThis.document } = {}) {
  const root = documentApi.querySelector('#app');
  const announcer = documentApi.querySelector('#announcer');
  if (!root || !announcer || !chromeApi) return;

  let state = initialState;
  let activeTabId = null;
  let discoveryItemIds = new Set();
  let interactionGeneration = 0;
  let drawSuspended = false;
  let operationFlushScheduled = false;
  const pendingOperationRecords = new Map();

  const allItems = () => [...state.items, ...(state.downloads ?? [])];
  const findItem = (id) => allItems().find((item) => item.id === id);
  const focusKeys = ['quality', 'subtitle', 'download', 'inspect', 'cancel', 'pause', 'resume', 'reveal', 'authorize', 'scan', 'settings'];
  const draw = () => {
    const focused = documentApi.activeElement;
    const focusEntry = focusKeys.find((key) => Object.hasOwn(focused?.dataset ?? {}, key));
    const focusValue = focusEntry ? focused.dataset[focusEntry] : null;
    renderPopup(root, state);
    announcer.textContent = state.message;
    if (!focusEntry || typeof root.querySelectorAll !== 'function') return;
    const replacement = [...root.querySelectorAll(`[data-${focusEntry}]`)]
      .find((element) => element.dataset?.[focusEntry] === focusValue);
    replacement?.focus?.({ preventScroll: true });
  };
  const dispatch = (event) => {
    state = reduceState(state, event);
    if (!drawSuspended) draw();
  };

  const requestOrigins = (values) => requestHostOriginGrant(values, { chromeApi });

  async function readIndexed(storage, indexKey, prefix, normalizeIndex) {
    if (typeof storage?.get !== 'function') return [];
    const indexResult = await storage.get(indexKey);
    const ids = normalizeIndex(indexResult?.[indexKey]);
    if (ids.length === 0) return [];
    const keys = ids.map((id) => `${prefix}${id}`);
    const stored = await storage.get(keys);
    return ids.map((id) => stored?.[`${prefix}${id}`]).filter(Boolean);
  }

  async function readOperationRecords() {
    return readIndexed(
      chromeApi.storage?.session,
      HLS_OPERATION_INDEX,
      OPERATION_PREFIX,
      stringIndex,
    );
  }

  async function readRelocationRecords() {
    const storage = chromeApi.storage?.local;
    const [active, completed] = await Promise.all([
      readIndexed(storage, RELOCATION_INDEX, RELOCATION_PREFIX, downloadIdIndex),
      readIndexed(storage, DELIVERY_RESULT_INDEX, DELIVERY_RESULT_PREFIX, downloadIdIndex),
    ]);
    return [...active, ...completed];
  }

  async function readOperation(operationId) {
    const key = `${OPERATION_PREFIX}${operationId}`;
    const values = await chromeApi.storage.session.get(key);
    return values?.[key];
  }

  function handleOperationRecord(operationId, rawRecord) {
    if (!validOperationRecord(rawRecord) || rawRecord.operationId !== operationId) return;
    const existing = allItems().some((entry) => entry.operationId === operationId);
    if (existing) {
      dispatch({ type: 'HLS_OPERATION_UPDATED', operationId, record: rawRecord });
    } else {
      dispatch({ type: 'HLS_OPERATION_RESTORED', record: rawRecord });
    }
    if (rawRecord.state !== 'failed' || rawRecord.error?.code !== 'HLS_PERMISSION') return;
    const origins = permissionOriginsFromError(rawRecord.error);
    const item = allItems().find((entry) => entry.operationId === operationId);
    if (!item || origins.length === 0) return;
    dispatch({
      type: 'PERMISSION_REQUIRED',
      id: item.id,
      selectedIndex: item.selectedIndex ?? 0,
      origins,
    });
  }

  function queueOperationRecord(operationId, rawRecord) {
    if (rawRecord?.state !== 'assembling') {
      handleOperationRecord(operationId, rawRecord);
      return;
    }
    pendingOperationRecords.set(operationId, rawRecord);
    if (operationFlushScheduled) return;
    operationFlushScheduled = true;
    queueMicrotask(() => {
      operationFlushScheduled = false;
      const records = [...pendingOperationRecords.entries()];
      pendingOperationRecords.clear();
      for (const [pendingId, pendingRecord] of records) {
        handleOperationRecord(pendingId, pendingRecord);
      }
    });
  }

  async function restoreHlsOperations(generation) {
    let records;
    try {
      records = await readOperationRecords();
    } catch {
      return;
    }
    if (generation !== interactionGeneration) return;
    records = records
      .filter(validOperationRecord)
      .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
      .slice(0, 20);
    for (const record of records) {
      handleOperationRecord(record.operationId, record);
    }
  }

  async function reconcileOperations(items) {
    let records;
    try {
      records = (await readOperationRecords()).filter(validOperationRecord);
    } catch {
      return;
    }
    for (const item of items) {
      if (item.kind !== 'hls') continue;
      const record = findMatchingOperation(item, records);
      if (!record) continue;
      const selectedIndex = Math.max(0, item.variants.findIndex((variant) => {
        try {
          return canonicalMediaUrl(variant.url) === canonicalMediaUrl(record.url);
        } catch {
          return false;
        }
      }));
      dispatch({ type: 'HLS_OPERATION_RECONCILED', id: item.id, selectedIndex, record });
      if (record.state === 'failed' && record.error?.code === 'HLS_PERMISSION') {
        handleOperationRecord(record.operationId, record);
      }
    }
  }

  async function restoreYouTubeJob(generation) {
    try {
      const response = await chromeApi.runtime.sendMessage({
        target: 'background',
        action: YOUTUBE_ACTIONS.GET_JOB,
        payload: {},
      });
      if (generation !== interactionGeneration) return;
      const snapshot = unwrapYouTubeJob(response);
      if (snapshot) dispatch({ type: 'YOUTUBE_JOB_RESTORED', snapshot });
    } catch {
      // A failed restore must not hide the idle UI or HLS state.
    }
  }

  async function restoreDownloadQueue(generation) {
    try {
      const response = await chromeApi.runtime.sendMessage({
        target: 'background',
        action: YOUTUBE_ACTIONS.GET_QUEUE,
        payload: {},
      });
      if (generation !== interactionGeneration) return;
      dispatch({ type: 'DOWNLOAD_QUEUE_RESTORED', jobs: unwrapDownloadQueue(response) });
    } catch {
      try {
        const stored = await chromeApi.storage?.local?.get?.(DOWNLOAD_QUEUE_JOBS);
        if (generation !== interactionGeneration || !stored?.[DOWNLOAD_QUEUE_JOBS]) return;
        dispatch({
          type: 'DOWNLOAD_QUEUE_RESTORED',
          jobs: sanitizePublicQueueJobs(stored[DOWNLOAD_QUEUE_JOBS]),
        });
      } catch {
        // A later worker wake-up refreshes the native queue.
      }
    }
  }

  async function restoreRelocations(generation) {
    let records;
    try {
      records = await readRelocationRecords();
    } catch {
      return;
    }
    if (generation !== interactionGeneration) return;
    records.sort((left, right) => (right?.updatedAt ?? 0) - (left?.updatedAt ?? 0));
    for (const value of records.slice(0, 20)) {
      try {
        dispatch({ type: 'DOWNLOAD_RELOCATION_UPDATED', record: sanitizeRelocationRecord(value) });
      } catch {
        // Corrupt storage data must not enter popup state.
      }
    }
  }

  async function queryActiveTab() {
    if (typeof chromeApi.tabs?.query !== 'function') return null;
    const tabs = await chromeApi.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    return Number.isInteger(tab?.id) ? tab : null;
  }

  async function applyDiscovery(snapshot) {
    if (!snapshot || snapshot.tabId !== activeTabId) return;
    if (snapshot.status === 'scanning') {
      discoveryItemIds = new Set();
      dispatch({ type: 'SCAN_STARTED' });
      if (snapshot.kind === 'youtube' || snapshot.kind === 'remote-media') {
        dispatch({ type: 'MEDIA_LOOKUP_STARTED', target: snapshot.target });
      }
      return;
    }
    if (snapshot.status === 'error') {
      discoveryItemIds = new Set();
      dispatch({ type: 'SCAN_STARTED' });
      if (snapshot.kind === 'youtube' || snapshot.kind === 'remote-media') {
        dispatch({ type: 'MEDIA_LOOKUP_STARTED', target: snapshot.target });
      }
      dispatch({ type: 'FAILED', code: snapshot.errorCode });
      return;
    }
    if (snapshot.kind === 'youtube' || snapshot.kind === 'remote-media') {
      const formats = unwrapYouTubeFormats({ ok: true, value: snapshot.result });
      dispatch({
        type: 'YOUTUBE_FORMATS_LOADED',
        item: youtubeItem(formats, snapshot.mediaUrl),
        target: snapshot.target,
      });
      discoveryItemIds = new Set(state.items.map((item) => item.id));
      applyDiscoveryView(snapshot.view);
      return;
    }
    const items = scanItems(snapshot.result);
    dispatch({ type: 'SCAN_SUCCEEDED', items, target: snapshot.target });
    discoveryItemIds = new Set(items.map((item) => item.id));
    applyDiscoveryView(snapshot.view);
    await reconcileOperations(items);
  }

  function applyDiscoveryView(view) {
    for (const inspection of view?.inspections ?? []) {
      const item = state.items.find((entry) => entry.id === inspection.id);
      if (item?.kind !== 'hls') continue;
      dispatch({
        type: 'HLS_INSPECTED',
        id: inspection.id,
        variants: inspection.variants,
        allowedOrigins: inspection.allowedOrigins,
      });
    }
    for (const selection of view?.selections ?? []) {
      const item = state.items.find((entry) => entry.id === selection.id);
      if (!item || selection.selectedIndex >= (item.variants?.length ?? 0)) continue;
      dispatch({
        type: 'QUALITY_SELECTED',
        id: selection.id,
        selectedIndex: selection.selectedIndex,
      });
      if (Number.isSafeInteger(selection.subtitleIndex)
        && selection.subtitleIndex >= -1
        && selection.subtitleIndex < (item.subtitles?.length ?? 0)) {
        dispatch({
          type: 'SUBTITLE_SELECTED',
          id: selection.id,
          selectedIndex: selection.subtitleIndex,
        });
      }
    }
  }

  function discoveryView() {
    return {
      selections: state.items
        .filter((item) => (
          discoveryItemIds.has(item.id)
          && Number.isSafeInteger(item.selectedIndex)
          && item.selectedIndex >= 0
        ))
        .map((item) => ({
          id: item.id,
          selectedIndex: item.selectedIndex,
          ...(Number.isSafeInteger(item.selectedSubtitleIndex)
            ? { subtitleIndex: item.selectedSubtitleIndex }
            : {}),
        })),
      inspections: state.items
        .filter((item) => discoveryItemIds.has(item.id) && item.kind === 'hls' && item.inspected)
        .map((item) => ({
          id: item.id,
          variants: item.variants,
          allowedOrigins: item.allowedOrigins ?? [],
        })),
    };
  }

  async function persistDiscoveryView() {
    if (!Number.isInteger(activeTabId)) return;
    try {
      await chromeApi.runtime.sendMessage({
        target: 'background',
        action: DISCOVERY_ACTIONS.UPDATE_VIEW,
        payload: { tabId: activeTabId, view: discoveryView() },
      });
    } catch {
      // The visible state remains usable; the next interaction can persist it again.
    }
  }

  async function restoreDiscovery(generation) {
    try {
      const tab = await queryActiveTab();
      if (!tab || generation !== interactionGeneration) return;
      activeTabId = tab.id;
      const response = await chromeApi.runtime.sendMessage({
        target: 'background',
        action: DISCOVERY_ACTIONS.GET,
        payload: { tabId: tab.id },
      });
      if (generation !== interactionGeneration) return;
      await applyDiscovery(unwrapDiscovery(response));
    } catch {
      // Discovery recovery is best-effort; durable downloads are restored separately.
    }
  }

  async function scan() {
    interactionGeneration += 1;
    drawSuspended = false;
    dispatch({ type: 'SCAN_STARTED' });
    try {
      const tab = await queryActiveTab();
      if (!tab) throw Object.assign(new Error('Aba ativa indisponível'), { code: 'SCAN_FAILED' });
      activeTabId = tab.id;
      const mediaPage = canonicalMediaPage(tab.url);
      if (mediaPage) {
        dispatch({
          type: 'MEDIA_LOOKUP_STARTED',
          target: mediaPage.platform === 'x' ? 'x.com' : `${mediaPage.platform}.com`,
        });
      }
      const response = await chromeApi.runtime.sendMessage({
        target: 'background',
        action: DISCOVERY_ACTIONS.START,
        payload: { tabId: tab.id },
      });
      await applyDiscovery(unwrapDiscovery(response));
    } catch (error) {
      dispatch({ type: 'FAILED', code: error?.code ?? 'SCAN_FAILED' });
    }
  }

  async function inspect(item) {
    dispatch({ type: 'DOWNLOAD_STARTED', id: item.id, selectedIndex: 0, kind: 'hls' });
    try {
      const playlistUrl = item.variants[0].url;
      const { grant, inspection } = await runWithHostOriginGrant({
        chromeApi,
        values: [playlistUrl],
      }, async (acquired) => {
        const response = await chromeApi.runtime.sendMessage({
          target: 'background',
          action: ACTIONS.INSPECT_HLS,
          payload: {
            url: playlistUrl,
            permissionPatterns: acquired.patterns,
            permissionClaimId: acquired.permissionClaimId,
          },
        });
        return { grant: acquired, inspection: unwrapInspectResponse(response) };
      });
      dispatch({
        type: 'HLS_INSPECTED',
        id: item.id,
        variants: inspection.variants,
        allowedOrigins: grant.origins,
      });
      await persistDiscoveryView();
    } catch (error) {
      dispatch({ type: 'FAILED', id: item.id, code: error?.code ?? 'UNKNOWN', details: error?.details });
    }
  }

  async function startHls(item, selectedIndex, existingGrant) {
    const variant = item.variants[selectedIndex] ?? item.variants[0];
    dispatch({ type: 'DOWNLOAD_STARTED', id: item.id, selectedIndex, kind: 'hls' });
    try {
      const queued = await runWithHostOriginGrant({
        chromeApi,
        values: [variant.url],
        existingGrant,
      }, async (grant) => {
        const response = await chromeApi.runtime.sendMessage({
          target: 'background',
          action: ACTIONS.DOWNLOAD_HLS,
          payload: {
            url: variant.url,
            filename: item.filename,
            allowedOrigins: grant.origins,
            permissionPatterns: grant.patterns,
            permissionClaimId: grant.permissionClaimId,
          },
        });
        return unwrapQueuedResponse(response);
      });
      dispatch({
        type: 'HLS_QUEUED',
        id: item.id,
        operationId: queued.operationId,
        selectedIndex,
      });
      try {
        const record = await readOperation(queued.operationId);
        handleOperationRecord(queued.operationId, record);
      } catch {
        // The storage change listener will deliver the next durable state.
      }
    } catch (error) {
      const origins = permissionOriginsFromError(error);
      if (error?.code === 'HLS_PERMISSION' && origins.length > 0) {
        dispatch({ type: 'PERMISSION_REQUIRED', id: item.id, selectedIndex, origins });
        return;
      }
      dispatch({ type: 'FAILED', id: item.id, code: error?.code ?? 'UNKNOWN', details: error?.details });
    }
  }

  async function download(item, selectedIndex) {
    if (item.active || ['permission', 'preparing', 'sent'].includes(item.phase)) return;
    if (item.kind === 'youtube' || item.kind === 'remote-media') {
      const variant = item.variants[selectedIndex] ?? item.variants[0];
      dispatch({ type: 'MEDIA_DOWNLOAD_STARTED', id: item.id, selectedIndex, kind: item.kind });
      try {
        const subtitle = Number.isSafeInteger(item.selectedSubtitleIndex)
          && item.selectedSubtitleIndex >= 0
          ? item.subtitles?.[item.selectedSubtitleIndex]
          : null;
        const hasSubtitleCatalog = Array.isArray(item.subtitles);
        const baseSelection = variant.selection ?? {
          height: variant.height,
          audioOnly: false,
          subtitleLanguage: null,
          includeAutomaticSubtitles: false,
        };
        const selection = {
          ...baseSelection,
          subtitleLanguage: variant.audioOnly
            ? null
            : hasSubtitleCatalog ? subtitle?.language ?? null : baseSelection.subtitleLanguage,
          includeAutomaticSubtitles: variant.audioOnly
            ? false
            : hasSubtitleCatalog ? subtitle?.automatic === true : baseSelection.includeAutomaticSubtitles,
        };
        const response = await chromeApi.runtime.sendMessage({
          target: 'background',
          action: YOUTUBE_ACTIONS.START_DOWNLOAD,
          payload: { url: item.url, selection },
        });
        if (isYouTubeStartCancelled(response)) {
          dispatch({ type: 'YOUTUBE_START_CANCELLED', id: item.id });
          return;
        }
        const snapshot = unwrapYouTubeJob(response);
        if (snapshot) dispatch({ type: 'YOUTUBE_JOB_UPDATED', snapshot });
      } catch (error) {
        dispatch({
          type: 'FAILED',
          id: item.id,
          code: error?.code ?? (item.kind === 'remote-media' ? 'MEDIA_DOWNLOAD_FAILED' : 'YOUTUBE_DOWNLOAD'),
        });
      }
      return;
    }
    if (item.kind === 'hls') {
      await startHls(item, selectedIndex);
      return;
    }
    dispatch({ type: 'DOWNLOAD_STARTED', id: item.id, selectedIndex, kind: 'direct' });
    try {
      const variant = item.variants[selectedIndex] ?? item.variants[0];
      const response = await chromeApi.runtime.sendMessage({
        target: 'background',
        action: ACTIONS.DOWNLOAD_DIRECT,
        payload: { url: variant.url, filename: variant.filename ?? item.filename },
      });
      const { downloadId } = unwrapDirectResponse(response);
      dispatch({ type: 'DIRECT_SENT', id: item.id, selectedIndex, downloadId });
    } catch (error) {
      dispatch({ type: 'FAILED', id: item.id, code: error?.code ?? 'UNKNOWN', details: error?.details });
    }
  }

  async function authorizePending() {
    const pending = state.pendingPermission;
    if (!pending) return;
    const item = findItem(pending.id);
    if (!item) return;
    const variant = item.variants[pending.selectedIndex] ?? item.variants[0];
    try {
      const grant = await requestOrigins([variant.url, ...pending.origins]);
      await startHls(item, pending.selectedIndex, grant);
    } catch (error) {
      dispatch({ type: 'FAILED', id: item.id, code: error?.code ?? 'PERMISSION_DENIED', details: error?.details });
    }
  }

  async function cancel(item) {
    if (!['youtube', 'remote-media'].includes(item?.kind) || !item.jobId) return;
    try {
      const response = await chromeApi.runtime.sendMessage({
        target: 'background',
        action: YOUTUBE_ACTIONS.CANCEL_DOWNLOAD,
        payload: { jobId: item.jobId },
      });
      const job = sanitizePublicQueueJobs([unwrap(response, isObject)])[0];
      dispatch({ type: 'DOWNLOAD_QUEUE_JOB_UPDATED', job });
    } catch (error) {
      dispatch({
        type: 'FAILED',
        id: item.id,
        code: error?.code ?? (item.kind === 'remote-media' ? 'MEDIA_DOWNLOAD_FAILED' : 'YOUTUBE_DOWNLOAD'),
      });
    }
  }

  async function changeQueueState(item, action) {
    if (!item?.isQueueJob || !item.jobId) return;
    try {
      const response = await chromeApi.runtime.sendMessage({
        target: 'background',
        action,
        payload: { jobId: item.jobId },
      });
      const job = sanitizePublicQueueJobs([unwrap(response, isObject)])[0];
      dispatch({ type: 'DOWNLOAD_QUEUE_JOB_UPDATED', job });
    } catch (error) {
      dispatch({
        type: 'FAILED',
        id: item.id,
        code: error?.code ?? 'MEDIA_DOWNLOAD_FAILED',
      });
    }
  }

  async function reveal(item) {
    const visiblePath = item?.finalPath ?? item?.path;
    if (typeof visiblePath !== 'string' || !visiblePath.trim()) return;
    try {
      const response = await chromeApi.runtime.sendMessage({
        target: 'background',
        action: YOUTUBE_ACTIONS.REVEAL_DOWNLOADED_FILE,
        payload: { path: visiblePath.trim() },
      });
      unwrap(response, (value) => isObject(value) && value.revealed === true);
    } catch {
      dispatch({ type: 'REVEAL_FAILED', id: item.id });
    }
  }

  root.addEventListener('change', (event) => {
    const quality = event.target?.closest?.('[data-quality]');
    if (quality) {
      dispatch({ type: 'QUALITY_SELECTED', id: quality.dataset.quality, selectedIndex: Number(quality.value) });
      void persistDiscoveryView();
      return;
    }
    const subtitle = event.target?.closest?.('[data-subtitle]');
    if (subtitle) {
      dispatch({
        type: 'SUBTITLE_SELECTED',
        id: subtitle.dataset.subtitle,
        selectedIndex: Number(subtitle.value),
      });
      void persistDiscoveryView();
    }
  });

  root.addEventListener('click', (event) => {
    const target = event.target;
    if (target?.closest?.('[data-settings]')) {
      void chromeApi.runtime.openOptionsPage();
      return;
    }
    if (target?.closest?.('[data-scan]')) {
      scan();
      return;
    }
    const inspectButton = target?.closest?.('[data-inspect]');
    if (inspectButton) {
      const item = findItem(inspectButton.dataset.inspect);
      if (item) inspect(item);
      return;
    }
    const cancelButton = target?.closest?.('[data-cancel]');
    if (cancelButton) {
      const item = findItem(cancelButton.dataset.cancel);
      if (item) cancel(item);
      return;
    }
    const pauseButton = target?.closest?.('[data-pause]');
    if (pauseButton) {
      const item = findItem(pauseButton.dataset.pause);
      if (item) void changeQueueState(item, YOUTUBE_ACTIONS.PAUSE_DOWNLOAD);
      return;
    }
    const resumeButton = target?.closest?.('[data-resume]');
    if (resumeButton) {
      const item = findItem(resumeButton.dataset.resume);
      if (item) void changeQueueState(item, YOUTUBE_ACTIONS.RESUME_DOWNLOAD);
      return;
    }
    const revealButton = target?.closest?.('[data-reveal]');
    if (revealButton) {
      const item = findItem(revealButton.dataset.reveal);
      if (item) reveal(item);
      return;
    }
    const downloadButton = target?.closest?.('[data-download]');
    if (downloadButton) {
      const item = findItem(downloadButton.dataset.download);
      if (item) download(item, item.selectedIndex ?? 0);
      return;
    }
    if (target?.closest?.('[data-authorize]')) authorizePending();
  });

  chromeApi.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'session') {
      const discoveryChange = Number.isInteger(activeTabId)
        ? changes[`${DISCOVERY_PREFIX}${activeTabId}`]
        : null;
      if (discoveryChange?.newValue) {
        try {
          void applyDiscovery(sanitizeDiscoverySnapshot(discoveryChange.newValue));
        } catch {
          // Corrupt storage data must not enter popup state.
        }
      }
      for (const [key, change] of Object.entries(changes)) {
        if (!key.startsWith(OPERATION_PREFIX) || !change?.newValue) continue;
        queueOperationRecord(key.slice(OPERATION_PREFIX.length), change.newValue);
      }
      if (
        changes[HLS_OPERATION_INDEX]?.oldValue === undefined
        && changes[HLS_OPERATION_INDEX]?.newValue
      ) void restoreHlsOperations(interactionGeneration);
      return;
    }
    if (areaName !== 'local') return;
    if (changes.youtubeJob?.newValue) {
      try {
        const snapshot = sanitizeYouTubeJobSnapshot(changes.youtubeJob.newValue);
        dispatch({ type: 'YOUTUBE_JOB_UPDATED', snapshot });
      } catch {
        // Corrupt storage data must not enter popup state.
      }
    }
    if (changes[DOWNLOAD_QUEUE_JOBS]?.newValue) {
      try {
        dispatch({
          type: 'DOWNLOAD_QUEUE_RESTORED',
          jobs: sanitizePublicQueueJobs(changes[DOWNLOAD_QUEUE_JOBS].newValue),
        });
      } catch {
        // Corrupt storage data must not enter popup state.
      }
    }
    for (const [key, change] of Object.entries(changes)) {
      if ((!key.startsWith(RELOCATION_PREFIX) && !key.startsWith(DELIVERY_RESULT_PREFIX))
        || !change?.newValue) continue;
      try {
        dispatch({
          type: 'DOWNLOAD_RELOCATION_UPDATED',
          record: sanitizeRelocationRecord(change.newValue),
        });
      } catch {
        // Corrupt storage data must not enter popup state.
      }
    }
    if (
      (changes[RELOCATION_INDEX]?.oldValue === undefined && changes[RELOCATION_INDEX]?.newValue)
      || (changes[DELIVERY_RESULT_INDEX]?.oldValue === undefined
        && changes[DELIVERY_RESULT_INDEX]?.newValue)
    ) void restoreRelocations(interactionGeneration);
  });

  async function restorePopupState() {
    const generation = interactionGeneration;
    drawSuspended = true;
    try {
      await Promise.all([
        restoreDiscovery(generation),
        restoreHlsOperations(generation),
        restoreRelocations(generation),
        restoreYouTubeJob(generation),
        restoreDownloadQueue(generation),
      ]);
      if (generation === interactionGeneration) dispatch({ type: 'RESTORE_COMPLETED' });
    } finally {
      if (generation === interactionGeneration) {
        drawSuspended = false;
        draw();
      }
    }
  }

  draw();
  void restorePopupState();
}

if (typeof document !== 'undefined' && typeof chrome !== 'undefined') bootPopup();
