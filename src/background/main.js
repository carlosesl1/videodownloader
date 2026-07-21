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
        if (await offscreen.hasDocument()) return;
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
const handleTerminalDownload = createTerminalDownloadHandler({ sendOffscreen });

chrome.runtime.onMessage.addListener(createBackgroundMessageListener(handlers));
chrome.downloads.onChanged.addListener((delta) => {
  handleTerminalDownload(delta).catch(() => {
    // Tracking is intentionally retained so a later terminal event can retry.
  });
});
