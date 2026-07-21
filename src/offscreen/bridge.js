import { assembleHls, inspectHls } from '../hls/hls-operation.js';
import { ACTIONS, assertOffscreenMessage } from '../shared/messages.js';

export function createOffscreenBridge({
  inspect = inspectHls,
  assemble = assembleHls,
  createObjectURL = URL.createObjectURL.bind(URL),
  revokeObjectURL = URL.revokeObjectURL.bind(URL),
} = {}) {
  const ownedBlobUrls = new Set();

  return {
    async handle(raw) {
      const message = assertOffscreenMessage(raw);

      if (message.action === ACTIONS.INSPECT_HLS) {
        return inspect(message.payload.url);
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

      const { blobUrl } = message.payload;
      if (!ownedBlobUrls.delete(blobUrl)) return { released: false };
      revokeObjectURL(blobUrl);
      return { released: true };
    },
  };
}
