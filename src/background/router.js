import { DISCOVERY_ACTIONS } from '../detection/discovery-protocol.js';
import { YOUTUBE_ACTIONS } from '../youtube/protocol.js';

const DISCOVERY_ACTION_SET = new Set(Object.values(DISCOVERY_ACTIONS));
const QUEUE_ACTION_SET = new Set([
  YOUTUBE_ACTIONS.GET_QUEUE,
  YOUTUBE_ACTIONS.CANCEL_DOWNLOAD,
  YOUTUBE_ACTIONS.PAUSE_DOWNLOAD,
  YOUTUBE_ACTIONS.RESUME_DOWNLOAD,
]);
const YOUTUBE_ACTION_SET = new Set(
  Object.values(YOUTUBE_ACTIONS).filter((action) => !QUEUE_ACTION_SET.has(action)),
);

export function createBackgroundRouter({ hls, youtube, discovery, queue = youtube }) {
  if (!hls?.handle || !youtube?.handle || !discovery?.handle || !queue?.handle) {
    throw new TypeError('Coordenador inválido');
  }
  return Object.freeze({
    ready: Promise.all([hls.ready, youtube.ready, discovery.ready]),
    handle(message) {
      if (DISCOVERY_ACTION_SET.has(message?.action)) return discovery.handle(message);
      if (QUEUE_ACTION_SET.has(message?.action)) return queue.handle(message);
      return YOUTUBE_ACTION_SET.has(message?.action)
        ? youtube.handle(message)
        : hls.handle(message);
    },
  });
}
