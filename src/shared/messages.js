export const ACTIONS = Object.freeze({
  DOWNLOAD_DIRECT: 'DOWNLOAD_DIRECT',
  INSPECT_HLS: 'INSPECT_HLS',
  DOWNLOAD_HLS: 'DOWNLOAD_HLS',
  RELEASE_BLOB: 'RELEASE_BLOB',
});

const BACKGROUND_ACTIONS = new Set([
  ACTIONS.DOWNLOAD_DIRECT,
  ACTIONS.INSPECT_HLS,
  ACTIONS.DOWNLOAD_HLS,
]);
const OFFSCREEN_ACTIONS = new Set([
  ACTIONS.INSPECT_HLS,
  ACTIONS.DOWNLOAD_HLS,
  ACTIONS.RELEASE_BLOB,
]);

export function assertBackgroundMessage(message) {
  assertMessageShape(message, 'background', BACKGROUND_ACTIONS);
  assertPayloadForAction(message.action, message.payload);
  return message;
}

export function assertOffscreenMessage(message) {
  assertMessageShape(message, 'offscreen', OFFSCREEN_ACTIONS);

  if (message.action === ACTIONS.RELEASE_BLOB) {
    if (!isObject(message.payload) || typeof message.payload.blobUrl !== 'string' || !message.payload.blobUrl.startsWith('blob:')) {
      throw new Error('Mensagem inválida');
    }
  } else {
    assertPayloadForAction(message.action, message.payload);
  }

  return message;
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
