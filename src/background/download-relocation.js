import {
  HOST_COMMANDS,
  HOST_EVENTS,
  assertHostEvent,
} from '../youtube/protocol.js';
import { normalizeWindowsFolder } from '../shared/download-preferences.js';
import {
  DELIVERY_RESULT_INDEX,
  DELIVERY_RESULT_PREFIX,
  RELOCATION_INDEX,
  RELOCATION_INDEX_MIGRATION,
  RELOCATION_PREFIX,
  downloadIdIndex,
} from '../shared/persistence-keys.js';

export { DELIVERY_RESULT_PREFIX, RELOCATION_PREFIX };

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
  let indexQueue = Promise.resolve();
  let indexesReady;

  function serializedIndex(operation) {
    const work = indexQueue.then(operation, operation);
    indexQueue = work.catch(() => {});
    return work;
  }

  function validIndex(value) {
    return Array.isArray(value) && value.every(validDownloadId);
  }

  function scanIndex(entries, prefix) {
    return Object.entries(entries ?? {})
      .filter(([name, record]) => (
        name.startsWith(prefix)
        && validDownloadId(record?.downloadId)
        && name === `${prefix}${record.downloadId}`
      ))
      .map(([, record]) => record.downloadId);
  }

  async function ensureIndexes() {
    if (!indexesReady) {
      indexesReady = (async () => {
        const stored = await storageLocal.get([
          RELOCATION_INDEX,
          DELIVERY_RESULT_INDEX,
          RELOCATION_INDEX_MIGRATION,
        ]);
        if (
          stored?.[RELOCATION_INDEX_MIGRATION] === 1
          && validIndex(stored?.[RELOCATION_INDEX])
          && validIndex(stored?.[DELIVERY_RESULT_INDEX])
        ) return;
        const entries = await storageLocal.get(null);
        await storageLocal.set({
          [RELOCATION_INDEX]: scanIndex(entries, RELOCATION_PREFIX),
          [DELIVERY_RESULT_INDEX]: scanIndex(entries, DELIVERY_RESULT_PREFIX),
          [RELOCATION_INDEX_MIGRATION]: 1,
        });
      })().catch((error) => {
        indexesReady = undefined;
        throw error;
      });
    }
    await indexesReady;
  }

  async function indexedRecords(indexName, prefix) {
    await ensureIndexes();
    const stored = await storageLocal.get(indexName);
    const indexed = downloadIdIndex(stored?.[indexName]);
    if (indexed.length === 0) return [];
    const entries = await storageLocal.get(indexed.map((downloadId) => `${prefix}${downloadId}`));
    const records = [];
    const repaired = [];
    for (const downloadId of indexed) {
      const record = entries?.[`${prefix}${downloadId}`];
      if (!record || record.downloadId !== downloadId) continue;
      repaired.push(downloadId);
      records.push(record);
    }
    if (repaired.length !== indexed.length) {
      await storageLocal.set({ [indexName]: repaired });
    }
    return records;
  }

  async function put(record) {
    return serializedIndex(async () => {
      await ensureIndexes();
      const stored = await storageLocal.get(RELOCATION_INDEX);
      const indexed = downloadIdIndex(stored?.[RELOCATION_INDEX]);
      if (!indexed.includes(record.downloadId)) indexed.push(record.downloadId);
      await storageLocal.set({
        [key(record.downloadId)]: record,
        [RELOCATION_INDEX]: indexed,
      });
      return record;
    });
  }

  async function get(downloadId) {
    if (!validDownloadId(downloadId)) return null;
    const activeKey = key(downloadId);
    const active = await storageLocal.get(activeKey);
    if (active?.[activeKey]) return active[activeKey];
    const completedKey = resultKey(downloadId);
    const completed = await storageLocal.get(completedKey);
    return completed?.[completedKey] ?? null;
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
    await serializedIndex(async () => {
      const results = (await indexedRecords(DELIVERY_RESULT_INDEX, DELIVERY_RESULT_PREFIX))
        .sort((left, right) => (right?.updatedAt ?? 0) - (left?.updatedAt ?? 0));
      const expired = results.slice(50);
      if (expired.length === 0) return;
      const expiredIds = new Set(expired.map((record) => record.downloadId));
      await storageLocal.remove(expired.map((record) => resultKey(record.downloadId)));
      await storageLocal.set({
        [DELIVERY_RESULT_INDEX]: results
          .map((record) => record.downloadId)
          .filter((downloadId) => !expiredIds.has(downloadId)),
      });
    });
  }

  async function pruneFailures() {
    await serializedIndex(async () => {
      const records = await indexedRecords(RELOCATION_INDEX, RELOCATION_PREFIX);
      const failures = records
        .filter((record) => record.status === 'moveFailed')
        .sort((left, right) => (right?.updatedAt ?? 0) - (left?.updatedAt ?? 0));
      const expired = failures.slice(20);
      if (expired.length === 0) return;
      const expiredIds = new Set(expired.map((record) => record.downloadId));
      await storageLocal.remove(expired.map((record) => key(record.downloadId)));
      await storageLocal.set({
        [RELOCATION_INDEX]: records
          .map((record) => record.downloadId)
          .filter((downloadId) => !expiredIds.has(downloadId)),
      });
    });
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
      await serializedIndex(async () => {
        await ensureIndexes();
        const stored = await storageLocal.get([RELOCATION_INDEX, DELIVERY_RESULT_INDEX]);
        const active = downloadIdIndex(stored?.[RELOCATION_INDEX])
          .filter((entry) => entry !== downloadId);
        const completedIds = downloadIdIndex(stored?.[DELIVERY_RESULT_INDEX]);
        if (!completedIds.includes(downloadId)) completedIds.push(downloadId);
        await storageLocal.set({
          [resultKey(downloadId)]: completed,
          [RELOCATION_INDEX]: active,
          [DELIVERY_RESULT_INDEX]: completedIds,
        });
        await storageLocal.remove(key(downloadId));
      });
      await pruneResults();
    } catch {
      await put({
        ...moving,
        status: 'moveFailed',
        finalPath: null,
        errorCode: 'DESTINATION_MOVE_FAILED',
        updatedAt: timestamp(now),
      });
      await pruneFailures();
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
    const records = await serializedIndex(() => indexedRecords(RELOCATION_INDEX, RELOCATION_PREFIX));
    const pending = records
      .filter((record) => ACTIVE_STATUSES.has(record.status))
      .map((record) => record.downloadId)
      .filter(validDownloadId);
    await Promise.all(pending.map(deliver));
  }

  return Object.freeze({ get, track, deliver, handleChanged, reconcile });
}
