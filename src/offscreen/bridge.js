import { assembleHls, inspectHls } from '../hls/hls-operation.js';
import { ACTIONS, assertOffscreenMessage } from '../shared/messages.js';

export function createOffscreenBridge({
  inspect = inspectHls,
  assemble = assembleHls,
  createObjectURL = URL.createObjectURL.bind(URL),
  revokeObjectURL = URL.revokeObjectURL.bind(URL),
  sendCompletion = (message) => globalThis.chrome.runtime.sendMessage(message),
  sendProgress = sendCompletion,
  scheduleRetry = (attempt) => new Promise((resolve) => {
    setTimeout(resolve, Math.min(250 * (2 ** attempt), 5_000));
  }),
} = {}) {
  const operations = new Map();
  const inspectionCleanups = new Map();

  async function deliverUntilAcknowledged(message, operationId) {
    let attempt = 0;
    while (operations.has(operationId)) {
      try {
        const response = await sendCompletion(message);
        if (response?.ok === true && response.value?.acknowledged === true) return;
      } catch {
        // The offscreen document remains alive and retries after worker suspension.
      }
      await scheduleRetry(attempt);
      attempt += 1;
    }
  }

  async function runAssembly(payload) {
    const { operationId, url, allowedOrigins } = payload;
    let completion;
    let blobUrl;
    let lastProgressPercent = -1;
    const onProgress = ({ completedSegments, totalSegments, bytesReceived }) => {
      const percent = Math.floor((completedSegments / totalSegments) * 100);
      if (percent <= lastProgressPercent) return;
      lastProgressPercent = percent;
      try {
        Promise.resolve(sendProgress({
          target: 'background',
          action: ACTIONS.HLS_PROGRESS,
          payload: { operationId, completedSegments, totalSegments, bytesReceived },
        })).catch(() => {});
      } catch {
        // O progresso é informativo; a conclusão durável continua sendo obrigatória.
      }
    };
    try {
      const result = await assemble(url, { allowedOrigins, onProgress });
      if (!(result?.blob instanceof Blob) || !Number.isSafeInteger(result.size) || result.size < 0) {
        throw new Error('Resultado HLS inválido');
      }
      blobUrl = createObjectURL(result.blob);
      if (typeof blobUrl !== 'string' || !/^blob:\S+$/.test(blobUrl)) {
        throw new Error('URL de blob inválida');
      }
      const operation = operations.get(operationId);
      if (!operation) {
        revokeObjectURL(blobUrl);
        return;
      }
      operation.blobUrl = blobUrl;
      operation.state = 'assembled';
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

    await deliverUntilAcknowledged(completion, operationId);
    if (!blobUrl) operations.delete(operationId);
  }

  async function runRelease(operationId, operation) {
    let attempt = 0;
    while (operations.get(operationId) === operation && !operation.revoked) {
      try {
        revokeObjectURL(operation.blobUrl);
        operation.revoked = true;
      } catch {
        await scheduleRetry(attempt);
        attempt += 1;
      }
    }
    if (!operation.revoked || operations.get(operationId) !== operation) return;

    await deliverUntilAcknowledged({
      target: 'background',
      action: ACTIONS.HLS_RELEASED,
      payload: { operationId, blobUrl: operation.blobUrl },
    }, operationId);
    if (operations.get(operationId) === operation) operations.delete(operationId);
  }

  async function runInspectionCleanup(leaseId, cleanup) {
    let attempt = 0;
    while (inspectionCleanups.get(leaseId) === cleanup) {
      try {
        const response = await sendCompletion({
          target: 'background',
          action: ACTIONS.INSPECTION_CLEANUP,
          payload: { leaseId },
        });
        if (response?.ok === true && response.value?.acknowledged === true) {
          inspectionCleanups.delete(leaseId);
          return;
        }
      } catch {
        // Retried by the persistent offscreen document below.
      }
      await scheduleRetry(attempt);
      attempt += 1;
    }
  }

  return {
    async handle(raw) {
      const message = assertOffscreenMessage(raw);
      if (message.action === ACTIONS.INSPECT_HLS) return inspect(message.payload.url);

      if (message.action === ACTIONS.START_HLS) {
        const { operationId } = message.payload;
        if (!operations.has(operationId)) {
          const operation = { state: 'assembling', blobUrl: undefined, revoked: false, promise: undefined };
          operations.set(operationId, operation);
          operation.promise = runAssembly(message.payload).catch(() => {});
        }
        return { operationId, state: 'assembling' };
      }

      if (message.action === ACTIONS.ARM_INSPECTION_CLEANUP) {
        const { leaseId } = message.payload;
        if (!inspectionCleanups.has(leaseId)) {
          const cleanup = { promise: undefined };
          inspectionCleanups.set(leaseId, cleanup);
          cleanup.promise = runInspectionCleanup(leaseId, cleanup).catch(() => {});
        }
        return { leaseId, state: 'armed' };
      }

      const { operationId, blobUrl } = message.payload;
      const operation = operations.get(operationId);
      if (!operation || operation.blobUrl !== blobUrl) {
        throw new Error('O blob informado não pertence à operação HLS.');
      }
      if (operation.state !== 'releasing') {
        operation.state = 'releasing';
        operation.promise = runRelease(operationId, operation).catch(() => {});
      }
      return { operationId, state: 'releasing' };
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
