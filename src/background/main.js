import {
  createBackgroundHandlers,
  createBackgroundMessageListener,
  createTerminalDownloadHandler,
} from './handlers.js';
import { createNativePortClient } from './native-port.js';
import { createBackgroundRouter } from './router.js';
import { createYouTubeCoordinator } from './youtube-coordinator.js';
import { createDownloadRelocationCoordinator } from './download-relocation.js';

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
let youtubeCoordinator;
const nativeClient = createNativePortClient({
  connectNative: (name) => globalThis.chrome.runtime.connectNative(name),
  setTimeoutFn: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeoutFn: (timer) => globalThis.clearTimeout(timer),
  onEvent(event) {
    youtubeCoordinator?.handleHostEvent(event).catch(() => {
      // A persisted job is reconciled on the next worker wake-up.
    });
  },
});
const relocation = createDownloadRelocationCoordinator({
  storageLocal: globalThis.chrome.storage.local,
  downloads: globalThis.chrome.downloads,
  nativeClient,
  now: () => Date.now(),
});
const hlsHandlers = createBackgroundHandlers({
  sendOffscreen,
  nativeClient,
  relocation,
});
youtubeCoordinator = createYouTubeCoordinator({
  nativeClient,
  storageLocal: globalThis.chrome.storage.local,
  notifications: globalThis.chrome.notifications,
  now: () => Date.now(),
});
const router = createBackgroundRouter({ hls: hlsHandlers, youtube: youtubeCoordinator });
const handleTerminalDownload = createTerminalDownloadHandler(hlsHandlers);

router.ready.catch(() => {
  // Durable records remain available for the next wake-up/reconciliation pass.
});
relocation.reconcile().catch(() => {
  // Pending deliveries remain durable for the next worker wake-up.
});

chrome.runtime.onMessage.addListener(createBackgroundMessageListener(router));
chrome.downloads.onChanged.addListener((delta) => {
  handleTerminalDownload(delta).catch(() => {
    // Tracking is intentionally retained so a later terminal event can retry.
  });
  relocation.handleChanged(delta).catch(() => {
    // The persisted relocation remains available for reconciliation.
  });
});
