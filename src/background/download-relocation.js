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
  RELOCATION_INTENT_INDEX,
  RELOCATION_INDEX_MIGRATION,
  RELOCATION_PREFIX,
  downloadIdIndex,
  stringIndex,
} from '../shared/persistence-keys.js';

export { DELIVERY_RESULT_PREFIX, RELOCATION_PREFIX };

const ACTIVE_STATUSES = new Set(['downloading', 'moving', 'moveFailed']);
const FAILURE_STATUSES = new Set(['moveFailed', 'interrupted']);
const MEDIA_KINDS = new Set(['direct', 'hls']);
const SAFE_OPERATION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const INTENT_PREFIX = `${RELOCATION_PREFIX}intent:`;
const INTENT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

function key(downloadId) {
  return `${RELOCATION_PREFIX}${downloadId}`;
}

function resultKey(downloadId) {
  return `${DELIVERY_RESULT_PREFIX}${downloadId}`;
}

function intentKey(operationId) {
  return `${INTENT_PREFIX}${operationId}`;
}

function validDownloadId(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function operationIdIndex(value) {
  return stringIndex(value).filter((entry) => SAFE_OPERATION_ID.test(entry)).slice(0, 100);
}

function timestamp(now) {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Relógio inválido.');
  return value;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hlsStagingFilenameRegex(intent) {
  return `[\\\\/]Video Radar[\\\\/]\\.staging[\\\\/]${escapeRegex(intent.operationId)}`
    + `[\\\\/]${escapeRegex(intent.displayName)}$`;
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
  scheduleMaintenance = () => {},
}) {
  if (typeof storageLocal?.get !== 'function'
    || typeof storageLocal?.set !== 'function'
    || typeof storageLocal?.remove !== 'function'
    || typeof downloads?.search !== 'function'
    || typeof nativeClient?.request !== 'function'
    || typeof now !== 'function'
    || typeof scheduleMaintenance !== 'function') {
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

  async function createIntent(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)
      || record.downloadId !== null) throw new Error('Intenção de entrega inválida.');
    if (typeof record.operationId !== 'string' || !SAFE_OPERATION_ID.test(record.operationId)
      || !MEDIA_KINDS.has(record.mediaKind)
      || typeof record.mediaUrl !== 'string' || !/^https?:\/\//.test(record.mediaUrl)
      || typeof record.displayName !== 'string' || record.displayName.length === 0
      || record.displayName.length > 255) throw new Error('Intenção de entrega inválida.');
    const destinationFolder = record.destinationFolder === null
      ? null
      : normalizeWindowsFolder(record.destinationFolder);
    if (record.mediaKind === 'hls' && destinationFolder === null) {
      throw new Error('Intenção de entrega inválida.');
    }
    return serializedIndex(async () => {
      const stored = await storageLocal.get(RELOCATION_INTENT_INDEX);
      const intents = operationIdIndex(stored?.[RELOCATION_INTENT_INDEX]);
      if (!intents.includes(record.operationId)) intents.push(record.operationId);
      await storageLocal.set({
        [intentKey(record.operationId)]: {
          operationId: record.operationId,
          downloadId: null,
          destinationFolder,
          mediaKind: record.mediaKind,
          mediaUrl: record.mediaUrl,
          displayName: record.displayName,
          status: 'starting',
          stagingPath: null,
          finalPath: null,
          errorCode: null,
          updatedAt: timestamp(now),
        },
        [RELOCATION_INTENT_INDEX]: intents,
      });
    });
  }

  async function bindIntent(operationId, downloadId) {
    if (typeof operationId !== 'string' || !SAFE_OPERATION_ID.test(operationId)
      || !validDownloadId(downloadId)) throw new Error('Intenção de entrega inválida.');
    const pendingKey = intentKey(operationId);
    return serializedIndex(async () => {
      await ensureIndexes();
      const stored = await storageLocal.get([
        pendingKey,
        RELOCATION_INTENT_INDEX,
        RELOCATION_INDEX,
        DELIVERY_RESULT_INDEX,
      ]);
      const intent = stored?.[pendingKey];
      if (!intent || intent.operationId !== operationId || intent.status !== 'starting') {
        throw new Error('Intenção de entrega ausente.');
      }
      const activeIds = downloadIdIndex(stored?.[RELOCATION_INDEX]);
      const completedIds = downloadIdIndex(stored?.[DELIVERY_RESULT_INDEX]);
      const recordKeys = [
        ...activeIds.map(key),
        ...completedIds.map(resultKey),
        key(downloadId),
        resultKey(downloadId),
      ];
      const records = await storageLocal.get([...new Set(recordKeys)]);
      for (const [recordKey, existing] of Object.entries(records ?? {})) {
        if (!existing || !validDownloadId(existing.downloadId)
          || typeof existing.operationId !== 'string') continue;
        if (existing.downloadId === downloadId && existing.operationId === operationId) {
          await storageLocal.set({
            [RELOCATION_INTENT_INDEX]: operationIdIndex(stored?.[RELOCATION_INTENT_INDEX])
              .filter((entry) => entry !== operationId),
          });
          await storageLocal.remove(pendingKey);
          return existing;
        }
        if (existing.downloadId === downloadId || existing.operationId === operationId) {
          throw new Error(`Entrega já vinculada (${recordKey}).`);
        }
      }
      const indexed = activeIds;
      if (!indexed.includes(downloadId)) indexed.push(downloadId);
      const bound = {
        ...intent,
        downloadId,
        status: 'downloading',
        updatedAt: timestamp(now),
      };
      await storageLocal.set({
        [key(downloadId)]: bound,
        [RELOCATION_INDEX]: indexed,
        [RELOCATION_INTENT_INDEX]: operationIdIndex(stored?.[RELOCATION_INTENT_INDEX])
          .filter((entry) => entry !== operationId),
      });
      await storageLocal.remove(pendingKey);
      return bound;
    });
  }

  async function abandonIntent(operationId) {
    if (typeof operationId !== 'string' || !SAFE_OPERATION_ID.test(operationId)) return;
    await serializedIndex(async () => {
      const stored = await storageLocal.get(RELOCATION_INTENT_INDEX);
      await storageLocal.set({
        [RELOCATION_INTENT_INDEX]: operationIdIndex(stored?.[RELOCATION_INTENT_INDEX])
          .filter((entry) => entry !== operationId),
      });
      await storageLocal.remove(intentKey(operationId));
    });
  }

  async function commitCompleted(record, finalPath, stagingPath = record.stagingPath) {
    const completed = {
      ...record,
      status: 'complete',
      stagingPath,
      finalPath,
      errorCode: null,
      updatedAt: timestamp(now),
    };
    await serializedIndex(async () => {
      await ensureIndexes();
      const stored = await storageLocal.get([RELOCATION_INDEX, DELIVERY_RESULT_INDEX]);
      const active = downloadIdIndex(stored?.[RELOCATION_INDEX])
        .filter((entry) => entry !== record.downloadId);
      const completedIds = downloadIdIndex(stored?.[DELIVERY_RESULT_INDEX]);
      if (!completedIds.includes(record.downloadId)) completedIds.push(record.downloadId);
      await storageLocal.set({
        [resultKey(record.downloadId)]: completed,
        [RELOCATION_INDEX]: active,
        [DELIVERY_RESULT_INDEX]: completedIds,
      });
      await storageLocal.remove(key(record.downloadId));
    });
    await pruneResults();
    return completed;
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
        .filter((record) => FAILURE_STATUSES.has(record.status))
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

    if (record.destinationFolder === null) {
      await commitCompleted(record, item.filename, null);
      return;
    }

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
          operationId: record.operationId,
          downloadId,
          sourcePath: item.filename,
          destinationFolder: record.destinationFolder,
        },
      ));
      if (moved.type !== HOST_EVENTS.FILE_MOVED || moved.downloadId !== downloadId
        || moved.operationId !== record.operationId) {
        throw new Error('Resposta de entrega inválida.');
      }
      await commitCompleted(moving, moved.finalPath, moving.stagingPath);
    } catch {
      await put({
        ...moving,
        status: 'moveFailed',
        finalPath: null,
        errorCode: 'DESTINATION_MOVE_FAILED',
        updatedAt: timestamp(now),
      });
      await pruneFailures();
      try { scheduleMaintenance(); } catch {}
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
    if (!validDownloadId(delta?.id)) return;
    if (delta?.state?.current === 'complete') {
      await deliver(delta.id);
      return;
    }
    if (delta?.state?.current !== 'interrupted') return;
    const record = await get(delta.id);
    if (!record || !ACTIVE_STATUSES.has(record.status)) return;
    const items = await downloads.search({ id: delta.id });
    const item = Array.isArray(items) ? items.find(({ id }) => id === delta.id) : null;
    await put({
      ...record,
      status: 'interrupted',
      stagingPath: typeof item?.filename === 'string' && item.filename
        ? item.filename
        : record.stagingPath,
      errorCode: 'BROWSER_DOWNLOAD_INTERRUPTED',
      updatedAt: timestamp(now),
    });
    await pruneFailures();
  }

  async function reconcileIntents() {
    const index = await storageLocal.get(RELOCATION_INTENT_INDEX);
    const operationIds = operationIdIndex(index?.[RELOCATION_INTENT_INDEX]);
    if (operationIds.length === 0) return;
    const entries = await storageLocal.get(operationIds.map(intentKey));
    const currentTime = timestamp(now);
    const recoverable = [];
    for (const operationId of operationIds) {
      const storedKey = intentKey(operationId);
      const intent = entries?.[storedKey];
      const valid = intent?.operationId === operationId
        && SAFE_OPERATION_ID.test(operationId)
        && intent.downloadId === null
        && intent.status === 'starting'
        && MEDIA_KINDS.has(intent.mediaKind)
        && typeof intent.mediaUrl === 'string'
        && /^https?:\/\//.test(intent.mediaUrl)
        && Number.isSafeInteger(intent.updatedAt)
        && intent.updatedAt >= 0;
      if (!valid || currentTime - intent.updatedAt > INTENT_MAX_AGE_MS) {
        await abandonIntent(operationId);
        continue;
      }
      recoverable.push(intent);
    }
    if (recoverable.length === 0) return;

    await ensureIndexes();
    const relocationIndexes = await storageLocal.get([
      RELOCATION_INDEX,
      DELIVERY_RESULT_INDEX,
    ]);
    const usedDownloadIds = new Set([
      ...downloadIdIndex(relocationIndexes?.[RELOCATION_INDEX]),
      ...downloadIdIndex(relocationIndexes?.[DELIVERY_RESULT_INDEX]),
    ]);
    const candidateEdges = [];
    for (const intent of recoverable) {
      const startedAfter = new Date(Math.max(0, intent.updatedAt - 5_000)).toISOString();
      const query = intent.mediaKind === 'direct'
        ? { url: intent.mediaUrl, startedAfter }
        : { filenameRegex: hlsStagingFilenameRegex(intent), startedAfter };
      const matches = await downloads.search(query);
      const candidateIds = Array.isArray(matches)
        ? matches.filter((item) => validDownloadId(item?.id)
          && (intent.mediaKind !== 'direct' || item.url === intent.mediaUrl)
          && (intent.mediaKind !== 'hls'
            || (typeof item.filename === 'string'
              && new RegExp(hlsStagingFilenameRegex(intent)).test(item.filename)))
          && !usedDownloadIds.has(item.id)
          && Number.isFinite(Date.parse(item.startTime))
          && Date.parse(item.startTime) >= intent.updatedAt - 5_000)
          .map((item) => item.id)
        : [];
      candidateEdges.push({
        intent,
        candidateIds: [...new Set(candidateIds)],
      });
    }
    const candidateUseCount = new Map();
    for (const { candidateIds } of candidateEdges) {
      for (const downloadId of candidateIds) {
        candidateUseCount.set(downloadId, (candidateUseCount.get(downloadId) ?? 0) + 1);
      }
    }
    const unambiguous = candidateEdges.filter(({ candidateIds }) => (
      candidateIds.length === 1 && candidateUseCount.get(candidateIds[0]) === 1
    ));
    for (const { intent, candidateIds } of unambiguous) {
      const downloadId = candidateIds[0];
      try {
        await bindIntent(intent.operationId, downloadId);
        usedDownloadIds.add(downloadId);
      } catch {
        // A concurrent request may already have committed the same binding.
      }
    }
  }

  async function reconcile() {
    await reconcileIntents();
    const records = await serializedIndex(() => indexedRecords(RELOCATION_INDEX, RELOCATION_PREFIX));
    const pending = records
      .filter((record) => ACTIVE_STATUSES.has(record.status))
      .map((record) => record.downloadId)
      .filter(validDownloadId);
    await Promise.all(pending.map(deliver));
  }

  async function recoverIntent(operationId, downloadId) {
    if (typeof operationId !== 'string' || !SAFE_OPERATION_ID.test(operationId)
      || !validDownloadId(downloadId)) return false;
    const stored = await storageLocal.get(intentKey(operationId));
    const intent = stored?.[intentKey(operationId)];
    if (!intent || intent.operationId !== operationId || intent.status !== 'starting') return false;
    try {
      await bindIntent(operationId, downloadId);
      await deliver(downloadId);
      return true;
    } catch {
      scheduleMaintenance();
      return false;
    }
  }

  return Object.freeze({
    get,
    track,
    createIntent,
    bindIntent,
    abandonIntent,
    recoverIntent,
    deliver,
    handleChanged,
    reconcile,
  });
}
