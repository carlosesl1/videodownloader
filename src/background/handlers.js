import { ACTIONS, assertBackgroundMessage } from '../shared/messages.js';

const OPERATION_PREFIX = 'hlsOperation:';
const DEDUPE_PREFIX = 'hlsDedupe:';
const TRACKING_PREFIX = 'hlsDownloadBlob:';
const INSPECTION_PREFIX = 'hlsInspection:';
const ACTIVE_STATES = new Set(['starting', 'assembling', 'assembled', 'downloading']);
const PERMISSION_STATES = new Set(['starting', 'assembling']);
const TERMINAL_STATES = new Set(['complete', 'interrupted', 'failed']);
const SAFE_CODE = /^[A-Z0-9_]{1,64}$/;
const MAX_MESSAGE_LENGTH = 500;
const MAX_DETAILS_LENGTH = 16 * 1024;
const GENERIC_ERROR_MESSAGE = 'Não foi possível concluir a operação.';
const MALFORMED_RESPONSE_MESSAGE = 'A resposta do processamento HLS é inválida.';

class BackgroundError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BackgroundError';
    this.code = code;
    this.details = details;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safelyRead(value, property) {
  try {
    return value?.[property];
  } catch {
    return undefined;
  }
}

function safeDetails(value) {
  if (!isObject(value)) return {};
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== 'string' || serialized.length > MAX_DETAILS_LENGTH) return {};
    const parsed = JSON.parse(serialized);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function safeBackgroundError(error) {
  if (!(error instanceof Error)) {
    return { code: 'BACKGROUND_UNKNOWN', message: GENERIC_ERROR_MESSAGE, details: {} };
  }
  const code = safelyRead(error, 'code');
  const message = safelyRead(error, 'message');
  return {
    code: typeof code === 'string' && SAFE_CODE.test(code) ? code : 'BACKGROUND_UNKNOWN',
    message: typeof message === 'string' && message.trim() && message.length <= MAX_MESSAGE_LENGTH
      ? message
      : GENERIC_ERROR_MESSAGE,
    details: safeDetails(safelyRead(error, 'details')),
  };
}

function malformedOffscreenResponse() {
  return new BackgroundError('BACKGROUND_OFFSCREEN_RESPONSE', MALFORMED_RESPONSE_MESSAGE);
}

function unwrapOffscreenResponse(response) {
  if (!isObject(response) || typeof response.ok !== 'boolean') throw malformedOffscreenResponse();
  if (response.ok) {
    if (!Object.hasOwn(response, 'value')) throw malformedOffscreenResponse();
    return response.value;
  }
  const remote = safelyRead(response, 'error');
  const code = safelyRead(remote, 'code');
  const message = safelyRead(remote, 'message');
  const details = safelyRead(remote, 'details');
  if (
    !isObject(remote)
    || typeof code !== 'string'
    || !SAFE_CODE.test(code)
    || typeof message !== 'string'
    || !message.trim()
    || message.length > MAX_MESSAGE_LENGTH
    || !isObject(details)
  ) throw malformedOffscreenResponse();
  throw new BackgroundError(code, message, safeDetails(details));
}

async function sendAndUnwrap(sendOffscreen, message) {
  return unwrapOffscreenResponse(await sendOffscreen(message));
}

function operationKey(operationId) {
  return `${OPERATION_PREFIX}${operationId}`;
}

function dedupeStorageKey(dedupeKey) {
  return `${DEDUPE_PREFIX}${encodeURIComponent(dedupeKey)}`;
}

function trackingKey(downloadId) {
  return `${TRACKING_PREFIX}${downloadId}`;
}

function inspectionKey(inspectionId) {
  return `${INSPECTION_PREFIX}${inspectionId}`;
}

function canonicalMediaUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  parsed.hash = '';
  return parsed.href;
}

function normalizePatterns(patterns) {
  return [...new Set(patterns)];
}

function defaultOperationId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `hls-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function releaseMessage(recordOrId, blobUrl) {
  const operationId = typeof recordOrId === 'string' ? recordOrId : recordOrId.operationId;
  return {
    target: 'offscreen',
    action: ACTIONS.RELEASE_BLOB,
    payload: { operationId, blobUrl },
  };
}

function exactUrlQuery(url) {
  return `^${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
}

function validateInspection(value) {
  if (
    !isObject(value)
    || (value.kind !== 'master' && value.kind !== 'media')
    || !Array.isArray(value.variants)
    || value.variants.length === 0
  ) {
    throw malformedOffscreenResponse();
  }
  for (const variant of value.variants) {
    if (!isObject(variant)) throw malformedOffscreenResponse();
    let parsed;
    try {
      parsed = new URL(variant.url);
    } catch {
      throw malformedOffscreenResponse();
    }
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || typeof variant.label !== 'string'
      || !variant.label.trim()
      || variant.label.length > 200
      || !Number.isSafeInteger(variant.width)
      || variant.width < 0
      || !Number.isSafeInteger(variant.height)
      || variant.height < 0
      || !Number.isSafeInteger(variant.bandwidth)
      || variant.bandwidth < 0
      || (variant.codecs !== null && typeof variant.codecs !== 'string')
      || (typeof variant.codecs === 'string' && variant.codecs.length > 1_000)
    ) throw malformedOffscreenResponse();
  }
  return value;
}

export function createBackgroundHandlers({
  downloads = globalThis.chrome?.downloads,
  storageSession = globalThis.chrome?.storage?.session,
  permissions = globalThis.chrome?.permissions,
  sendOffscreen = (message) => globalThis.chrome.runtime.sendMessage(message),
  createOperationId = defaultOperationId,
  createInspectionId = defaultOperationId,
  scheduleRetry = (callback) => setTimeout(() => Promise.resolve(callback()).catch(() => {}), 1_000),
} = {}) {
  let queue = Promise.resolve();
  const scheduledCleanup = new Set();

  function serialized(operation) {
    const task = queue.then(operation, operation);
    queue = task.catch(() => {});
    return task;
  }

  async function whenIdle() {
    while (true) {
      const observed = queue;
      await observed;
      if (queue === observed) return;
    }
  }

  async function getRecord(operationId) {
    const key = operationKey(operationId);
    const result = await storageSession.get(key);
    return safelyRead(result, key);
  }

  async function allRecords() {
    const entries = await storageSession.get(null);
    return Object.entries(entries ?? {})
      .filter(([key, value]) => key.startsWith(OPERATION_PREFIX) && isObject(value))
      .map(([, value]) => value);
  }

  async function allInspectionLeases() {
    const entries = await storageSession.get(null);
    return Object.entries(entries ?? {})
      .filter(([key, value]) => key.startsWith(INSPECTION_PREFIX) && isObject(value))
      .map(([, value]) => value);
  }

  async function permissionsContain(patterns) {
    if (patterns.length === 0 || typeof permissions?.contains !== 'function') return true;
    return permissions.contains({ origins: patterns });
  }

  async function removeUnusedPermissions(candidatePatterns) {
    const candidates = normalizePatterns(candidatePatterns);
    if (candidates.length === 0) return;
    const records = await allRecords();
    const used = new Set();
    for (const record of records) {
      if (!PERMISSION_STATES.has(record.state)) continue;
      for (const pattern of record.permissionPatterns ?? []) used.add(pattern);
    }
    for (const lease of await allInspectionLeases()) {
      if (lease.state !== 'active') continue;
      for (const pattern of lease.permissionPatterns ?? []) used.add(pattern);
    }
    const removable = candidates.filter((pattern) => !used.has(pattern));
    if (removable.length > 0) await permissions.remove({ origins: removable });
  }

  async function armInspectionCleanup(leaseId) {
    const value = await sendAndUnwrap(sendOffscreen, {
      target: 'offscreen',
      action: ACTIONS.ARM_INSPECTION_CLEANUP,
      payload: { leaseId },
    });
    if (
      !isObject(value)
      || value.leaseId !== leaseId
      || value.state !== 'armed'
      || Object.keys(value).some((key) => key !== 'leaseId' && key !== 'state')
    ) throw malformedOffscreenResponse();
  }

  async function cleanupInspectionLease(lease) {
    await removeUnusedPermissions(lease.permissionPatterns ?? []);
    await storageSession.remove(inspectionKey(lease.inspectionId));
  }

  async function inspectHls(message) {
    const patterns = normalizePatterns(message.payload.permissionPatterns);
    const inspectionId = createInspectionId();
    await serialized(async () => {
      if (!(await permissionsContain(patterns))) {
        throw new BackgroundError(
          'BACKGROUND_PERMISSION_BUSY',
          'A permissão temporária expirou antes do processamento HLS.',
        );
      }
      await storageSession.set({
        [inspectionKey(inspectionId)]: {
          inspectionId,
          permissionPatterns: patterns,
          state: 'active',
        },
      });
    });

    let operationError;
    let value;
    try {
      value = validateInspection(await sendAndUnwrap(sendOffscreen, {
        ...message,
        target: 'offscreen',
      }));
    } catch (error) {
      operationError = error;
    }

    try {
      await serialized(async () => {
        const key = inspectionKey(inspectionId);
        await storageSession.set({
          [key]: { inspectionId, permissionPatterns: patterns, state: 'releasing' },
        });
        await armInspectionCleanup(inspectionId);
        await cleanupInspectionLease({ inspectionId, permissionPatterns: patterns, state: 'releasing' });
      });
    } catch (cleanupError) {
      if (!operationError) operationError = cleanupError;
    }
    if (operationError) throw operationError;
    return value;
  }

  async function sendStartAndMark(record) {
    const value = await sendAndUnwrap(sendOffscreen, {
      target: 'offscreen',
      action: ACTIONS.START_HLS,
      payload: {
        operationId: record.operationId,
        url: record.url,
        allowedOrigins: record.allowedOrigins,
      },
    });
    if (
      !isObject(value)
      || value.operationId !== record.operationId
      || value.state !== 'assembling'
      || Object.keys(value).some((key) => key !== 'operationId' && key !== 'state')
    ) throw malformedOffscreenResponse();
    const assembling = { ...record, state: 'assembling' };
    await storageSession.set({ [operationKey(record.operationId)]: assembling });
    return assembling;
  }

  async function startHls(message) {
    return serialized(async () => {
      const canonicalUrl = canonicalMediaUrl(message.payload.url);
      const dedupeKey = `${ACTIONS.DOWNLOAD_HLS}:${canonicalUrl}`;
      const dedupeKeyName = dedupeStorageKey(dedupeKey);
      const indexed = await storageSession.get(dedupeKeyName);
      const existingId = safelyRead(indexed, dedupeKeyName);
      if (typeof existingId === 'string') {
        let existing = await getRecord(existingId);
        if (isObject(existing) && ACTIVE_STATES.has(existing.state)) {
          if (existing.state === 'starting') existing = await sendStartAndMark(existing);
          return { operationId: existing.operationId, state: existing.state };
        }
      }

      const permissionPatterns = normalizePatterns(message.payload.permissionPatterns);
      if (!(await permissionsContain(permissionPatterns))) {
        throw new BackgroundError(
          'BACKGROUND_PERMISSION_BUSY',
          'A permissão temporária expirou antes do processamento HLS.',
        );
      }
      const operationId = createOperationId();
      const record = {
        operationId,
        dedupeKey,
        url: canonicalUrl,
        filename: message.payload.filename,
        allowedOrigins: [...message.payload.allowedOrigins],
        permissionPatterns,
        state: 'starting',
      };
      await storageSession.set({
        [operationKey(operationId)]: record,
        [dedupeKeyName]: operationId,
      });
      const assembling = await sendStartAndMark(record);
      return { operationId, state: assembling.state };
    });
  }

  async function findDownload(blobUrl, downloadId) {
    if (typeof downloads?.search !== 'function') return undefined;
    const query = downloadId === undefined ? { urlRegex: exactUrlQuery(blobUrl) } : { id: downloadId };
    const matches = await downloads.search(query);
    if (!Array.isArray(matches)) return undefined;
    return matches.find((item) => (
      isObject(item)
      && Number.isInteger(item.id)
      && item.url === blobUrl
      && (downloadId === undefined || item.id === downloadId)
    ));
  }

  function scheduleCleanupRetry(operationId) {
    if (scheduledCleanup.has(operationId)) return;
    scheduledCleanup.add(operationId);
    scheduleRetry(() => {
      scheduledCleanup.delete(operationId);
      return serialized(async () => {
        const record = await getRecord(operationId);
        if (isObject(record) && TERMINAL_STATES.has(record.state) && record.cleanupPending) {
          await beginTerminalCleanup(record);
        }
      });
    });
  }

  async function requestBlobRelease(record) {
    const value = await sendAndUnwrap(sendOffscreen, releaseMessage(record, record.blobUrl));
    if (
      !isObject(value)
      || value.operationId !== record.operationId
      || value.state !== 'releasing'
      || Object.keys(value).some((key) => key !== 'operationId' && key !== 'state')
    ) throw malformedOffscreenResponse();
  }

  async function finalizeTerminal(record) {
    if (!record.permissionsReleased) {
      await removeUnusedPermissions(record.permissionPatterns ?? []);
    }
    const dedupeKeyName = dedupeStorageKey(record.dedupeKey);
    const indexed = await storageSession.get(dedupeKeyName);
    const keys = [];
    if (safelyRead(indexed, dedupeKeyName) === record.operationId) keys.push(dedupeKeyName);
    if (Number.isInteger(record.downloadId)) keys.push(trackingKey(record.downloadId));
    if (keys.length > 0) await storageSession.remove(keys);

    const finalized = { ...record, cleanupPending: false, permissionsReleased: true };
    delete finalized.blobUrl;
    delete finalized.size;
    delete finalized.downloadId;
    await storageSession.set({ [operationKey(record.operationId)]: finalized });
    return finalized;
  }

  async function beginTerminalCleanup(record) {
    if (!record.blobUrl) {
      await finalizeTerminal(record);
      return;
    }
    try {
      await requestBlobRelease(record);
    } catch {
      scheduleCleanupRetry(record.operationId);
    }
  }

  async function markTerminal(record, state) {
    const terminal = { ...record, state, cleanupPending: true };
    await storageSession.set({ [operationKey(record.operationId)]: terminal });
    await beginTerminalCleanup(terminal);
  }

  async function releaseAssemblyPermissions(record) {
    if (record.permissionsReleased) return record;
    await removeUnusedPermissions(record.permissionPatterns ?? []);
    const updated = { ...record, permissionsReleased: true };
    await storageSession.set({ [operationKey(record.operationId)]: updated });
    return updated;
  }

  async function persistDownloadMapping(record, download) {
    const mapped = { ...record, state: 'downloading', downloadId: download.id };
    const tracked = {
      operationId: record.operationId,
      blobUrl: record.blobUrl,
    };
    await storageSession.set({
      [operationKey(record.operationId)]: mapped,
      [trackingKey(download.id)]: tracked,
    });
    const terminalState = download.state;
    if (terminalState === 'complete' || terminalState === 'interrupted') {
      await markTerminal(mapped, terminalState);
    }
    return mapped;
  }

  async function handoffAssembled(record) {
    let existing = await findDownload(record.blobUrl, record.downloadId);
    if (!existing && record.downloadId === undefined) existing = await findDownload(record.blobUrl);
    if (existing) {
      await persistDownloadMapping(record, existing);
      return;
    }
    if (Number.isInteger(record.downloadId)) return;

    const downloadId = await downloads.download({
      url: record.blobUrl,
      filename: record.filename,
      saveAs: false,
    });
    if (!Number.isInteger(downloadId)) throw new BackgroundError(
      'BACKGROUND_DOWNLOAD',
      'O navegador não iniciou o download HLS.',
    );
    await persistDownloadMapping(record, {
      id: downloadId,
      url: record.blobUrl,
      state: 'in_progress',
    });
  }

  async function completeHls(message) {
    return serialized(async () => {
      const { operationId } = message.payload;
      let record = await getRecord(operationId);
      if (!isObject(record) || !ACTIVE_STATES.has(record.state)) {
        if (message.payload.result) {
          await requestBlobRelease({ operationId, blobUrl: message.payload.result.blobUrl });
        }
        return { acknowledged: true };
      }

      if (message.payload.error) {
        if (record.state !== 'starting' && record.state !== 'assembling') {
          return { acknowledged: true };
        }
        await markTerminal({ ...record, error: message.payload.error }, 'failed');
        return { acknowledged: true };
      }

      const { blobUrl, size } = message.payload.result;
      if (record.blobUrl && record.blobUrl !== blobUrl) {
        return { acknowledged: true };
      }
      if (!record.blobUrl) {
        record = { ...record, state: 'assembled', blobUrl, size };
        await storageSession.set({ [operationKey(operationId)]: record });
      }
      record = await releaseAssemblyPermissions(record);
      await handoffAssembled(record);
      return { acknowledged: true };
    });
  }

  async function releasedHls(message) {
    return serialized(async () => {
      const { operationId, blobUrl } = message.payload;
      const record = await getRecord(operationId);
      if (!isObject(record) || !record.cleanupPending) return { acknowledged: true };
      if (!TERMINAL_STATES.has(record.state) || record.blobUrl !== blobUrl) {
        throw new BackgroundError(
          'BACKGROUND_RELEASE_MISMATCH',
          'A confirmação de liberação HLS não corresponde à operação.',
        );
      }
      await finalizeTerminal(record);
      return { acknowledged: true };
    });
  }

  async function handleDownloadChanged(delta) {
    const state = delta?.state?.current;
    if (!Number.isInteger(delta?.id) || (state !== 'complete' && state !== 'interrupted')) return;
    return serialized(async () => {
      const key = trackingKey(delta.id);
      const result = await storageSession.get(key);
      const tracked = safelyRead(result, key);
      if (!isObject(tracked) || typeof tracked.operationId !== 'string') {
        if (typeof downloads?.search !== 'function') return;
        const matches = await downloads.search({ id: delta.id });
        const item = Array.isArray(matches) && matches.find(({ id }) => id === delta.id);
        if (!isObject(item) || typeof item.url !== 'string' || !item.url.startsWith('blob:')) return;
        const record = (await allRecords()).find((candidate) => (
          ACTIVE_STATES.has(candidate.state) && candidate.blobUrl === item.url
        ));
        if (!record) return;
        const mapped = { ...record, downloadId: delta.id };
        await storageSession.set({
          [operationKey(record.operationId)]: mapped,
          [key]: { operationId: record.operationId, blobUrl: record.blobUrl },
        });
        await markTerminal(mapped, state);
        return;
      }
      const record = await getRecord(tracked.operationId);
      if (!isObject(record)) return;
      if (TERMINAL_STATES.has(record.state)) {
        if (record.cleanupPending) await beginTerminalCleanup(record);
        return;
      }
      await markTerminal(record, state);
    });
  }

  async function inspectionCleanup(message) {
    return serialized(async () => {
      const key = inspectionKey(message.payload.leaseId);
      const result = await storageSession.get(key);
      const lease = safelyRead(result, key);
      if (!isObject(lease) || lease.state !== 'releasing') return { acknowledged: true };
      await cleanupInspectionLease(lease);
      return { acknowledged: true };
    });
  }

  async function reconcileLocked() {
    for (const lease of await allInspectionLeases()) {
      const key = inspectionKey(lease.inspectionId);
      const releasing = { ...lease, state: 'releasing' };
      await storageSession.set({ [key]: releasing });
      await armInspectionCleanup(releasing.inspectionId);
      await cleanupInspectionLease(releasing);
    }
    const records = await allRecords();
    for (let record of records) {
      if (record.state === 'starting' || record.state === 'assembling') {
        record = await sendStartAndMark(record);
      } else if (record.state === 'assembled' || record.state === 'downloading') {
        record = await releaseAssemblyPermissions(record);
        await handoffAssembled(record);
      } else if (TERMINAL_STATES.has(record.state) && record.cleanupPending) {
        await beginTerminalCleanup(record);
      }
    }
  }

  const ready = serialized(reconcileLocked);

  return {
    ready,
    whenIdle,
    reconcile: () => serialized(reconcileLocked),
    handleDownloadChanged,
    async handle(raw) {
      const message = assertBackgroundMessage(raw);
      if (message.action === ACTIONS.DOWNLOAD_DIRECT) {
        const downloadId = await downloads.download({
          url: message.payload.url,
          filename: message.payload.filename,
          saveAs: false,
        });
        return { downloadId };
      }
      if (message.action === ACTIONS.INSPECT_HLS) return inspectHls(message);
      if (message.action === ACTIONS.DOWNLOAD_HLS) return startHls(message);
      if (message.action === ACTIONS.HLS_COMPLETED) return completeHls(message);
      if (message.action === ACTIONS.HLS_RELEASED) return releasedHls(message);
      return inspectionCleanup(message);
    },
  };
}

export function createTerminalDownloadHandler(coordinator) {
  return (delta) => coordinator.handleDownloadChanged(delta);
}

export function createBackgroundMessageListener(handlers) {
  return (message, _sender, sendResponse) => {
    if (message?.target !== 'background') return false;
    Promise.resolve()
      .then(() => handlers.handle(message))
      .then((value) => sendResponse({ ok: true, value }))
      .catch((error) => sendResponse({ ok: false, error: safeBackgroundError(error) }));
    return true;
  };
}
