export const ACTIONS = Object.freeze({
  DOWNLOAD_DIRECT: 'DOWNLOAD_DIRECT',
  INSPECT_HLS: 'INSPECT_HLS',
  DOWNLOAD_HLS: 'DOWNLOAD_HLS',
  START_HLS: 'START_HLS',
  HLS_COMPLETED: 'HLS_COMPLETED',
  RELEASE_BLOB: 'RELEASE_BLOB',
});

const BACKGROUND_ACTIONS = new Set([
  ACTIONS.DOWNLOAD_DIRECT,
  ACTIONS.INSPECT_HLS,
  ACTIONS.DOWNLOAD_HLS,
  ACTIONS.HLS_COMPLETED,
]);
const OFFSCREEN_ACTIONS = new Set([
  ACTIONS.INSPECT_HLS,
  ACTIONS.DOWNLOAD_HLS,
  ACTIONS.START_HLS,
  ACTIONS.RELEASE_BLOB,
]);

export function assertBackgroundMessage(message) {
  assertMessageShape(message, 'background', BACKGROUND_ACTIONS);
  if (message.action === ACTIONS.HLS_COMPLETED) assertHlsCompletion(message.payload);
  else assertPayloadForAction(message.action, message.payload);
  return message;
}

export function assertOffscreenMessage(message) {
  assertMessageShape(message, 'offscreen', OFFSCREEN_ACTIONS);

  if (message.action === ACTIONS.RELEASE_BLOB) {
    if (
      !isObject(message.payload)
      || typeof message.payload.blobUrl !== 'string'
      || !message.payload.blobUrl.startsWith('blob:')
      || (Object.hasOwn(message.payload, 'operationId') && !isOperationId(message.payload.operationId))
      || !hasNoOtherKeys(message.payload, ['blobUrl', 'operationId'])
    ) {
      throw new Error('Mensagem inválida');
    }
  } else if (message.action === ACTIONS.START_HLS) {
    assertStartHls(message.payload);
  } else {
    assertPayloadForAction(message.action, message.payload);
  }

  return message;
}

function assertStartHls(payload) {
  if (
    !isObject(payload)
    || !isOperationId(payload.operationId)
    || !isNonEmptyStringArray(payload.allowedOrigins)
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

function hasNoOtherKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function assertMessageShape(message, target, actions) {
  if (!isObject(message) || message.target !== target || !actions.has(message.action)) {
    throw new Error('Mensagem inválida');
  }
}

function assertPayloadForAction(action, payload) {
  if (!isObject(payload)) throw new Error('Mensagem inválida');

  if (action === ACTIONS.DOWNLOAD_DIRECT) {
    assertMediaUrl(payload.url);
    if (typeof payload.filename !== 'string' || !payload.filename) throw new Error('Mensagem inválida');
    return;
  }

  if (action === ACTIONS.INSPECT_HLS) {
    assertMediaUrl(payload.url);
    if (!isNonEmptyStringArray(payload.permissionPatterns)) throw new Error('Mensagem inválida');
    return;
  }

  if (action === ACTIONS.DOWNLOAD_HLS) {
    assertMediaUrl(payload.url);
    if (
      typeof payload.filename !== 'string' ||
      !payload.filename ||
      !isNonEmptyStringArray(payload.allowedOrigins) ||
      !isNonEmptyStringArray(payload.permissionPatterns)
    ) {
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

function isNonEmptyStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0);
}
