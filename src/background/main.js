import {
  createBackgroundHandlers,
  createBackgroundMessageListener,
  createTerminalDownloadHandler,
} from './handlers.js';

export function createOffscreenSender({
  offscreen = globalThis.chrome.offscreen,
  runtime = globalThis.chrome.runtime,
} = {}) {
  let creatingDocument;

  async function ensureDocument() {
    if (!creatingDocument) {
      creatingDocument = (async () => {
        const documentUrl = runtime.getURL('offscreen.html');
        const contexts = await runtime.getContexts({
          contextTypes: ['OFFSCREEN_DOCUMENT'],
          documentUrls: [documentUrl],
        });
        if (contexts.length > 0) return;
        await offscreen.createDocument({
          url: 'offscreen.html',
          reasons: ['BLOBS'],
          justification: 'Processar playlists HLS e manter blobs para downloads.',
        });
      })().finally(() => {
        creatingDocument = undefined;
      });
    }

    await creatingDocument;
  }

  return async function sendOffscreen(message) {
    await ensureDocument();
    return runtime.sendMessage(message);
  };
}

const sendOffscreen = createOffscreenSender();
const handlers = createBackgroundHandlers({ sendOffscreen });
const handleTerminalDownload = createTerminalDownloadHandler(handlers);

handlers.ready.catch(() => {
  // Durable records remain available for the next wake-up/reconciliation pass.
});

chrome.runtime.onMessage.addListener(createBackgroundMessageListener(handlers));
chrome.downloads.onChanged.addListener((delta) => {
  handleTerminalDownload(delta).catch(() => {
    // Tracking is intentionally retained so a later terminal event can retry.
  });
});
