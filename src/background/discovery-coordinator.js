import { scanPage } from '../detection/scan-page.js';
import {
  DISCOVERY_ACTIONS,
  DISCOVERY_PREFIX,
  MAX_DISCOVERY_SNAPSHOT_BYTES,
  assertDiscoveryMessage,
  sanitizeDiscoverySnapshot,
  sanitizePageScanResult,
  sanitizeYouTubeCatalog,
  youtubeFormatsMessage,
} from '../detection/discovery-protocol.js';
import { canonicalMediaPage } from '../media/page-url.js';

export { DISCOVERY_ACTIONS };

export const DISCOVERY_STORAGE_BUDGET_BYTES = 2 * MAX_DISCOVERY_SNAPSHOT_BYTES;

const SAFE_ERROR = /^[A-Z0-9_]{1,64}$/;
const ACTIONABLE_MEDIA_ERRORS = new Set([
  'LOGIN_REQUIRED',
  'RATE_LIMITED',
  'PRIVATE_CONTENT',
  'NO_VIDEO',
  'UNSUPPORTED_POST',
  'EXTRACTOR_CHANGED',
]);

function storageKey(tabId) {
  return `${DISCOVERY_PREFIX}${tabId}`;
}

function pageIdentity(rawUrl) {
  const mediaPage = canonicalMediaPage(rawUrl);
  if (mediaPage) return mediaPage.canonicalUrl;
  if (typeof rawUrl !== 'string') throw new Error('URL inválida');
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('URL inválida');
  parsed.hash = '';
  return parsed.href;
}

function targetFor(pageUrl, mediaPage) {
  if (mediaPage) return mediaPage.platform === 'x' ? 'x.com' : `${mediaPage.platform}.com`;
  return new URL(pageUrl).host || 'aba atual';
}

function errorCode(error) {
  return typeof error?.code === 'string' && SAFE_ERROR.test(error.code)
    ? error.code
    : 'SCAN_FAILED';
}

function storedEntryBytes(key, value) {
  const serialized = JSON.stringify({ [key]: value });
  if (typeof serialized !== 'string') throw new Error('Estado de descoberta inválido');
  let bytes = 0;
  for (const character of serialized) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x7F) bytes += 1;
    else if (codePoint <= 0x7FF) bytes += 2;
    else if (codePoint <= 0xFFFF) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

export function createDiscoveryCoordinator({
  tabs,
  scripting,
  storageSession,
  youtube,
  now,
  snapshotBudgetBytes = DISCOVERY_STORAGE_BUDGET_BYTES,
}) {
  if (typeof tabs?.get !== 'function'
    || typeof scripting?.executeScript !== 'function'
    || typeof storageSession?.get !== 'function'
    || typeof storageSession?.set !== 'function'
    || typeof storageSession?.remove !== 'function'
    || typeof youtube?.handle !== 'function'
    || typeof now !== 'function'
    || !Number.isSafeInteger(snapshotBudgetBytes)
    || snapshotBudgetBytes < 1_024) {
    throw new TypeError('Dependências inválidas do coordenador de descoberta.');
  }

  const inFlight = new Map();
  let storageQueue = Promise.resolve();

  function queueStorage(operation) {
    const queued = storageQueue.then(operation);
    storageQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  function timestamp() {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Relógio inválido.');
    return value;
  }

  function read(tabId) {
    return queueStorage(async () => {
      const key = storageKey(tabId);
      const stored = await storageSession.get(key);
      if (!stored || !Object.hasOwn(stored, key)) return null;
      try {
        return sanitizeDiscoverySnapshot(stored[key]);
      } catch {
        await storageSession.remove(key);
        return null;
      }
    });
  }

  function persist(snapshot) {
    const sanitized = sanitizeDiscoverySnapshot(snapshot);
    return queueStorage(async () => {
      const key = storageKey(sanitized.tabId);
      const stored = await storageSession.get(null);
      const retained = [];
      const invalidKeys = [];
      let totalBytes = storedEntryBytes(key, sanitized);

      if (stored && typeof stored === 'object') {
        for (const [storedKey, storedValue] of Object.entries(stored)) {
          if (!storedKey.startsWith(DISCOVERY_PREFIX) || storedKey === key) continue;
          try {
            const retainedSnapshot = sanitizeDiscoverySnapshot(storedValue);
            if (storageKey(retainedSnapshot.tabId) !== storedKey) {
              throw new Error('Estado de descoberta inválido');
            }
            const bytes = storedEntryBytes(storedKey, retainedSnapshot);
            totalBytes += bytes;
            retained.push({
              key: storedKey,
              bytes,
              updatedAt: retainedSnapshot.updatedAt,
            });
          } catch {
            invalidKeys.push(storedKey);
          }
        }
      }

      const protectedKeys = new Set([...inFlight.keys()].map(storageKey));
      retained.sort((left, right) => left.updatedAt - right.updatedAt
        || left.key.localeCompare(right.key));
      const removals = [...invalidKeys];
      for (const entry of retained) {
        if (totalBytes <= snapshotBudgetBytes) break;
        if (protectedKeys.has(entry.key)) continue;
        removals.push(entry.key);
        totalBytes -= entry.bytes;
      }
      for (const staleKey of removals) await storageSession.remove(staleKey);
      await storageSession.set({ [key]: sanitized });
      return sanitized;
    });
  }

  function removeSnapshot(tabId) {
    return queueStorage(() => storageSession.remove(storageKey(tabId)));
  }

  async function currentTab(tabId) {
    const tab = await tabs.get(tabId);
    if (!tab || tab.id !== tabId) throw new Error('Aba inválida');
    const mediaPage = canonicalMediaPage(tab.url);
    const pageUrl = pageIdentity(tab.url);
    return {
      pageUrl,
      mediaPage,
      target: targetFor(pageUrl, mediaPage),
      kind: mediaPage
        ? (mediaPage.platform === 'youtube' ? 'youtube' : 'remote-media')
        : 'page',
    };
  }

  async function stillOnPage(tabId, expectedPageUrl) {
    try {
      return (await currentTab(tabId)).pageUrl === expectedPageUrl;
    } catch {
      return false;
    }
  }

  async function run(tabId) {
    const page = await currentTab(tabId);
    const base = {
      schemaVersion: 1,
      tabId,
      pageUrl: page.pageUrl,
      target: page.target,
      kind: page.kind,
      mediaUrl: page.mediaPage?.canonicalUrl ?? null,
      view: { selections: [], inspections: [] },
    };
    await persist({
      ...base,
      status: 'scanning',
      result: null,
      errorCode: null,
      updatedAt: timestamp(),
    });

    try {
      let resultBase = base;
      let result;
      if (page.mediaPage) {
        result = sanitizeYouTubeCatalog(
          await youtube.handle(youtubeFormatsMessage(page.mediaPage.canonicalUrl)),
        );
      } else {
        const rawScan = (await scripting.executeScript({
            target: { tabId },
            func: scanPage,
          }))?.[0]?.result;
        const focusedPage = canonicalMediaPage(rawScan?.focusedPageUrl);
        if (focusedPage) {
          try {
            result = sanitizeYouTubeCatalog(
              await youtube.handle(youtubeFormatsMessage(focusedPage.canonicalUrl)),
            );
            resultBase = {
              ...base,
              target: targetFor(focusedPage.canonicalUrl, focusedPage),
              kind: focusedPage.platform === 'youtube' ? 'youtube' : 'remote-media',
              mediaUrl: focusedPage.canonicalUrl,
            };
          } catch (error) {
            if (ACTIONABLE_MEDIA_ERRORS.has(errorCode(error))) throw error;
            const fallback = sanitizePageScanResult(rawScan);
            if (fallback.candidates.length === 0) throw error;
            result = fallback;
          }
        } else {
          result = sanitizePageScanResult(rawScan);
        }
      }

      if (!await stillOnPage(tabId, page.pageUrl)) {
        await removeSnapshot(tabId);
        return null;
      }
      return persist({
        ...resultBase,
        status: 'results',
        result,
        errorCode: null,
        updatedAt: timestamp(),
      });
    } catch (error) {
      if (!await stillOnPage(tabId, page.pageUrl)) {
        await removeSnapshot(tabId);
        return null;
      }
      return persist({
        ...base,
        status: 'error',
        result: null,
        errorCode: errorCode(error),
        updatedAt: timestamp(),
      });
    }
  }

  function start(tabId) {
    const existing = inFlight.get(tabId);
    if (existing) return existing;
    const task = run(tabId).finally(() => {
      if (inFlight.get(tabId) === task) inFlight.delete(tabId);
    });
    inFlight.set(tabId, task);
    return task;
  }

  async function get(tabId) {
    const snapshot = await read(tabId);
    if (!snapshot) return null;
    let page;
    try {
      page = await currentTab(tabId);
    } catch {
      await removeSnapshot(tabId);
      return null;
    }
    if (page.pageUrl !== snapshot.pageUrl) {
      await removeSnapshot(tabId);
      return null;
    }
    if (snapshot.status === 'scanning' && !inFlight.has(tabId)) {
      return persist({
        ...snapshot,
        status: 'error',
        result: null,
        errorCode: 'SCAN_INTERRUPTED',
        updatedAt: timestamp(),
      });
    }
    return snapshot;
  }

  async function updateView(tabId, view) {
    const snapshot = await get(tabId);
    if (!snapshot || snapshot.status !== 'results') return snapshot;
    return persist({
      ...snapshot,
      view,
      updatedAt: timestamp(),
    });
  }

  async function discard(tabId) {
    if (!Number.isSafeInteger(tabId) || tabId < 0) return;
    await removeSnapshot(tabId);
  }

  return Object.freeze({
    ready: Promise.resolve(),
    discard,
    handle(raw) {
      const message = assertDiscoveryMessage(raw);
      if (message.action === DISCOVERY_ACTIONS.START) return start(message.tabId);
      if (message.action === DISCOVERY_ACTIONS.UPDATE_VIEW) {
        return updateView(message.tabId, message.view);
      }
      return get(message.tabId);
    },
  });
}
