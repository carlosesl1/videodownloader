import { createOffscreenBridge } from './bridge.js';

const bridge = createOffscreenBridge();
const GENERIC_ERROR_MESSAGE = 'NÃ£o foi possÃ­vel processar a operaÃ§Ã£o HLS.';

function safeError(error) {
  if (!(error instanceof Error)) {
    return { code: 'HLS_UNKNOWN', message: GENERIC_ERROR_MESSAGE, details: {} };
  }

  return {
    code: error.code ?? 'HLS_UNKNOWN',
    message: typeof error.message === 'string' && error.message ? error.message : GENERIC_ERROR_MESSAGE,
    details: error.details ?? {},
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
