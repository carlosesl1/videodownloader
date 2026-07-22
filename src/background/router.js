import { YOUTUBE_ACTIONS } from '../youtube/protocol.js';

const YOUTUBE_ACTION_SET = new Set(Object.values(YOUTUBE_ACTIONS));

export function createBackgroundRouter({ hls, youtube }) {
  if (!hls?.handle || !youtube?.handle) throw new TypeError('Coordenador inválido');
  return Object.freeze({
    ready: Promise.all([hls.ready, youtube.ready]),
    handle(message) {
      return YOUTUBE_ACTION_SET.has(message?.action)
        ? youtube.handle(message)
        : hls.handle(message);
    },
  });
}
