import { assembleHls, inspectHls } from '../hls/hls-operation.js';
import { ACTIONS, assertOffscreenMessage } from '../shared/messages.js';

export function createOffscreenBridge({
  inspect = inspectHls,
  assemble = assembleHls,
  createObjectURL = URL.createObjectURL.bind(URL),
  revokeObjectURL = URL.revokeObjectURL.bind(URL),
  sendCompletion = (message) => globalThis.chrome.runtime.sendMessage(message),
  scheduleRetry = (attempt) => new Promise((resolve) => {
    setTimeout(resolve, Math.min(250 * (2 ** attempt), 5_000));
  }),
} = {}) {
  const ownedBlobUrls = new Set();
  const operations = new Map();

  async function deliverCompletion(message, operationId) {
    let attempt = 0;
    while (operations.has(operationId)) {
      try {
        const response = await sendCompletion(message);
        if (response?.ok === true && response.value?.acknowledged === true) return;
      } catch {
        // A suspended worker or dropped response is retried below.
      }
      await scheduleRetry(attempt);
      attempt += 1;
    }
  }

  async function runOperation(payload) {
    const { operationId, url, allowedOrigins } = payload;
    let completion;
    let blobUrl;
    try {
      const result = await assemble(url, { allowedOrigins });
      if (!(result?.blob instanceof Blob) || !Number.isSafeInteger(result.size) || result.size < 0) {
        throw new Error('Resultado HLS inválido');
      }

      blobUrl = createObjectURL(result.blob);
      if (typeof blobUrl !== 'string' || !/^blob:\S+$/.test(blobUrl)) {
        throw new Error('URL de blob inválida');
      }
      ownedBlobUrls.add(blobUrl);
      operations.get(operationId).blobUrl = blobUrl;
      completion = {
        target: 'background',
        action: ACTIONS.HLS_COMPLETED,
        payload: { operationId, result: { blobUrl, size: result.size } },
      };
    } catch (error) {
      completion = {
        target: 'background',
        action: ACTIONS.HLS_COMPLETED,
        payload: { operationId, error: safeOperationError(error) },
      };
    }

    await deliverCompletion(completion, operationId);
    if (!blobUrl) operations.delete(operationId);
  }

  return {
    async handle(raw) {
      const message = assertOffscreenMessage(raw);

      if (message.action === ACTIONS.INSPECT_HLS) {
        return inspect(message.payload.url);
      }

      if (message.action === ACTIONS.START_HLS) {
        const { operationId } = message.payload;
        if (!operations.has(operationId)) {
          const operation = { blobUrl: undefined, promise: undefined };
          operations.set(operationId, operation);
          operation.promise = runOperation(message.payload).catch(() => {
            // Completion delivery owns its retry policy and must not reject globally.
          });
        }
        return { operationId, state: 'assembling' };
      }

      if (message.action === ACTIONS.DOWNLOAD_HLS) {
        const result = await assemble(message.payload.url, {
          allowedOrigins: message.payload.allowedOrigins,
        });
        if (!(result?.blob instanceof Blob) || !Number.isSafeInteger(result.size) || result.size < 0) {
          throw new Error('Resultado HLS inválido');
        }

        const blobUrl = createObjectURL(result.blob);
        if (typeof blobUrl !== 'string' || !/^blob:\S+$/.test(blobUrl)) {
          throw new Error('URL de blob inválida');
        }
        ownedBlobUrls.add(blobUrl);
        return { blobUrl, size: result.size };
      }

      const { blobUrl, operationId } = message.payload;
      if (!ownedBlobUrls.has(blobUrl)) return { released: false };
      revokeObjectURL(blobUrl);
      ownedBlobUrls.delete(blobUrl);
      if (operationId) operations.delete(operationId);
      else {
        for (const [id, operation] of operations) {
          if (operation.blobUrl === blobUrl) operations.delete(id);
        }
      }
      return { released: true };
    },
  };
}

function safeOperationError(error) {
  if (!(error instanceof Error)) {
    return { code: 'HLS_UNKNOWN', message: 'Não foi possível processar a operação HLS.', details: {} };
  }
  const code = typeof error.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code)
    ? error.code
    : 'HLS_UNKNOWN';
  const message = typeof error.message === 'string' && error.message.trim() && error.message.length <= 500
    ? error.message
    : 'Não foi possível processar a operação HLS.';
  let details = {};
  if (error.details && typeof error.details === 'object' && !Array.isArray(error.details)) {
    try {
      const serialized = JSON.stringify(error.details);
      if (serialized.length <= 16 * 1024) details = JSON.parse(serialized);
    } catch {
      details = {};
    }
  }
  return { code, message, details };
}
