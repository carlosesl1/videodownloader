import { ACTIONS, assertBackgroundMessage } from '../shared/messages.js';
import {
  browserDownloadTarget,
  readDownloadPreferences,
} from '../shared/download-preferences.js';
import { HOST_COMMANDS } from '../youtube/protocol.js';
import {
  HLS_INDEX_MIGRATION,
  HLS_INSPECTION_INDEX,
  HLS_INSPECTION_PREFIX,
  HLS_OPERATION_INDEX,
  HLS_OPERATION_PREFIX,
  HOST_PERMISSION_CLAIMS,
  OWNED_HOST_PERMISSION_PATTERNS,
  stringIndex,
} from '../shared/persistence-keys.js';

const OPERATION_PREFIX = HLS_OPERATION_PREFIX;
const DEDUPE_PREFIX = 'hlsDedupe:';
const TRACKING_PREFIX = 'hlsDownloadBlob:';
const INSPECTION_PREFIX = HLS_INSPECTION_PREFIX;
const ACTIVE_STATES = new Set(['starting', 'assembling', 'assembled', 'downloading']);
const ASSEMBLY_STATES = new Set(['starting', 'assembling', 'assembled']);
const PERMISSION_STATES = new Set(['starting', 'assembling']);
const TERMINAL_STATES = new Set(['complete', 'interrupted', 'failed']);
const SAFE_CODE = /^[A-Z0-9_]{1,64}$/;
const MAX_MESSAGE_LENGTH = 500;
const MAX_DETAILS_LENGTH = 16 * 1024;
const MAX_PERMISSION_CLAIMS = 50;
const PERMISSION_CLAIM_TTL_MS = 10 * 60_000;
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

function validPermissionPattern(value) {
  if (typeof value !== 'string' || value.length > 2_052 || !value.endsWith('/*')) return false;
  try {
    const parsed = new URL(value.slice(0, -2));
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && `${parsed.origin}/*` === value;
  } catch {
    return false;
  }
}

function samePatterns(left, right) {
  const normalizedLeft = normalizePatterns(left);
  const normalizedRight = normalizePatterns(right);
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((pattern) => normalizedRight.includes(pattern));
}

function validPermissionClaim(value) {
  return isObject(value)
    && Object.keys(value).length === 3
    && typeof value.claimId === 'string'
    && /^[A-Za-z0-9._:-]{1,128}$/.test(value.claimId)
    && Array.isArray(value.permissionPatterns)
    && value.permissionPatterns.length > 0
    && value.permissionPatterns.length <= 50
    && value.permissionPatterns.every(validPermissionPattern)
    && Number.isSafeInteger(value.createdAt)
    && value.createdAt >= 0;
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
  storageLocal = globalThis.chrome?.storage?.local,
  permissions = globalThis.chrome?.permissions,
  sendOffscreen = (message) => globalThis.chrome.runtime.sendMessage(message),
  nativeClient,
  relocation,
  createOperationId = defaultOperationId,
  createInspectionId = defaultOperationId,
  now = Date.now,
  progressPersistIntervalMs = 1_000,
  scheduleMaintenance = () => {},
} = {}) {
  let queue = Promise.resolve();
  let indexesReady;

  if (typeof now !== 'function' || !Number.isSafeInteger(progressPersistIntervalMs)
    || progressPersistIntervalMs < 0 || typeof scheduleMaintenance !== 'function') {
    throw new TypeError('Dependências inválidas do processamento HLS.');
  }

  function requestMaintenance() {
    try {
      scheduleMaintenance();
    } catch {
      // A próxima inicialização ou transição durável também reconciliará o estado.
    }
  }

  function serialized(operation) {
    const task = queue.then(operation, operation);
    queue = task.catch(() => {});
    return task;
  }

  function timestamp() {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new BackgroundError('BACKGROUND_CLOCK', 'O relógio do sistema é inválido.');
    }
    return value;
  }

  async function whenIdle() {
    while (true) {
      const observed = queue;
      await observed;
      if (queue === observed) return;
    }
  }

  async function resolveDownloadTarget(filename, operationId) {
    const preferences = await readDownloadPreferences(storageLocal);
    const target = browserDownloadTarget(filename, preferences, operationId);
    if (!target.staging) {
      return { target, destinationFolder: null };
    }
    if (typeof nativeClient?.request !== 'function'
      || typeof relocation?.track !== 'function'
      || typeof relocation?.deliver !== 'function') {
      throw new BackgroundError(
        'DESTINATION_HELPER_UNAVAILABLE',
        'O auxiliar nativo é necessário para usar a pasta automática.',
      );
    }
    const ready = await nativeClient.request(HOST_COMMANDS.PING, {});
    const destinationFolder = preferences.defaultFolder ?? ready?.defaultFolder ?? null;
    if (!destinationFolder) {
      throw new BackgroundError(
        'DESTINATION_NOT_CONFIGURED',
        'Escolha uma pasta padrão para continuar.',
      );
    }
    return { target, destinationFolder };
  }

  async function trackRelocation({
    downloadId,
    operationId,
    destinationFolder,
    mediaKind,
    mediaUrl,
    displayName,
  }) {
    if (!destinationFolder) return;
    await relocation.track({
      downloadId,
      operationId,
      destinationFolder,
      mediaKind,
      mediaUrl,
      displayName,
    });
    await relocation.deliver(downloadId);
  }

  async function createRelocationIntent({
    operationId,
    destinationFolder,
    mediaKind,
    mediaUrl,
    displayName,
    trackBrowser = false,
  }) {
    if (!destinationFolder && !trackBrowser) return false;
    if (typeof relocation?.createIntent !== 'function'
      || typeof relocation?.bindIntent !== 'function') {
      throw new BackgroundError(
        'DESTINATION_HELPER_UNAVAILABLE',
        'O auxiliar nativo não oferece entrega transacional.',
      );
    }
    await relocation.createIntent({
      downloadId: null,
      operationId,
      destinationFolder: destinationFolder ?? null,
      mediaKind,
      mediaUrl,
      displayName,
    });
    return true;
  }

  async function bindRelocationIntent(operationId, downloadId, prepared, fallbackRecord) {
    if (!prepared) return;
    try {
      await relocation.bindIntent(operationId, downloadId);
    } catch {
      if (fallbackRecord?.destinationFolder) {
        try {
          await relocation.track({ ...fallbackRecord, downloadId, operationId });
        } catch {
          requestMaintenance();
          return;
        }
      } else {
        requestMaintenance();
        return;
      }
    }
    try {
      await relocation.deliver(downloadId);
    } catch {
      requestMaintenance();
    }
  }

  async function getRecord(operationId) {
    const key = operationKey(operationId);
    const result = await storageSession.get(key);
    return safelyRead(result, key);
  }

  function validIndex(value) {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.length > 0);
  }

  function scanIndex(entries, prefix, property) {
    return Object.entries(entries ?? {})
      .filter(([key, value]) => (
        key.startsWith(prefix)
        && isObject(value)
        && typeof value[property] === 'string'
        && key === `${prefix}${value[property]}`
      ))
      .map(([, value]) => value[property]);
  }

  async function ensureIndexes() {
    if (!indexesReady) {
      indexesReady = (async () => {
        const stored = await storageSession.get([
          HLS_OPERATION_INDEX,
          HLS_INSPECTION_INDEX,
          HLS_INDEX_MIGRATION,
        ]);
        const operationIndex = safelyRead(stored, HLS_OPERATION_INDEX);
        const inspectionIndex = safelyRead(stored, HLS_INSPECTION_INDEX);
        if (
          safelyRead(stored, HLS_INDEX_MIGRATION) === 1
          && validIndex(operationIndex)
          && validIndex(inspectionIndex)
        ) return;

        const entries = await storageSession.get(null);
        await storageSession.set({
          [HLS_OPERATION_INDEX]: scanIndex(entries, OPERATION_PREFIX, 'operationId'),
          [HLS_INSPECTION_INDEX]: scanIndex(entries, INSPECTION_PREFIX, 'inspectionId'),
          [HLS_INDEX_MIGRATION]: 1,
        });
      })().catch((error) => {
        indexesReady = undefined;
        throw error;
      });
    }
    await indexesReady;
  }

  async function indexedValues(indexKey, prefix, property) {
    await ensureIndexes();
    const indexResult = await storageSession.get(indexKey);
    const indexed = stringIndex(safelyRead(indexResult, indexKey));
    if (indexed.length === 0) return [];
    const keys = indexed.map((id) => `${prefix}${id}`);
    const entries = await storageSession.get(keys);
    const values = [];
    const repaired = [];
    for (const id of indexed) {
      const value = safelyRead(entries, `${prefix}${id}`);
      if (!isObject(value) || value[property] !== id) continue;
      repaired.push(id);
      values.push(value);
    }
    if (repaired.length !== indexed.length) {
      await storageSession.set({ [indexKey]: repaired });
    }
    return values;
  }

  async function persistIndexed(indexKey, id, entryKey, value) {
    await ensureIndexes();
    const stored = await storageSession.get(indexKey);
    const indexed = stringIndex(safelyRead(stored, indexKey));
    if (!indexed.includes(id)) indexed.push(id);
    await storageSession.set({ [entryKey]: value, [indexKey]: indexed });
    return value;
  }

  async function removeIndexed(indexKey, id, entryKey) {
    await ensureIndexes();
    const stored = await storageSession.get(indexKey);
    const indexed = stringIndex(safelyRead(stored, indexKey)).filter((entry) => entry !== id);
    await storageSession.remove(entryKey);
    await storageSession.set({ [indexKey]: indexed });
  }

  function touchRecord(record) {
    return { ...record, updatedAt: timestamp() };
  }

  async function persistRecord(record, { touch = true, entries = {} } = {}) {
    await ensureIndexes();
    const value = touch ? touchRecord(record) : record;
    const stored = await storageSession.get(HLS_OPERATION_INDEX);
    const indexed = stringIndex(safelyRead(stored, HLS_OPERATION_INDEX));
    if (!indexed.includes(value.operationId)) indexed.push(value.operationId);
    await storageSession.set({
      [operationKey(value.operationId)]: value,
      [HLS_OPERATION_INDEX]: indexed,
      ...entries,
    });
    return value;
  }

  async function persistLease(lease) {
    return persistIndexed(
      HLS_INSPECTION_INDEX,
      lease.inspectionId,
      inspectionKey(lease.inspectionId),
      lease,
    );
  }

  async function allRecords() {
    return indexedValues(HLS_OPERATION_INDEX, OPERATION_PREFIX, 'operationId');
  }

  async function allInspectionLeases() {
    return indexedValues(HLS_INSPECTION_INDEX, INSPECTION_PREFIX, 'inspectionId');
  }

  async function pruneTerminalRecords() {
    const records = await allRecords();
    const terminal = records
      .filter((record) => TERMINAL_STATES.has(record.state) && !record.cleanupPending)
      .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
    const keep = new Set([
      ...terminal.filter((record) => record.state === 'failed').slice(0, 20),
      ...terminal.filter((record) => record.state !== 'failed').slice(0, 20),
    ].map((record) => record.operationId));
    const expired = terminal.filter((record) => !keep.has(record.operationId));
    if (expired.length === 0) return;
    const expiredIds = new Set(expired.map((record) => record.operationId));
    const indexed = records
      .map((record) => record.operationId)
      .filter((operationId) => !expiredIds.has(operationId));
    await storageSession.remove(expired.map((record) => operationKey(record.operationId)));
    await storageSession.set({ [HLS_OPERATION_INDEX]: indexed });
  }

  async function permissionsContain(patterns) {
    if (patterns.length === 0 || typeof permissions?.contains !== 'function') return true;
    return permissions.contains({ origins: patterns });
  }

  async function readPermissionClaims() {
    const stored = await storageLocal.get(HOST_PERMISSION_CLAIMS);
    const raw = stored?.[HOST_PERMISSION_CLAIMS];
    if (!Array.isArray(raw)) return { claims: [], dirty: raw !== undefined };
    const claims = [];
    const ids = new Set();
    for (const candidate of raw) {
      if (!validPermissionClaim(candidate) || ids.has(candidate.claimId)) continue;
      ids.add(candidate.claimId);
      claims.push({
        claimId: candidate.claimId,
        permissionPatterns: normalizePatterns(candidate.permissionPatterns),
        createdAt: candidate.createdAt,
      });
    }
    return { claims, dirty: claims.length !== raw.length };
  }

  async function writePermissionClaims(claims) {
    if (claims.length === 0) {
      await storageLocal.remove(HOST_PERMISSION_CLAIMS);
      return;
    }
    await storageLocal.set({ [HOST_PERMISSION_CLAIMS]: claims });
  }

  async function activePermissionClaims() {
    const loaded = await readPermissionClaims();
    if (loaded.claims.length === 0) {
      if (loaded.dirty) await writePermissionClaims([]);
      return [];
    }
    const observedAt = timestamp();
    const active = loaded.claims.filter((claim) => (
      claim.createdAt <= observedAt
      && observedAt - claim.createdAt <= PERMISSION_CLAIM_TTL_MS
    ));
    if (loaded.dirty || active.length !== loaded.claims.length) {
      await writePermissionClaims(active);
    }
    if (active.length > 0) requestMaintenance();
    return active;
  }

  async function claimHostPermissions(message) {
    return serialized(async () => {
      const permissionPatterns = normalizePatterns(message.payload.permissionPatterns);
      await activePermissionClaims();
      const stored = await storageLocal.get([
        OWNED_HOST_PERMISSION_PATTERNS,
        HOST_PERMISSION_CLAIMS,
      ]);
      const owned = stringIndex(stored?.[OWNED_HOST_PERMISSION_PATTERNS])
        .filter(validPermissionPattern);
      const rawClaims = Array.isArray(stored?.[HOST_PERMISSION_CLAIMS])
        ? stored[HOST_PERMISSION_CLAIMS]
        : [];
      const claims = rawClaims.filter(validPermissionClaim).map((claim) => ({
        claimId: claim.claimId,
        permissionPatterns: normalizePatterns(claim.permissionPatterns),
        createdAt: claim.createdAt,
      }));
      const existing = claims.find(({ claimId }) => claimId === message.payload.claimId);
      if (existing && !samePatterns(existing.permissionPatterns, permissionPatterns)) {
        throw new BackgroundError(
          'BACKGROUND_PERMISSION_CLAIM',
          'A reserva de permissão não corresponde à solicitação.',
        );
      }
      if (!existing) {
        if (claims.length >= MAX_PERMISSION_CLAIMS) {
          throw new BackgroundError(
            'BACKGROUND_PERMISSION_CLAIM_LIMIT',
            'Há muitas autorizações temporárias pendentes.',
          );
        }
        claims.push({
          claimId: message.payload.claimId,
          permissionPatterns,
          createdAt: timestamp(),
        });
      } else {
        existing.createdAt = timestamp();
      }
      for (const pattern of permissionPatterns) {
        if (!owned.includes(pattern)) owned.push(pattern);
      }
      await storageLocal.set({
        [OWNED_HOST_PERMISSION_PATTERNS]: owned,
        [HOST_PERMISSION_CLAIMS]: claims,
      });
      requestMaintenance();
      return { claimId: message.payload.claimId, state: 'claimed' };
    });
  }

  async function confirmHostPermissionClaim(message) {
    return serialized(async () => {
      const permissionPatterns = normalizePatterns(message.payload.permissionPatterns);
      if (!(await permissionsContain(permissionPatterns))) {
        throw new BackgroundError(
          'BACKGROUND_PERMISSION_CLAIM',
          'A autorização concedida não está mais disponível.',
        );
      }
      await activePermissionClaims();
      const stored = await storageLocal.get([
        OWNED_HOST_PERMISSION_PATTERNS,
        HOST_PERMISSION_CLAIMS,
      ]);
      const owned = stringIndex(stored?.[OWNED_HOST_PERMISSION_PATTERNS])
        .filter(validPermissionPattern);
      const rawClaims = Array.isArray(stored?.[HOST_PERMISSION_CLAIMS])
        ? stored[HOST_PERMISSION_CLAIMS]
        : [];
      const claims = rawClaims.filter(validPermissionClaim).map((claim) => ({
        claimId: claim.claimId,
        permissionPatterns: normalizePatterns(claim.permissionPatterns),
        createdAt: claim.createdAt,
      }));
      const existingIndex = claims.findIndex(({ claimId }) => (
        claimId === message.payload.claimId
      ));
      if (existingIndex >= 0
        && !samePatterns(claims[existingIndex].permissionPatterns, permissionPatterns)) {
        throw new BackgroundError(
          'BACKGROUND_PERMISSION_CLAIM',
          'A reserva de permissão não corresponde à autorização.',
        );
      }
      const confirmed = {
        claimId: message.payload.claimId,
        permissionPatterns,
        createdAt: timestamp(),
      };
      if (existingIndex >= 0) claims[existingIndex] = confirmed;
      else {
        if (claims.length >= MAX_PERMISSION_CLAIMS) {
          throw new BackgroundError(
            'BACKGROUND_PERMISSION_CLAIM_LIMIT',
            'Há muitas autorizações temporárias pendentes.',
          );
        }
        claims.push(confirmed);
      }
      for (const pattern of permissionPatterns) {
        if (!owned.includes(pattern)) owned.push(pattern);
      }
      await storageLocal.set({
        [OWNED_HOST_PERMISSION_PATTERNS]: owned,
        [HOST_PERMISSION_CLAIMS]: claims,
      });
      requestMaintenance();
      return { claimId: message.payload.claimId, state: 'confirmed' };
    });
  }

  async function requirePermissionClaim(claimId, permissionPatterns) {
    if (claimId === null) return null;
    const claims = await activePermissionClaims();
    const claim = claims.find((candidate) => candidate.claimId === claimId);
    const available = new Set(permissionPatterns);
    if (!claim || claim.permissionPatterns.some((pattern) => !available.has(pattern))) {
      throw new BackgroundError(
        'BACKGROUND_PERMISSION_CLAIM',
        'A reserva de permissão expirou ou é inválida.',
      );
    }
    return claim;
  }

  async function deletePermissionClaim(claimId) {
    if (claimId === null) return;
    const loaded = await readPermissionClaims();
    const remaining = loaded.claims.filter((claim) => claim.claimId !== claimId);
    if (loaded.dirty || remaining.length !== loaded.claims.length) {
      await writePermissionClaims(remaining);
    }
  }

  async function removeUnusedPermissions() {
    const ownedState = await storageLocal.get(OWNED_HOST_PERMISSION_PATTERNS);
    const rawCandidates = stringIndex(ownedState?.[OWNED_HOST_PERMISSION_PATTERNS]);
    const candidates = rawCandidates.filter(validPermissionPattern);
    const claims = await activePermissionClaims();
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
    for (const claim of claims) {
      for (const pattern of claim.permissionPatterns) used.add(pattern);
    }
    const removable = candidates.filter((pattern) => !used.has(pattern));
    const cleared = new Set(rawCandidates.filter((pattern) => !validPermissionPattern(pattern)));
    const present = [];
    for (const pattern of removable) {
      if (await permissionsContain([pattern])) present.push(pattern);
      else cleared.add(pattern);
    }
    if (present.length > 0) {
      if (typeof permissions?.remove !== 'function') {
        throw new BackgroundError(
          'BACKGROUND_PERMISSION_RELEASE',
          'Não foi possível remover a autorização temporária.',
        );
      }
      const removed = await permissions.remove({ origins: present });
      if (removed === true) {
        for (const pattern of present) cleared.add(pattern);
      } else {
        for (const pattern of present) {
          if (!(await permissionsContain([pattern]))) cleared.add(pattern);
        }
      }
    }
    const retained = candidates.filter((pattern) => !cleared.has(pattern));
    if (retained.length === 0) await storageLocal.remove(OWNED_HOST_PERMISSION_PATTERNS);
    else if (!samePatterns(retained, rawCandidates)) {
      await storageLocal.set({ [OWNED_HOST_PERMISSION_PATTERNS]: retained });
    }
    const stillGranted = present.filter((pattern) => !cleared.has(pattern));
    if (stillGranted.length > 0) {
      requestMaintenance();
      throw new BackgroundError(
        'BACKGROUND_PERMISSION_RELEASE',
        'O navegador ainda mantém uma autorização temporária.',
      );
    }
  }

  async function finishPermissionClaim(claimId) {
    if (claimId === null) return;
    await deletePermissionClaim(claimId);
    await removeUnusedPermissions();
  }

  async function releaseHostPermissionClaim(message) {
    return serialized(async () => {
      await deletePermissionClaim(message.payload.claimId);
      await removeUnusedPermissions();
      return { claimId: message.payload.claimId, state: 'released' };
    });
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
    await removeUnusedPermissions();
    await removeIndexed(HLS_INSPECTION_INDEX, lease.inspectionId, inspectionKey(lease.inspectionId));
    requestMaintenance();
  }

  async function inspectHls(message) {
    const patterns = normalizePatterns(message.payload.permissionPatterns);
    const claimId = message.payload.permissionClaimId;
    const inspectionId = createInspectionId();
    await serialized(async () => {
      let leasePersisted = false;
      try {
        await requirePermissionClaim(claimId, patterns);
        if (!(await permissionsContain(patterns))) {
          throw new BackgroundError(
            'BACKGROUND_PERMISSION_BUSY',
            'A permissão temporária expirou antes do processamento HLS.',
          );
        }
        await persistLease({
          inspectionId,
          permissionPatterns: patterns,
          state: 'active',
        });
        leasePersisted = true;
        await finishPermissionClaim(claimId);
      } catch (error) {
        try {
          await finishPermissionClaim(claimId);
        } catch {
          requestMaintenance();
        }
        if (leasePersisted) {
          try {
            const releasing = { inspectionId, permissionPatterns: patterns, state: 'releasing' };
            await persistLease(releasing);
            await armInspectionCleanup(inspectionId);
            await cleanupInspectionLease(releasing);
          } catch {
            requestMaintenance();
          }
        }
        throw error;
      }
    });

    let operationError;
    let value;
    try {
      value = validateInspection(await sendAndUnwrap(sendOffscreen, {
        target: 'offscreen',
        action: ACTIONS.INSPECT_HLS,
        payload: { url: message.payload.url },
      }));
    } catch (error) {
      operationError = error;
    }

    try {
      await serialized(async () => {
        await persistLease({ inspectionId, permissionPatterns: patterns, state: 'releasing' });
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
    return persistRecord({ ...record, state: 'assembling' });
  }

  async function startHls(message) {
    return serialized(async () => {
      const claimId = message.payload.permissionClaimId;
      let durableRecord = false;
      try {
        const canonicalUrl = canonicalMediaUrl(message.payload.url);
        const dedupeKey = `${ACTIONS.DOWNLOAD_HLS}:${canonicalUrl}`;
        const dedupeKeyName = dedupeStorageKey(dedupeKey);
        const permissionPatterns = normalizePatterns(message.payload.permissionPatterns);
        await requirePermissionClaim(claimId, permissionPatterns);

        const indexed = await storageSession.get(dedupeKeyName);
        const existingId = safelyRead(indexed, dedupeKeyName);
        if (typeof existingId === 'string') {
          let existing = await getRecord(existingId);
          if (isObject(existing) && ACTIVE_STATES.has(existing.state)) {
            await finishPermissionClaim(claimId);
            durableRecord = true;
            if (existing.state === 'starting') existing = await sendStartAndMark(existing);
            return { operationId: existing.operationId, state: existing.state };
          }
        }

        const activeAssembly = (await allRecords()).find((record) => (
          isObject(record) && ASSEMBLY_STATES.has(record.state)
        ));
        if (activeAssembly) {
          throw new BackgroundError(
            'HLS_BUSY',
            'Aguarde a montagem do outro vídeo HLS terminar.',
          );
        }

        if (!(await permissionsContain(permissionPatterns))) {
          throw new BackgroundError(
            'BACKGROUND_PERMISSION_BUSY',
            'A permissão temporária expirou antes do processamento HLS.',
          );
        }
        const operationId = createOperationId();
        let record = {
          operationId,
          dedupeKey,
          url: canonicalUrl,
          filename: message.payload.filename,
          allowedOrigins: [...message.payload.allowedOrigins],
          permissionPatterns,
          state: 'starting',
          progress: {
            completedSegments: 0,
            totalSegments: 0,
            bytesReceived: 0,
            estimatedTotalBytes: null,
            percent: 0,
          },
        };
        record = await persistRecord(record, {
          entries: { [dedupeKeyName]: operationId },
        });
        durableRecord = true;
        await finishPermissionClaim(claimId);
        const assembling = await sendStartAndMark(record);
        return { operationId, state: assembling.state };
      } catch (error) {
        if (!durableRecord) {
          try {
            await finishPermissionClaim(claimId);
          } catch {
            requestMaintenance();
          }
        } else {
          requestMaintenance();
        }
        throw error;
      }
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

  function scheduleCleanupRetry() {
    requestMaintenance();
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
      await removeUnusedPermissions();
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
    const persisted = await persistRecord(finalized);
    await pruneTerminalRecords();
    requestMaintenance();
    return persisted;
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
    const terminal = await persistRecord({ ...record, state, cleanupPending: true });
    await beginTerminalCleanup(terminal);
  }

  async function releaseAssemblyPermissions(record) {
    if (record.permissionsReleased) return record;
    await removeUnusedPermissions();
    return persistRecord({ ...record, permissionsReleased: true });
  }

  async function persistDownloadMapping(record, download) {
    const mapped = { ...record, state: 'downloading', downloadId: download.id };
    const tracked = {
      operationId: record.operationId,
      blobUrl: record.blobUrl,
    };
    const persisted = await persistRecord(mapped, {
      entries: { [trackingKey(download.id)]: tracked },
    });
    const terminalState = download.state;
    if (terminalState === 'complete' || terminalState === 'interrupted') {
      await markTerminal(persisted, terminalState);
    }
    return persisted;
  }

  async function handoffAssembled(record) {
    const { target, destinationFolder } = await resolveDownloadTarget(
      record.filename,
      record.operationId,
    );
    let existing = await findDownload(record.blobUrl, record.downloadId);
    if (!existing && record.downloadId === undefined) existing = await findDownload(record.blobUrl);
    if (existing) {
      await persistDownloadMapping(record, existing);
      if (target.staging) {
        try {
          await bindRelocationIntent(record.operationId, existing.id, true, {
            destinationFolder,
            mediaKind: 'hls',
            mediaUrl: record.url,
            displayName: record.filename,
          });
        } catch {
          await trackRelocation({
            downloadId: existing.id,
            operationId: record.operationId,
            destinationFolder,
            mediaKind: 'hls',
            mediaUrl: record.url,
            displayName: record.filename,
          });
        }
      }
      return;
    }
    if (Number.isInteger(record.downloadId)) return;

    const relocationPrepared = target.staging && await createRelocationIntent({
      operationId: record.operationId,
      destinationFolder,
      mediaKind: 'hls',
      mediaUrl: record.url,
      displayName: record.filename,
    });
    let downloadId;
    try {
      downloadId = await downloads.download({
        url: record.blobUrl,
        filename: target.filename,
        saveAs: target.saveAs,
      });
    } catch (error) {
      if (relocationPrepared) await relocation.abandonIntent?.(record.operationId);
      throw error;
    }
    if (!Number.isInteger(downloadId)) throw new BackgroundError(
      'BACKGROUND_DOWNLOAD',
      'O navegador não iniciou o download HLS.',
    );
    await persistDownloadMapping(record, {
      id: downloadId,
      url: record.blobUrl,
      state: 'in_progress',
    });
    await bindRelocationIntent(record.operationId, downloadId, relocationPrepared, {
      destinationFolder,
      mediaKind: 'hls',
      mediaUrl: record.url,
      displayName: record.filename,
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
        record = {
          ...record,
          state: 'assembled',
          blobUrl,
          size,
          progress: {
            completedSegments: record.progress?.totalSegments ?? 0,
            totalSegments: record.progress?.totalSegments ?? 0,
            bytesReceived: size,
            estimatedTotalBytes: size,
            percent: 100,
          },
        };
        record = await persistRecord(record);
      }
      record = await releaseAssemblyPermissions(record);
      await handoffAssembled(record);
      return { acknowledged: true };
    });
  }

  async function progressHls(message) {
    return serialized(async () => {
      const {
        operationId,
        completedSegments,
        totalSegments,
        bytesReceived,
        estimatedTotalBytes,
      } = message.payload;
      const record = await getRecord(operationId);
      if (!isObject(record) || !ASSEMBLY_STATES.has(record.state)) {
        return { acknowledged: true };
      }
      const current = isObject(record.progress) ? record.progress : {};
      if (
        Number.isSafeInteger(current.completedSegments)
        && completedSegments < current.completedSegments
      ) return { acknowledged: true };
      if (Number.isSafeInteger(current.bytesReceived) && bytesReceived < current.bytesReceived) {
        return { acknowledged: true };
      }
      const percent = Math.min(100, Math.floor((completedSegments / totalSegments) * 100));
      const updated = touchRecord({
        ...record,
        state: 'assembling',
        progress: {
          completedSegments,
          totalSegments,
          bytesReceived,
          estimatedTotalBytes,
          percent,
        },
      });
      if (
        record.state === 'assembling'
        && Number.isSafeInteger(record.progressUpdatedAt)
        && updated.updatedAt - record.progressUpdatedAt < progressPersistIntervalMs
        && percent < 100
      ) return { acknowledged: true };
      await persistRecord({
        ...updated,
        progressUpdatedAt: updated.updatedAt,
      }, { touch: false });
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
        const recoveredRelocation = typeof relocation?.recoverIntent === 'function'
          && await relocation.recoverIntent(record.operationId, delta.id);
        const mapped = await persistRecord({ ...record, downloadId: delta.id }, {
          entries: { [key]: { operationId: record.operationId, blobUrl: record.blobUrl } },
        });
        if (!recoveredRelocation) requestMaintenance();
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
    await removeUnusedPermissions();
    for (const lease of await allInspectionLeases()) {
      const releasing = { ...lease, state: 'releasing' };
      await persistLease(releasing);
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

  async function hasPendingOffscreenWork() {
    const [records, leases] = await Promise.all([allRecords(), allInspectionLeases()]);
    return leases.length > 0 || records.some((record) => (
      ACTIVE_STATES.has(record.state) || record.cleanupPending === true
    ));
  }

  const ready = serialized(reconcileLocked);

  return {
    ready,
    whenIdle,
    hasPendingOffscreenWork,
    reconcile: () => serialized(reconcileLocked),
    handleDownloadChanged,
    async handle(raw) {
      const message = assertBackgroundMessage(raw);
      if (message.action === ACTIONS.CLAIM_HOST_PERMISSIONS) {
        return claimHostPermissions(message);
      }
      if (message.action === ACTIONS.CONFIRM_HOST_PERMISSION_CLAIM) {
        return confirmHostPermissionClaim(message);
      }
      if (message.action === ACTIONS.RELEASE_HOST_PERMISSION_CLAIM) {
        return releaseHostPermissionClaim(message);
      }
      if (message.action === ACTIONS.DOWNLOAD_DIRECT) {
        const operationId = createOperationId();
        const { target, destinationFolder } = await resolveDownloadTarget(
          message.payload.filename,
          operationId,
        );
        const relocationPrepared = target.staging && await createRelocationIntent({
          operationId,
          destinationFolder,
          mediaKind: 'direct',
          mediaUrl: message.payload.url,
          displayName: message.payload.filename,
          trackBrowser: true,
        });
        const browserLedgerPrepared = relocationPrepared || await createRelocationIntent({
          operationId,
          destinationFolder: null,
          mediaKind: 'direct',
          mediaUrl: message.payload.url,
          displayName: message.payload.filename,
          trackBrowser: true,
        });
        let downloadId;
        try {
          downloadId = await downloads.download({
            url: message.payload.url,
            filename: target.filename,
            saveAs: target.saveAs,
          });
        } catch (error) {
          if (browserLedgerPrepared) await relocation.abandonIntent?.(operationId);
          throw error;
        }
        if (!Number.isSafeInteger(downloadId) || downloadId < 0) {
          if (browserLedgerPrepared) await relocation.abandonIntent?.(operationId);
          throw new BackgroundError(
            'BACKGROUND_DOWNLOAD',
            'O navegador não iniciou o download direto.',
          );
        }
        await bindRelocationIntent(operationId, downloadId, browserLedgerPrepared, {
          destinationFolder,
          mediaKind: 'direct',
          mediaUrl: message.payload.url,
          displayName: message.payload.filename,
        });
        return { downloadId };
      }
      if (message.action === ACTIONS.INSPECT_HLS) return inspectHls(message);
      if (message.action === ACTIONS.DOWNLOAD_HLS) return startHls(message);
      if (message.action === ACTIONS.HLS_PROGRESS) return progressHls(message);
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
