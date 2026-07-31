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
  downloadIdIndex,
  stringIndex,
} from '../shared/persistence-keys.js';
import { YOUTUBE_ACTIONS, assertFormatsResult } from '../youtube/protocol.js';
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
  const page = canonicalMediaPage(url);
  if (!videoId || !title || !page || page.canonicalUrl !== url
    || (page.platform === 'youtube' && page.mediaId !== videoId)
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
    const keys = value && Object.hasOwn(value, 'platform')
      ? ['platform', 'videoId', 'title', 'durationSeconds', 'qualities']
      : ['videoId', 'title', 'durationSeconds', 'qualities'];
    if (!isObject(value) || !hasOnlyKeys(value, keys)
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

function unwrapDiscovery(response) {
  const value = unwrap(response, (candidate) => candidate === null || isObject(candidate));
  return value === null ? null : sanitizeDiscoverySnapshot(value);
}

export function youtubeItem(formats, url) {
  const page = canonicalMediaPage(url);
  if (!page || (formats.platform && formats.platform !== page.platform)) {
    throw invalidYouTubeResponse();
  }
  const platform = formats.platform ?? page.platform;
  const variants = formats.qualities.map((quality) => ({
    ...quality,
    filename: `${formats.title}-${quality.label}.${quality.container}`,
  }));
  const first = variants[0];
  return {
    id: `${platform}:${formats.videoId}`,
    kind: platform === 'youtube' ? 'youtube' : 'remote-media',
    platform, url, title: formats.title, filename: first.filename, variants,
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
      urls.add(canonicalHlsIdentity(variant.url));
    } catch {
      // Invalid scan candidates are ignored before rendering.
    }
  }
  return records
    .filter((record) => validOperationRecord(record) && urls.has(canonicalHlsIdentity(record.url)))
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
  let activeTabId = null;
  let discoveryItemIds = new Set();
  let interactionGeneration = 0;
  let drawSuspended = false;
  let operationFlushScheduled = false;
  const pendingOperationRecords = new Map();

  const allItems = () => [...state.items, ...(state.downloads ?? [])];
  const findItem = (id) => allItems().find((item) => item.id === id);
  const focusKeys = ['quality', 'download', 'inspect', 'cancel', 'reveal', 'authorize', 'scan', 'settings'];
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

  async function requestOrigins(values) {
    const grant = buildOriginGrant(values);
    if (grant.patterns.length === 0) throw Object.assign(new Error('Sem origem para autorizar'), { code: 'PERMISSION_DENIED' });
    const alreadyGranted = await chromeApi.permissions.contains({ origins: grant.patterns });
    const granted = alreadyGranted || await chromeApi.permissions.request({ origins: grant.patterns });
    if (!granted) throw Object.assign(new Error('Acesso negado'), { code: 'PERMISSION_DENIED' });
    return grant;
  }

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
        .map((item) => ({ id: item.id, selectedIndex: item.selectedIndex })),
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
      await persistDiscoveryView();
    } catch (error) {
      dispatch({ type: 'FAILED', id: item.id, code: error?.code ?? 'UNKNOWN', details: error?.details });
    }
  }

  async function startHls(item, selectedIndex, existingGrant) {
    const variant = item.variants[selectedIndex] ?? item.variants[0];
    dispatch({ type: 'DOWNLOAD_STARTED', id: item.id, selectedIndex, kind: 'hls' });
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
    if (item.active || ['permission', 'preparing', 'sent'].includes(item.phase)) return;
    if (item.kind === 'youtube' || item.kind === 'remote-media') {
      const variant = item.variants[selectedIndex] ?? item.variants[0];
      dispatch({ type: 'MEDIA_DOWNLOAD_STARTED', id: item.id, selectedIndex, kind: item.kind });
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
      unwrap(response, (value) => isObject(value) && value.requested === true);
    } catch (error) {
      dispatch({
        type: 'FAILED',
        id: item.id,
        code: error?.code ?? (item.kind === 'remote-media' ? 'MEDIA_DOWNLOAD_FAILED' : 'YOUTUBE_DOWNLOAD'),
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
    const select = event.target?.closest?.('[data-quality]');
    if (!select) return;
    dispatch({ type: 'QUALITY_SELECTED', id: select.dataset.quality, selectedIndex: Number(select.value) });
    void persistDiscoveryView();
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
