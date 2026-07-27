import { DISCOVERY_ACTIONS } from '../detection/discovery-protocol.js';
import { YOUTUBE_ACTIONS } from '../youtube/protocol.js';

const DISCOVERY_ACTION_SET = new Set(Object.values(DISCOVERY_ACTIONS));
const YOUTUBE_ACTION_SET = new Set(Object.values(YOUTUBE_ACTIONS));

export function createBackgroundRouter({ hls, youtube, discovery }) {
  if (!hls?.handle || !youtube?.handle || !discovery?.handle) {
    throw new TypeError('Coordenador inválido');
  }
  return Object.freeze({
    ready: Promise.all([hls.ready, youtube.ready, discovery.ready]),
    handle(message) {
      if (DISCOVERY_ACTION_SET.has(message?.action)) return discovery.handle(message);
      return YOUTUBE_ACTION_SET.has(message?.action)
        ? youtube.handle(message)
        : hls.handle(message);
    },
  });
}
