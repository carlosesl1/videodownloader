import { createOffscreenBridge } from './bridge.js';

const bridge = createOffscreenBridge();
const GENERIC_ERROR_MESSAGE = 'Não foi possível processar a operação HLS.';
const SAFE_CODE = /^[A-Z0-9_]{1,64}$/;
const MAX_MESSAGE_LENGTH = 500;
const MAX_DETAILS_LENGTH = 16 * 1024;

function safelyRead(object, property) {
  try {
    return object[property];
  } catch {
    return undefined;
  }
}

function safeDetails(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};

  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== 'string' || serialized.length > MAX_DETAILS_LENGTH) return {};
    const parsed = JSON.parse(serialized);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function safeError(error) {
  if (!(error instanceof Error)) {
    return { code: 'HLS_UNKNOWN', message: GENERIC_ERROR_MESSAGE, details: {} };
  }

  const code = safelyRead(error, 'code');
  const message = safelyRead(error, 'message');
  return {
    code: typeof code === 'string' && SAFE_CODE.test(code) ? code : 'HLS_UNKNOWN',
    message: typeof message === 'string' && message.trim() && message.length <= MAX_MESSAGE_LENGTH
      ? message
      : GENERIC_ERROR_MESSAGE,
    details: safeDetails(safelyRead(error, 'details')),
  };
}

export function createOffscreenMessageListener(listenerBridge) {
  return (message, _sender, sendResponse) => {
    if (message?.target !== 'offscreen') return false;

    listenerBridge.handle(message)
      .then((value) => sendResponse({ ok: true, value }))
      .catch((error) => sendResponse({ ok: false, error: safeError(error) }));
    return true;
  };
}

chrome.runtime.onMessage.addListener(createOffscreenMessageListener(bridge));
