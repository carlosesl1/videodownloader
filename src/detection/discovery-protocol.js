import { normalizeCandidates } from './media-candidates.js';
import { assertFormatsResult, YOUTUBE_ACTIONS } from '../youtube/protocol.js';

export const DISCOVERY_ACTIONS = Object.freeze({
  START: 'DISCOVERY_START',
  GET: 'DISCOVERY_GET',
  UPDATE_VIEW: 'DISCOVERY_UPDATE_VIEW',
});

export const DISCOVERY_PREFIX = 'discovery:';

const STATUSES = new Set(['scanning', 'results', 'error']);
const KINDS = new Set(['page', 'youtube', 'remote-media']);
const SAFE_CODE = /^[A-Z0-9_]{1,64}$/;
const SNAPSHOT_FIELDS = [
  'schemaVersion', 'tabId', 'pageUrl', 'target', 'status', 'kind',
  'mediaUrl', 'result', 'view', 'errorCode', 'updatedAt',
];

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value, fields) {
  const keys = Object.keys(value);
  return keys.length === fields.length && keys.every((key) => fields.includes(key));
}

function boundedText(value, maximum, allowEmpty = false) {
  return typeof value === 'string'
    && value.length <= maximum
    && (allowEmpty || value.trim().length > 0);
}

function boundedJson(value, maximum) {
  try {
    return JSON.stringify(value).length <= maximum;
  } catch {
    return false;
  }
}

function httpUrl(value) {
  if (typeof value !== 'string') throw new Error('URL inválida');
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('URL inválida');
  parsed.hash = '';
  return parsed.href;
}

function copyCandidate(candidate) {
  const output = {
    url: candidate.url,
    kind: candidate.kind,
  };
  for (const [field, maximum] of [
    ['type', 200],
    ['label', 500],
    ['source', 50],
    ['groupKey', 128],
  ]) {
    if (boundedText(candidate[field], maximum, true)) output[field] = candidate[field];
  }
  for (const field of ['width', 'height']) {
    if (Number.isSafeInteger(candidate[field]) && candidate[field] >= 0) {
      output[field] = candidate[field];
    }
  }
  if (typeof candidate.startTime === 'number'
    && Number.isFinite(candidate.startTime)
    && candidate.startTime >= 0) {
    output.startTime = candidate.startTime;
  }
  return output;
}

export function sanitizePageScanResult(value) {
  if (!plainObject(value) || !Array.isArray(value.candidates)) {
    throw new Error('Resultado de varredura inválido');
  }
  const pageTitle = boundedText(value.pageTitle, 1_000, true) ? value.pageTitle : '';
  const candidates = normalizeCandidates(value.candidates)
    .filter((candidate) => boundedText(candidate.url, 8_192))
    .slice(0, 200)
    .map(copyCandidate);
  return { pageTitle, candidates };
}

export function sanitizeYouTubeCatalog(value) {
  const parsed = assertFormatsResult({
    type: 'formats',
    requestId: 'discovery',
    ...value,
  });
  return {
    ...(parsed.platform ? { platform: parsed.platform } : {}),
    videoId: parsed.videoId,
    title: parsed.title,
    durationSeconds: parsed.durationSeconds,
    qualities: parsed.qualities.map((quality) => ({ ...quality })),
  };
}

function sanitizeInspectionVariant(value) {
  if (!plainObject(value)
    || !boundedText(value.url, 8_192)
    || !boundedText(value.label, 200)
    || !Number.isSafeInteger(value.width)
    || value.width < 0
    || !Number.isSafeInteger(value.height)
    || value.height < 0
    || !Number.isSafeInteger(value.bandwidth)
    || value.bandwidth < 0
    || !(value.codecs === null || boundedText(value.codecs, 1_000, true))) {
    throw new Error('Visualização de descoberta inválida');
  }
  return {
    url: httpUrl(value.url),
    label: value.label,
    width: value.width,
    height: value.height,
    bandwidth: value.bandwidth,
    codecs: value.codecs,
  };
}

export function sanitizeDiscoveryView(value) {
  if (!boundedJson(value, 1024 * 1024)
    || !plainObject(value)
    || !hasOnlyKeys(value, ['selections', 'inspections'])
    || !Array.isArray(value.selections)
    || value.selections.length > 200
    || !Array.isArray(value.inspections)
    || value.inspections.length > 100) {
    throw new Error('Visualização de descoberta inválida');
  }
  const selections = value.selections.map((selection) => {
    if (!plainObject(selection)
      || !hasOnlyKeys(selection, ['id', 'selectedIndex'])
      || !boundedText(selection.id, 8_192)
      || !Number.isSafeInteger(selection.selectedIndex)
      || selection.selectedIndex < 0
      || selection.selectedIndex > 100) {
      throw new Error('Visualização de descoberta inválida');
    }
    return { id: selection.id, selectedIndex: selection.selectedIndex };
  });
  const inspections = value.inspections.map((inspection) => {
    if (!plainObject(inspection)
      || !hasOnlyKeys(inspection, ['id', 'variants', 'allowedOrigins'])
      || !boundedText(inspection.id, 8_192)
      || !Array.isArray(inspection.variants)
      || inspection.variants.length < 1
      || inspection.variants.length > 50
      || !Array.isArray(inspection.allowedOrigins)
      || inspection.allowedOrigins.length > 50) {
      throw new Error('Visualização de descoberta inválida');
    }
    const allowedOrigins = inspection.allowedOrigins.map((origin) => {
      const parsed = new URL(httpUrl(origin));
      if (parsed.origin !== origin) throw new Error('Visualização de descoberta inválida');
      return origin;
    });
    return {
      id: inspection.id,
      variants: inspection.variants.map(sanitizeInspectionVariant),
      allowedOrigins: [...new Set(allowedOrigins)],
    };
  });
  return { selections, inspections };
}

export function sanitizeDiscoverySnapshot(value) {
  if (!boundedJson(value, 2 * 1024 * 1024)
    || !plainObject(value)
    || !hasOnlyKeys(value, SNAPSHOT_FIELDS)
    || value.schemaVersion !== 1
    || !Number.isSafeInteger(value.tabId)
    || value.tabId < 0
    || !boundedText(value.target, 255)
    || !STATUSES.has(value.status)
    || !KINDS.has(value.kind)
    || !Number.isSafeInteger(value.updatedAt)
    || value.updatedAt < 0) {
    throw new Error('Estado de descoberta inválido');
  }

  const pageUrl = httpUrl(value.pageUrl);
  const mediaUrl = value.mediaUrl === null ? null : httpUrl(value.mediaUrl);
  const view = sanitizeDiscoveryView(value.view);
  let result = null;
  let errorCode = null;

  if (value.status === 'scanning') {
    if (value.result !== null || value.errorCode !== null) throw new Error('Estado de descoberta inválido');
  } else if (value.status === 'results') {
    if (value.errorCode !== null) throw new Error('Estado de descoberta inválido');
    result = value.kind === 'youtube' || value.kind === 'remote-media'
      ? sanitizeYouTubeCatalog(value.result)
      : sanitizePageScanResult(value.result);
  } else {
    if (value.result !== null || typeof value.errorCode !== 'string' || !SAFE_CODE.test(value.errorCode)) {
      throw new Error('Estado de descoberta inválido');
    }
    errorCode = value.errorCode;
  }

  if ((value.kind !== 'page') !== (mediaUrl !== null)) {
    throw new Error('Estado de descoberta inválido');
  }

  return {
    schemaVersion: 1,
    tabId: value.tabId,
    pageUrl,
    target: value.target,
    status: value.status,
    kind: value.kind,
    mediaUrl,
    result,
    view,
    errorCode,
    updatedAt: value.updatedAt,
  };
}

export function assertDiscoveryMessage(message) {
  if (!plainObject(message)
    || message.target !== 'background'
    || !Object.values(DISCOVERY_ACTIONS).includes(message.action)
    || !plainObject(message.payload)) {
    throw new Error('Mensagem inválida');
  }
  const fields = message.action === DISCOVERY_ACTIONS.UPDATE_VIEW
    ? ['tabId', 'view']
    : ['tabId'];
  if (!hasOnlyKeys(message.payload, fields)
    || !Number.isSafeInteger(message.payload.tabId)
    || message.payload.tabId < 0) throw new Error('Mensagem inválida');
  return {
    action: message.action,
    tabId: message.payload.tabId,
    ...(message.action === DISCOVERY_ACTIONS.UPDATE_VIEW
      ? { view: sanitizeDiscoveryView(message.payload.view) }
      : {}),
  };
}

export function youtubeFormatsMessage(url) {
  return {
    target: 'background',
    action: YOUTUBE_ACTIONS.LIST_FORMATS,
    payload: { url },
  };
}
