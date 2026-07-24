import {
  HOST_COMMANDS,
  HOST_EVENTS,
  assertHostEvent,
} from '../youtube/protocol.js';
import { normalizeWindowsFolder } from '../shared/download-preferences.js';

export const RELOCATION_PREFIX = 'downloadRelocation:';
export const DELIVERY_RESULT_PREFIX = 'downloadDeliveryResult:';

const ACTIVE_STATUSES = new Set(['downloading', 'moving', 'moveFailed']);
const MEDIA_KINDS = new Set(['direct', 'hls']);
const SAFE_OPERATION_ID = /^[A-Za-z0-9_-]{1,128}$/;

function key(downloadId) {
  return `${RELOCATION_PREFIX}${downloadId}`;
}

function resultKey(downloadId) {
  return `${DELIVERY_RESULT_PREFIX}${downloadId}`;
}

function validDownloadId(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function timestamp(now) {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Relógio inválido.');
  return value;
}

function validateTrackRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || !validDownloadId(record.downloadId)
    || typeof record.operationId !== 'string'
    || !SAFE_OPERATION_ID.test(record.operationId)
    || !MEDIA_KINDS.has(record.mediaKind)
    || typeof record.mediaUrl !== 'string'
    || !/^https?:\/\//.test(record.mediaUrl)
    || typeof record.displayName !== 'string'
    || record.displayName.length === 0
    || record.displayName.length > 255) {
    throw new Error('Registro de entrega inválido.');
  }
  return {
    downloadId: record.downloadId,
    operationId: record.operationId,
    destinationFolder: normalizeWindowsFolder(record.destinationFolder),
    mediaKind: record.mediaKind,
    mediaUrl: record.mediaUrl,
    displayName: record.displayName,
  };
}

export function createDownloadRelocationCoordinator({
  storageLocal,
  downloads,
  nativeClient,
  now = Date.now,
}) {
  if (typeof storageLocal?.get !== 'function'
    || typeof storageLocal?.set !== 'function'
    || typeof storageLocal?.remove !== 'function'
    || typeof downloads?.search !== 'function'
    || typeof nativeClient?.request !== 'function'
    || typeof now !== 'function') {
    throw new TypeError('Dependências inválidas da entrega de downloads.');
  }

  const inFlight = new Map();

  async function get(downloadId) {
    if (!validDownloadId(downloadId)) return null;
    const activeKey = key(downloadId);
    const active = await storageLocal.get(activeKey);
    if (active?.[activeKey]) return active[activeKey];
    const completedKey = resultKey(downloadId);
    const completed = await storageLocal.get(completedKey);
    return completed?.[completedKey] ?? null;
  }

  async function put(record) {
    await storageLocal.set({ [key(record.downloadId)]: record });
    return record;
  }

  async function track(record) {
    const valid = validateTrackRecord(record);
    return put({
      ...valid,
      status: 'downloading',
      stagingPath: null,
      finalPath: null,
      errorCode: null,
      updatedAt: timestamp(now),
    });
  }

  async function pruneResults() {
    const all = await storageLocal.get(null);
    const results = Object.entries(all ?? {})
      .filter(([name]) => name.startsWith(DELIVERY_RESULT_PREFIX))
      .sort(([, left], [, right]) => (right?.updatedAt ?? 0) - (left?.updatedAt ?? 0));
    const expired = results.slice(50).map(([name]) => name);
    if (expired.length > 0) await storageLocal.remove(expired);
  }

  async function deliverOnce(downloadId) {
    const record = await get(downloadId);
    if (!record || record.status === 'complete') return;
    if (!ACTIVE_STATUSES.has(record.status)) return;

    const items = await downloads.search({ id: downloadId });
    const item = Array.isArray(items) ? items.find(({ id }) => id === downloadId) : null;
    if (!item || item.state !== 'complete' || typeof item.filename !== 'string'
      || item.filename.length === 0) return;

    const moving = {
      ...record,
      status: 'moving',
      stagingPath: item.filename,
      finalPath: null,
      errorCode: null,
      updatedAt: timestamp(now),
    };
    await put(moving);

    try {
      const moved = assertHostEvent(await nativeClient.request(
        HOST_COMMANDS.MOVE_DOWNLOADED_FILE,
        {
          downloadId,
          sourcePath: item.filename,
          destinationFolder: record.destinationFolder,
        },
      ));
      if (moved.type !== HOST_EVENTS.FILE_MOVED || moved.downloadId !== downloadId) {
        throw new Error('Resposta de entrega inválida.');
      }
      const completed = {
        ...moving,
        status: 'complete',
        finalPath: moved.finalPath,
        errorCode: null,
        updatedAt: timestamp(now),
      };
      await storageLocal.set({ [resultKey(downloadId)]: completed });
      await storageLocal.remove(key(downloadId));
      await pruneResults();
    } catch {
      await put({
        ...moving,
        status: 'moveFailed',
        finalPath: null,
        errorCode: 'DESTINATION_MOVE_FAILED',
        updatedAt: timestamp(now),
      });
    }
  }

  function deliver(downloadId) {
    if (!validDownloadId(downloadId)) return Promise.resolve();
    if (inFlight.has(downloadId)) return inFlight.get(downloadId);
    const work = deliverOnce(downloadId).finally(() => {
      if (inFlight.get(downloadId) === work) inFlight.delete(downloadId);
    });
    inFlight.set(downloadId, work);
    return work;
  }

  async function handleChanged(delta) {
    if (validDownloadId(delta?.id) && delta?.state?.current === 'complete') {
      await deliver(delta.id);
    }
  }

  async function reconcile() {
    const all = await storageLocal.get(null);
    const pending = Object.entries(all ?? {})
      .filter(([name, record]) => name.startsWith(RELOCATION_PREFIX)
        && record && ACTIVE_STATUSES.has(record.status))
      .map(([, record]) => record.downloadId)
      .filter(validDownloadId);
    await Promise.all(pending.map(deliver));
  }

  return Object.freeze({ get, track, deliver, handleChanged, reconcile });
}
