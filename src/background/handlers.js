import { ACTIONS, assertBackgroundMessage } from '../shared/messages.js';

const TRACKING_KEY_PREFIX = 'hlsDownloadBlob:';
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
  if (!isObject(response) || typeof response.ok !== 'boolean') {
    throw malformedOffscreenResponse();
  }

  if (response.ok) {
    if (!Object.hasOwn(response, 'value')) throw malformedOffscreenResponse();
    return response.value;
  }

  const remote = safelyRead(response, 'error');
  if (!isObject(remote)) throw malformedOffscreenResponse();
  const code = safelyRead(remote, 'code');
  const message = safelyRead(remote, 'message');
  const details = safelyRead(remote, 'details');
  if (
    typeof code !== 'string'
    || !SAFE_CODE.test(code)
    || typeof message !== 'string'
    || !message.trim()
    || message.length > MAX_MESSAGE_LENGTH
    || !isObject(details)
  ) {
    throw malformedOffscreenResponse();
  }

  throw new BackgroundError(code, message, safeDetails(details));
}

function offscreenMessage(message) {
  return { ...message, target: 'offscreen' };
}

function releaseBlobMessage(blobUrl) {
  return {
    target: 'offscreen',
    action: ACTIONS.RELEASE_BLOB,
    payload: { blobUrl },
  };
}

async function sendAndUnwrap(sendOffscreen, message) {
  return unwrapOffscreenResponse(await sendOffscreen(message));
}

function createPermissionLeases(permissions) {
  const activeCounts = new Map();

  function acquire(patterns) {
    const normalized = [...new Set(patterns)];
    for (const pattern of normalized) {
      activeCounts.set(pattern, (activeCounts.get(pattern) ?? 0) + 1);
    }
    return normalized;
  }

  async function release(patterns) {
    const removable = [];
    for (const pattern of patterns) {
      const remaining = (activeCounts.get(pattern) ?? 1) - 1;
      if (remaining <= 0) {
        activeCounts.delete(pattern);
        removable.push(pattern);
      } else {
        activeCounts.set(pattern, remaining);
      }
    }

    if (removable.length > 0) {
      await permissions.remove({ origins: removable });
    }
  }

  return { acquire, release };
}

async function releaseWithoutMasking(sendOffscreen, blobUrl) {
  try {
    await sendAndUnwrap(sendOffscreen, releaseBlobMessage(blobUrl));
  } catch {
    // The operation that made the download unusable remains the primary error.
  }
}

export function createBackgroundHandlers({
  downloads = globalThis.chrome?.downloads,
  storageSession = globalThis.chrome?.storage?.session,
  permissions = globalThis.chrome?.permissions,
  sendOffscreen = (message) => globalThis.chrome.runtime.sendMessage(message),
} = {}) {
  const leases = createPermissionLeases(permissions);

  async function inspectHls(message) {
    const patterns = leases.acquire(message.payload.permissionPatterns);
    let operationError;
    let value;

    try {
      value = await sendAndUnwrap(sendOffscreen, offscreenMessage(message));
    } catch (error) {
      operationError = error;
    }

    try {
      await leases.release(patterns);
    } catch (cleanupError) {
      if (!operationError) operationError = cleanupError;
    }

    if (operationError) throw operationError;
    return value;
  }

  async function downloadHls(message) {
    const patterns = leases.acquire(message.payload.permissionPatterns);
    let operationError;
    let assembled;

    try {
      assembled = await sendAndUnwrap(sendOffscreen, offscreenMessage(message));
      if (
        !isObject(assembled)
        || typeof assembled.blobUrl !== 'string'
        || !/^blob:\S+$/.test(assembled.blobUrl)
        || !Number.isSafeInteger(assembled.size)
        || assembled.size < 0
      ) {
        throw malformedOffscreenResponse();
      }
    } catch (error) {
      operationError = error;
    }

    try {
      await leases.release(patterns);
    } catch (cleanupError) {
      if (!operationError) operationError = cleanupError;
    }

    if (operationError) {
      if (assembled?.blobUrl && /^blob:\S+$/.test(assembled.blobUrl)) {
        await releaseWithoutMasking(sendOffscreen, assembled.blobUrl);
      }
      throw operationError;
    }

    try {
      const downloadId = await downloads.download({
        url: assembled.blobUrl,
        filename: message.payload.filename,
        saveAs: false,
      });
      await storageSession.set({ [`${TRACKING_KEY_PREFIX}${downloadId}`]: assembled.blobUrl });
      return { downloadId };
    } catch (error) {
      await releaseWithoutMasking(sendOffscreen, assembled.blobUrl);
      throw error;
    }
  }

  return {
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
      return downloadHls(message);
    },
  };
}

export function createTerminalDownloadHandler({
  storageSession = globalThis.chrome?.storage?.session,
  sendOffscreen = (message) => globalThis.chrome.runtime.sendMessage(message),
} = {}) {
  const inFlight = new Map();

  return function handleTerminalDownload(delta) {
    const state = delta?.state?.current;
    if (!Number.isInteger(delta?.id) || (state !== 'complete' && state !== 'interrupted')) {
      return Promise.resolve();
    }

    if (inFlight.has(delta.id)) return inFlight.get(delta.id);

    const task = (async () => {
      const key = `${TRACKING_KEY_PREFIX}${delta.id}`;
      const tracked = await storageSession.get(key);
      const blobUrl = safelyRead(tracked, key);
      if (typeof blobUrl !== 'string' || !/^blob:\S+$/.test(blobUrl)) return;

      await sendAndUnwrap(sendOffscreen, releaseBlobMessage(blobUrl));
      await storageSession.remove(key);
    })();

    inFlight.set(delta.id, task);
    task.finally(() => {
      if (inFlight.get(delta.id) === task) inFlight.delete(delta.id);
    }).catch(() => {});
    return task;
  };
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
