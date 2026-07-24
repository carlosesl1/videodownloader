import { scanPage } from '../detection/scan-page.js';
import { groupDirectVariants, normalizeCandidates } from '../detection/media-candidates.js';
import { buildDownloadFilename } from '../shared/filename.js';
import { ACTIONS } from '../shared/messages.js';
import {
  DELIVERY_RESULT_PREFIX,
  RELOCATION_PREFIX,
} from '../background/download-relocation.js';
import { YOUTUBE_ACTIONS, assertFormatsResult } from '../youtube/protocol.js';
import { canonicalYouTubePageUrl } from '../youtube/page-url.js';
import { assertJobSnapshot } from '../youtube/job-view.js';
import { initialState, reduceState } from './state.js';
import { renderPopup } from './render.js';

const OPERATION_PREFIX = 'hlsOperation:';
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
const ERROR_CODE = /^[A-Z0-9_]{1,64}$/;
const RELOCATION_STATUSES = new Set(['downloading', 'moving', 'complete', 'moveFailed']);
const RELOCATION_MEDIA_KINDS = new Set(['direct', 'hls']);
const YOUTUBE_SNAPSHOT_FIELDS = [
  'jobId', 'videoId', 'title', 'url', 'height', 'format', 'stage', 'percent',
  'downloadedBytes', 'totalBytes', 'speedBytesPerSecond', 'etaSeconds', 'path', 'error', 'updatedAt',
];

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
  if (!isObject(value) || !hasOnlyKeys(value, YOUTUBE_SNAPSHOT_FIELDS)) throw invalidYouTubeResponse();
  const {
    jobId, videoId, title, url, height, format, stage, percent,
    downloadedBytes, totalBytes, speedBytesPerSecond, etaSeconds,
    path, error, updatedAt,
  } = value;
  let core;
  try {
    core = assertJobSnapshot({ jobId, videoId, title, height, stage, percent, path, errorCode: error });
  } catch {
    throw invalidYouTubeResponse();
  }
  if (!videoId || !title || canonicalYouTubePageUrl(url) !== url || !url.endsWith(`v=${videoId}`)
    || !(percent === null || (Number.isSafeInteger(percent) && percent >= 0 && percent <= 100))
    || ![downloadedBytes, totalBytes, speedBytesPerSecond, etaSeconds].every((entry) => entry === null || (Number.isSafeInteger(entry) && entry >= 0))
    || !(error === null || (typeof error === 'string' && ERROR_CODE.test(error)))
    || !Number.isSafeInteger(updatedAt) || updatedAt < 0
    || !isObject(format) || !hasOnlyKeys(format, ['height', 'label', 'container', 'combined'])) throw invalidYouTubeResponse();
  let validatedFormat;
  try {
    validatedFormat = assertFormatsResult({
      type: 'formats', requestId: 'popup', videoId, title, durationSeconds: null, qualities: [format],
    }).qualities[0];
  } catch {
    throw invalidYouTubeResponse();
  }
  if (validatedFormat.height !== core.height) throw invalidYouTubeResponse();
  return {
    jobId: core.jobId, videoId, title, url, height: core.height,
    format: { ...validatedFormat }, stage: core.stage, percent,
    downloadedBytes, totalBytes, speedBytesPerSecond, etaSeconds,
    path: core.path, error, updatedAt,
  };
}

export function unwrapYouTubeFormats(response) {
  const catalog = unwrap(response, (value) => {
    if (!isObject(value) || !hasOnlyKeys(value, ['videoId', 'title', 'durationSeconds', 'qualities'])
      || !Array.isArray(value.qualities)
      || !value.qualities.every((quality) => isObject(quality) && hasOnlyKeys(quality, ['height', 'label', 'container', 'combined']))) return false;
    try {
      assertFormatsResult({ type: 'formats', requestId: 'popup', ...value });
      return true;
    } catch {
      return false;
    }
  });
  const parsed = assertFormatsResult({ type: 'formats', requestId: 'popup', ...catalog });
  return { ...parsed, qualities: parsed.qualities.map((quality) => ({ ...quality })) };
}

export function unwrapYouTubeJob(response) {
  const value = unwrap(response, (candidate) => candidate === null || isObject(candidate));
  return value === null ? null : sanitizeYouTubeJobSnapshot(value);
}

export function youtubeItem(formats, url) {
  const variants = formats.qualities.map((quality) => ({
    ...quality,
    filename: `${formats.title}-${quality.label}.${quality.container}`,
  }));
  const first = variants[0];
  return {
    id: `youtube:${formats.videoId}`,
    kind: 'youtube', url, title: formats.title, filename: first.filename, variants,
    selectedIndex: 0, predictedFormat: first.container, phase: 'ready', jobId: null,
    active: false, progress: null, statusLabel: '', path: null, error: null,
  };
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
  const urls = new Set();
  for (const variant of item?.variants ?? []) {
    try {
      urls.add(canonicalMediaUrl(variant.url));
    } catch {
      // Invalid scan candidates are ignored before rendering.
    }
  }
  return records
    .filter((record) => validOperationRecord(record) && urls.has(canonicalMediaUrl(record.url)))
    .sort((left, right) => {
      const [leftActive, leftTime] = operationPriority(left);
      const [rightActive, rightTime] = operationPriority(right);
      return rightActive - leftActive || rightTime - leftTime;
    })[0];
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
      filename: buildDownloadFilename({ url: variant.url, kind: group.kind, pageTitle }),
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

  const draw = () => {
    renderPopup(root, state);
    announcer.textContent = state.message;
  };
  const dispatch = (event) => {
    state = reduceState(state, event);
    draw();
  };

  async function requestOrigins(values) {
    const grant = buildOriginGrant(values);
    if (grant.patterns.length === 0) throw Object.assign(new Error('Sem origem para autorizar'), { code: 'PERMISSION_DENIED' });
    const alreadyGranted = await chromeApi.permissions.contains({ origins: grant.patterns });
    const granted = alreadyGranted || await chromeApi.permissions.request({ origins: grant.patterns });
    if (!granted) throw Object.assign(new Error('Acesso negado'), { code: 'PERMISSION_DENIED' });
    return grant;
  }

  async function readOperation(operationId) {
    const key = `${OPERATION_PREFIX}${operationId}`;
    const values = await chromeApi.storage.session.get(key);
    return values?.[key];
  }

  function handleOperationRecord(operationId, rawRecord) {
    if (!validOperationRecord(rawRecord) || rawRecord.operationId !== operationId) return;
    const existing = state.items.some((entry) => entry.operationId === operationId);
    if (existing) {
      dispatch({ type: 'HLS_OPERATION_UPDATED', operationId, record: rawRecord });
    } else if (ACTIVE_OPERATION_STATES.has(rawRecord.state)) {
      dispatch({ type: 'HLS_OPERATION_RESTORED', record: rawRecord });
    }
    if (rawRecord.state !== 'failed' || rawRecord.error?.code !== 'HLS_PERMISSION') return;
    const origins = permissionOriginsFromError(rawRecord.error);
    const item = state.items.find((entry) => entry.operationId === operationId);
    if (!item || origins.length === 0) return;
    dispatch({
      type: 'PERMISSION_REQUIRED',
      id: item.id,
      selectedIndex: item.selectedIndex ?? 0,
      origins,
    });
  }

  async function restoreHlsOperations() {
    let stored;
    try {
      stored = await chromeApi.storage.session.get(null);
    } catch {
      return;
    }
    const records = Object.entries(stored ?? {})
      .filter(([key]) => key.startsWith(OPERATION_PREFIX))
      .map(([, value]) => value)
      .filter((record) => validOperationRecord(record) && ACTIVE_OPERATION_STATES.has(record.state));
    for (const record of records) {
      handleOperationRecord(record.operationId, record);
    }
  }

  async function reconcileOperations(items) {
    let stored;
    try {
      stored = await chromeApi.storage.session.get(null);
    } catch {
      return;
    }
    const records = Object.entries(stored ?? {})
      .filter(([key]) => key.startsWith(OPERATION_PREFIX))
      .map(([, value]) => value)
      .filter(validOperationRecord);
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

  async function restoreYouTubeJob() {
    try {
      const response = await chromeApi.runtime.sendMessage({
        target: 'background',
        action: YOUTUBE_ACTIONS.GET_JOB,
        payload: {},
      });
      const snapshot = unwrapYouTubeJob(response);
      if (snapshot) dispatch({ type: 'YOUTUBE_JOB_RESTORED', snapshot });
    } catch {
      // A failed restore must not hide the idle UI or HLS state.
    }
  }

  async function restoreRelocations() {
    let stored;
    try {
      stored = await chromeApi.storage?.local?.get?.(null);
    } catch {
      return;
    }
    for (const [key, value] of Object.entries(stored ?? {})) {
      if (!key.startsWith(RELOCATION_PREFIX) && !key.startsWith(DELIVERY_RESULT_PREFIX)) continue;
      try {
        dispatch({ type: 'DOWNLOAD_RELOCATION_UPDATED', record: sanitizeRelocationRecord(value) });
      } catch {
        // Corrupt storage data must not enter popup state.
      }
    }
  }

  async function scan() {
    dispatch({ type: 'SCAN_STARTED' });
    try {
      const tabs = await chromeApi.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (!Number.isInteger(tab?.id)) throw new Error('Aba ativa indisponível');
      const youtubeUrl = canonicalYouTubePageUrl(tab.url);
      if (youtubeUrl) {
        const response = await chromeApi.runtime.sendMessage({
          target: 'background',
          action: YOUTUBE_ACTIONS.LIST_FORMATS,
          payload: { url: youtubeUrl },
        });
        const formats = unwrapYouTubeFormats(response);
        dispatch({ type: 'YOUTUBE_FORMATS_LOADED', item: youtubeItem(formats, youtubeUrl), target: 'youtube.com' });
        return;
      }
      const executions = await chromeApi.scripting.executeScript({
        target: { tabId: tab.id },
        func: scanPage,
      });
      const items = scanItems(executions?.[0]?.result);
      let target = 'aba atual';
      try {
        target = httpUrl(tab.url).host;
      } catch {
        // Restricted pages are surfaced by executeScript when scanning is attempted.
      }
      dispatch({ type: 'SCAN_SUCCEEDED', items, target });
      await reconcileOperations(items);
    } catch (error) {
      dispatch({ type: 'FAILED', code: error?.code ?? 'SCAN_FAILED' });
    }
  }

  async function inspect(item) {
    dispatch({ type: 'DOWNLOAD_STARTED', id: item.id, selectedIndex: 0 });
    try {
      const playlistUrl = item.variants[0].url;
      const grant = await requestOrigins([playlistUrl]);
      const response = await chromeApi.runtime.sendMessage({
        target: 'background',
        action: ACTIONS.INSPECT_HLS,
        payload: { url: playlistUrl, permissionPatterns: grant.patterns },
      });
      const inspection = unwrapInspectResponse(response);
      dispatch({
        type: 'HLS_INSPECTED',
        id: item.id,
        variants: inspection.variants,
        allowedOrigins: grant.origins,
      });
    } catch (error) {
      dispatch({ type: 'FAILED', id: item.id, code: error?.code ?? 'UNKNOWN', details: error?.details });
    }
  }

  async function startHls(item, selectedIndex, existingGrant) {
    const variant = item.variants[selectedIndex] ?? item.variants[0];
    dispatch({ type: 'DOWNLOAD_STARTED', id: item.id, selectedIndex });
    try {
      const grant = existingGrant ?? await requestOrigins([variant.url]);
      const response = await chromeApi.runtime.sendMessage({
        target: 'background',
        action: ACTIONS.DOWNLOAD_HLS,
        payload: {
          url: variant.url,
          filename: item.filename,
          allowedOrigins: grant.origins,
          permissionPatterns: grant.patterns,
        },
      });
      const queued = unwrapQueuedResponse(response);
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
    if (item.kind === 'youtube') {
      const variant = item.variants[selectedIndex] ?? item.variants[0];
      try {
        const response = await chromeApi.runtime.sendMessage({
          target: 'background',
          action: YOUTUBE_ACTIONS.START_DOWNLOAD,
          payload: { url: item.url, height: variant.height },
        });
        if (isYouTubeStartCancelled(response)) {
          dispatch({ type: 'YOUTUBE_START_CANCELLED', id: item.id });
          return;
        }
        const snapshot = unwrapYouTubeJob(response);
        if (snapshot) dispatch({ type: 'YOUTUBE_JOB_UPDATED', snapshot });
      } catch (error) {
        dispatch({ type: 'FAILED', id: item.id, code: error?.code ?? 'YOUTUBE_DOWNLOAD' });
      }
      return;
    }
    if (item.kind === 'hls') {
      await startHls(item, selectedIndex);
      return;
    }
    dispatch({ type: 'DOWNLOAD_STARTED', id: item.id, selectedIndex });
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
    const item = state.items.find((entry) => entry.id === pending.id);
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
    if (item?.kind !== 'youtube' || !item.jobId) return;
    try {
      const response = await chromeApi.runtime.sendMessage({
        target: 'background',
        action: YOUTUBE_ACTIONS.CANCEL_DOWNLOAD,
        payload: { jobId: item.jobId },
      });
      unwrap(response, (value) => isObject(value) && value.requested === true);
    } catch (error) {
      dispatch({ type: 'FAILED', id: item.id, code: error?.code ?? 'YOUTUBE_DOWNLOAD' });
    }
  }

  root.addEventListener('change', (event) => {
    const select = event.target?.closest?.('[data-quality]');
    if (!select) return;
    dispatch({ type: 'QUALITY_SELECTED', id: select.dataset.quality, selectedIndex: Number(select.value) });
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
      const item = state.items.find((entry) => entry.id === inspectButton.dataset.inspect);
      if (item) inspect(item);
      return;
    }
    const cancelButton = target?.closest?.('[data-cancel]');
    if (cancelButton) {
      const item = state.items.find((entry) => entry.id === cancelButton.dataset.cancel);
      if (item) cancel(item);
      return;
    }
    const downloadButton = target?.closest?.('[data-download]');
    if (downloadButton) {
      const item = state.items.find((entry) => entry.id === downloadButton.dataset.download);
      if (item) download(item, item.selectedIndex ?? 0);
      return;
    }
    if (target?.closest?.('[data-authorize]')) authorizePending();
  });

  chromeApi.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'session') {
      for (const [key, change] of Object.entries(changes)) {
        if (!key.startsWith(OPERATION_PREFIX) || !change?.newValue) continue;
        handleOperationRecord(key.slice(OPERATION_PREFIX.length), change.newValue);
      }
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
  });

  draw();
  void restoreHlsOperations();
  void restoreRelocations();
  void restoreYouTubeJob();
}

if (typeof document !== 'undefined' && typeof chrome !== 'undefined') bootPopup();
