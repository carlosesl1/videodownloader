import {
  createBackgroundHandlers,
  createBackgroundMessageListener,
  createTerminalDownloadHandler,
} from './handlers.js';
import { createNativePortClient } from './native-port.js';
import { createBackgroundRouter } from './router.js';
import { createYouTubeCoordinator } from './youtube-coordinator.js';
import { createDownloadRelocationCoordinator } from './download-relocation.js';
import { createDiscoveryCoordinator } from './discovery-coordinator.js';

export const MAINTENANCE_ALARM = 'videoRadarMaintenance';

export function createOffscreenSender({
  offscreen = globalThis.chrome.offscreen,
  runtime = globalThis.chrome.runtime,
  scheduleMaintenance = () => {},
} = {}) {
  let creatingDocument;
  let closingDocument;
  let activeSends = 0;

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

  async function sendOffscreen(message) {
    if (closingDocument) await closingDocument;
    activeSends += 1;
    try {
      await ensureDocument();
      return await runtime.sendMessage(message);
    } finally {
      activeSends -= 1;
      scheduleMaintenance();
    }
  }

  sendOffscreen.closeIfIdle = async () => {
    if (closingDocument) return closingDocument;
    if (activeSends > 0 || creatingDocument || typeof offscreen?.closeDocument !== 'function') {
      return false;
    }
    closingDocument = (async () => {
      const documentUrl = runtime.getURL('offscreen.html');
      const contexts = await runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [documentUrl],
      });
      if (contexts.length === 0 || activeSends > 0) return false;
      await offscreen.closeDocument();
      return true;
    })().finally(() => {
      closingDocument = undefined;
    });
    return closingDocument;
  };

  return sendOffscreen;
}

function scheduleMaintenance() {
  globalThis.chrome.alarms.create(MAINTENANCE_ALARM, { delayInMinutes: 1 });
}

const sendOffscreen = createOffscreenSender({ scheduleMaintenance });
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
  now: () => Date.now(),
  scheduleMaintenance,
});
youtubeCoordinator = createYouTubeCoordinator({
  nativeClient,
  storageLocal: globalThis.chrome.storage.local,
  notifications: globalThis.chrome.notifications,
  now: () => Date.now(),
});
const discoveryCoordinator = createDiscoveryCoordinator({
  tabs: globalThis.chrome.tabs,
  scripting: globalThis.chrome.scripting,
  storageSession: globalThis.chrome.storage.session,
  youtube: youtubeCoordinator,
  now: () => Date.now(),
});
const router = createBackgroundRouter({
  hls: hlsHandlers,
  youtube: youtubeCoordinator,
  discovery: discoveryCoordinator,
});
const handleTerminalDownload = createTerminalDownloadHandler(hlsHandlers);

async function closeOffscreenIfIdle() {
  if (!(await hlsHandlers.hasPendingOffscreenWork())) {
    await sendOffscreen.closeIfIdle();
  }
}

async function runMaintenance() {
  await Promise.all([hlsHandlers.reconcile(), relocation.reconcile()]);
  await closeOffscreenIfIdle();
}

Promise.all([router.ready, relocation.reconcile()])
  .then(closeOffscreenIfIdle)
  .catch(() => {
    // Durable records remain available for the next alarm or worker wake-up.
    scheduleMaintenance();
  });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name !== MAINTENANCE_ALARM) return;
  runMaintenance().catch(() => {
    scheduleMaintenance();
  });
});

chrome.runtime.onMessage.addListener(createBackgroundMessageListener(router));
chrome.tabs.onRemoved?.addListener((tabId) => {
  discoveryCoordinator.discard(tabId).catch(() => {
    // Session state is also rejected if a stale tab id is requested later.
  });
});
chrome.tabs.onUpdated?.addListener((tabId, changeInfo) => {
  if (typeof changeInfo?.url !== 'string') return;
  discoveryCoordinator.discard(tabId).catch(() => {
    // A later lookup validates the current page identity before restoring.
  });
});
chrome.downloads.onChanged.addListener((delta) => {
  handleTerminalDownload(delta).catch(() => {
    // Tracking is intentionally retained so a later terminal event can retry.
  });
  relocation.handleChanged(delta).catch(() => {
    // The persisted relocation remains available for reconciliation.
  });
});
