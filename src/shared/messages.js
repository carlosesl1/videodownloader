import { isValidDownloadFilename } from './filename.js';

export const ACTIONS = Object.freeze({
  DOWNLOAD_DIRECT: 'DOWNLOAD_DIRECT',
  INSPECT_HLS: 'INSPECT_HLS',
  DOWNLOAD_HLS: 'DOWNLOAD_HLS',
  START_HLS: 'START_HLS',
  HLS_PROGRESS: 'HLS_PROGRESS',
  HLS_COMPLETED: 'HLS_COMPLETED',
  HLS_RELEASED: 'HLS_RELEASED',
  ARM_INSPECTION_CLEANUP: 'ARM_INSPECTION_CLEANUP',
  INSPECTION_CLEANUP: 'INSPECTION_CLEANUP',
  RELEASE_BLOB: 'RELEASE_BLOB',
  CLAIM_HOST_PERMISSIONS: 'CLAIM_HOST_PERMISSIONS',
  CONFIRM_HOST_PERMISSION_CLAIM: 'CONFIRM_HOST_PERMISSION_CLAIM',
  RELEASE_HOST_PERMISSION_CLAIM: 'RELEASE_HOST_PERMISSION_CLAIM',
});

const BACKGROUND_ACTIONS = new Set([
  ACTIONS.DOWNLOAD_DIRECT,
  ACTIONS.INSPECT_HLS,
  ACTIONS.DOWNLOAD_HLS,
  ACTIONS.HLS_PROGRESS,
  ACTIONS.HLS_COMPLETED,
  ACTIONS.HLS_RELEASED,
  ACTIONS.INSPECTION_CLEANUP,
  ACTIONS.CLAIM_HOST_PERMISSIONS,
  ACTIONS.CONFIRM_HOST_PERMISSION_CLAIM,
  ACTIONS.RELEASE_HOST_PERMISSION_CLAIM,
]);
const OFFSCREEN_ACTIONS = new Set([
  ACTIONS.INSPECT_HLS,
  ACTIONS.START_HLS,
  ACTIONS.ARM_INSPECTION_CLEANUP,
  ACTIONS.RELEASE_BLOB,
]);

export function assertBackgroundMessage(message) {
  assertMessageShape(message, 'background', BACKGROUND_ACTIONS);
  if (message.action === ACTIONS.HLS_PROGRESS) assertHlsProgress(message.payload);
  else if (message.action === ACTIONS.HLS_COMPLETED) assertHlsCompletion(message.payload);
  else if (message.action === ACTIONS.HLS_RELEASED) assertHlsReleased(message.payload);
  else if (message.action === ACTIONS.INSPECTION_CLEANUP) assertInspectionCleanup(message.payload);
  else assertPayloadForAction(message.action, message.payload);
  return message;
}

function assertHlsProgress(payload) {
  if (
    !isObject(payload)
    || !isOperationId(payload.operationId)
    || !Number.isSafeInteger(payload.completedSegments)
    || payload.completedSegments < 0
    || !Number.isSafeInteger(payload.totalSegments)
    || payload.totalSegments < 1
    || payload.completedSegments > payload.totalSegments
    || !Number.isSafeInteger(payload.bytesReceived)
    || payload.bytesReceived < 0
    || !(
      payload.estimatedTotalBytes === null
      || (
        Number.isSafeInteger(payload.estimatedTotalBytes)
        && payload.estimatedTotalBytes >= payload.bytesReceived
      )
    )
    || !hasOnlyKeys(payload, [
      'operationId',
      'completedSegments',
      'totalSegments',
      'bytesReceived',
      'estimatedTotalBytes',
    ])
  ) throw new Error('Mensagem inválida');
}

export function assertOffscreenMessage(message) {
  assertMessageShape(message, 'offscreen', OFFSCREEN_ACTIONS);

  if (message.action === ACTIONS.RELEASE_BLOB) {
    if (
      !isObject(message.payload)
      || typeof message.payload.blobUrl !== 'string'
      || !message.payload.blobUrl.startsWith('blob:')
      || !isOperationId(message.payload.operationId)
      || !hasOnlyKeys(message.payload, ['blobUrl', 'operationId'])
    ) {
      throw new Error('Mensagem inválida');
    }
  } else if (message.action === ACTIONS.START_HLS) {
    assertStartHls(message.payload);
  } else if (message.action === ACTIONS.ARM_INSPECTION_CLEANUP) {
    assertInspectionCleanup(message.payload);
  } else if (message.action === ACTIONS.INSPECT_HLS) {
    if (!isObject(message.payload)
      || !hasOnlyKeys(message.payload, ['url'])) throw new Error('Mensagem inválida');
    assertMediaUrl(message.payload.url);
  } else {
    assertPayloadForAction(message.action, message.payload);
  }

  return message;
}

function assertInspectionCleanup(payload) {
  if (
    !isObject(payload)
    || !isOperationId(payload.leaseId)
    || !hasOnlyKeys(payload, ['leaseId'])
  ) throw new Error('Mensagem inválida');
}

function assertHlsReleased(payload) {
  if (
    !isObject(payload)
    || !isOperationId(payload.operationId)
    || typeof payload.blobUrl !== 'string'
    || !/^blob:\S+$/.test(payload.blobUrl)
    || !hasOnlyKeys(payload, ['operationId', 'blobUrl'])
  ) throw new Error('Mensagem inválida');
}

function assertStartHls(payload) {
  if (
    !isObject(payload)
    || !isOperationId(payload.operationId)
    || !isOriginArray(payload.allowedOrigins)
    || !hasOnlyKeys(payload, ['operationId', 'url', 'allowedOrigins'])
  ) {
    throw new Error('Mensagem inválida');
  }
  assertMediaUrl(payload.url);
}

function assertHlsCompletion(payload) {
  if (!isObject(payload) || !isOperationId(payload.operationId)) throw new Error('Mensagem inválida');
  const hasResult = Object.hasOwn(payload, 'result');
  const hasError = Object.hasOwn(payload, 'error');
  if (hasResult === hasError || !hasOnlyKeys(payload, ['operationId', hasResult ? 'result' : 'error'])) {
    throw new Error('Mensagem inválida');
  }

  if (hasResult) {
    const result = payload.result;
    if (
      !isObject(result)
      || !hasOnlyKeys(result, ['blobUrl', 'size'])
      || typeof result.blobUrl !== 'string'
      || !/^blob:\S+$/.test(result.blobUrl)
      || !Number.isSafeInteger(result.size)
      || result.size < 0
    ) {
      throw new Error('Mensagem inválida');
    }
    return;
  }

  if (!isSafeError(payload.error)) throw new Error('Mensagem inválida');
}

function isSafeError(value) {
  if (
    !isObject(value)
    || !hasOnlyKeys(value, ['code', 'message', 'details'])
    || typeof value.code !== 'string'
    || !/^[A-Z0-9_]{1,64}$/.test(value.code)
    || typeof value.message !== 'string'
    || !value.message.trim()
    || value.message.length > 500
    || !isObject(value.details)
  ) return false;

  try {
    const serialized = JSON.stringify(value.details);
    return typeof serialized === 'string' && serialized.length <= 16 * 1024;
  } catch {
    return false;
  }
}

function isOperationId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

function hasOnlyKeys(value, allowed) {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}


function assertMessageShape(message, target, actions) {
  if (!isObject(message) || message.target !== target || !actions.has(message.action)) {
    throw new Error('Mensagem inválida');
  }
}

function assertPayloadForAction(action, payload) {
  if (!isObject(payload)) throw new Error('Mensagem inválida');

  if (action === ACTIONS.DOWNLOAD_DIRECT) {
    if (!hasOnlyKeys(payload, ['url', 'filename'])) throw new Error('Mensagem inválida');
    assertMediaUrl(payload.url);
    if (!isValidDownloadFilename(payload.filename)) throw new Error('Mensagem inválida');
    return;
  }

  if (action === ACTIONS.INSPECT_HLS) {
    if (!hasOnlyKeys(payload, ['url', 'permissionPatterns', 'permissionClaimId'])) {
      throw new Error('Mensagem inválida');
    }
    assertMediaUrl(payload.url);
    if (!isPermissionPatternArray(payload.permissionPatterns)
      || !isNullableOperationId(payload.permissionClaimId)) {
      throw new Error('Mensagem inválida');
    }
    return;
  }

  if (action === ACTIONS.DOWNLOAD_HLS) {
    if (!hasOnlyKeys(payload, [
      'url', 'filename', 'allowedOrigins', 'permissionPatterns', 'permissionClaimId',
    ])) throw new Error('Mensagem inválida');
    assertMediaUrl(payload.url);
    if (
      !isValidDownloadFilename(payload.filename) ||
      !isOriginArray(payload.allowedOrigins) ||
      !isPermissionPatternArray(payload.permissionPatterns) ||
      !isNullableOperationId(payload.permissionClaimId)
    ) {
      throw new Error('Mensagem inválida');
    }
    return;
  }

  if (action === ACTIONS.CLAIM_HOST_PERMISSIONS
    || action === ACTIONS.CONFIRM_HOST_PERMISSION_CLAIM) {
    if (!hasOnlyKeys(payload, ['claimId', 'permissionPatterns'])
      || !isOperationId(payload.claimId)
      || !isPermissionPatternArray(payload.permissionPatterns)
      || payload.permissionPatterns.length === 0) throw new Error('Mensagem inválida');
    return;
  }

  if (action === ACTIONS.RELEASE_HOST_PERMISSION_CLAIM) {
    if (!hasOnlyKeys(payload, ['claimId']) || !isOperationId(payload.claimId)) {
      throw new Error('Mensagem inválida');
    }
  }
}

function assertMediaUrl(value) {
  if (typeof value !== 'string') throw new Error('URL inválida');

  try {
    const { protocol } = new URL(value);
    if (protocol === 'http:' || protocol === 'https:') return;
  } catch {
    // Normalize every malformed media URL to the public contract error.
  }

  throw new Error('URL inválida');
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isBoundedArray(value, predicate) {
  return Array.isArray(value) && value.length <= 50 && value.every(predicate);
}

function isOriginArray(value) {
  return isBoundedArray(value, (item) => {
    if (typeof item !== 'string' || item.length > 2_048) return false;
    try {
      const parsed = new URL(item);
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
        && parsed.origin === item;
    } catch {
      return false;
    }
  });
}

function isPermissionPatternArray(value) {
  return isBoundedArray(value, (item) => {
    if (typeof item !== 'string' || item.length > 2_052 || !item.endsWith('/*')) return false;
    try {
      const parsed = new URL(item.slice(0, -2));
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
        && `${parsed.origin}/*` === item;
    } catch {
      return false;
    }
  });
}

function isNullableOperationId(value) {
  return value === null || isOperationId(value);
}
