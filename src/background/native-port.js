import { HOST_COMMANDS, HOST_EVENTS, NATIVE_HOST, assertHostEvent, hostCommand } from '../youtube/protocol.js';

const RESPONSE_TYPES = Object.freeze({
  [HOST_COMMANDS.PING]: new Set([HOST_EVENTS.READY]),
  [HOST_COMMANDS.LIST_FORMATS]: new Set([HOST_EVENTS.FORMATS]),
  [HOST_COMMANDS.START_DOWNLOAD]: new Set([HOST_EVENTS.JOB_STARTED, HOST_EVENTS.JOB_QUEUED]),
  [HOST_COMMANDS.CANCEL_DOWNLOAD]: new Set([HOST_EVENTS.JOB_CANCELLED]),
  [HOST_COMMANDS.PAUSE_DOWNLOAD]: new Set([HOST_EVENTS.JOB_PAUSED]),
  [HOST_COMMANDS.RESUME_DOWNLOAD]: new Set([HOST_EVENTS.JOB_QUEUED]),
  [HOST_COMMANDS.LIST_QUEUE]: new Set([HOST_EVENTS.QUEUE_SNAPSHOT]),
  [HOST_COMMANDS.GET_JOB]: new Set([HOST_EVENTS.READY]),
  [HOST_COMMANDS.CHOOSE_DOWNLOAD_FOLDER]: new Set([
    HOST_EVENTS.FOLDER_SELECTED,
    HOST_EVENTS.FOLDER_SELECTION_CANCELLED,
  ]),
  [HOST_COMMANDS.MOVE_DOWNLOADED_FILE]: new Set([HOST_EVENTS.FILE_MOVED]),
  [HOST_COMMANDS.REVEAL_DOWNLOADED_FILE]: new Set([HOST_EVENTS.FILE_REVEALED]),
  [HOST_COMMANDS.GET_DIAGNOSTICS]: new Set([HOST_EVENTS.DIAGNOSTICS]),
  [HOST_COMMANDS.SET_DIAGNOSTICS]: new Set([HOST_EVENTS.DIAGNOSTICS]),
  [HOST_COMMANDS.EXPORT_DIAGNOSTICS]: new Set([HOST_EVENTS.DIAGNOSTICS_EXPORTED]),
  [HOST_COMMANDS.CLEAR_DIAGNOSTICS]: new Set([HOST_EVENTS.DIAGNOSTICS_CLEARED]),
});
const DEFAULT_TIMEOUT_MS = 15_000;
const FORMAT_TIMEOUT_MS = 45_000;
const FOLDER_TIMEOUT_MS = 5 * 60_000;
const DIAGNOSTICS_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DISCONNECTED = 'A conexão com o host nativo foi encerrada.';
const TIMED_OUT = 'A conexão com o host nativo excedeu o tempo esperado.';
const ASYNC_EVENT_TYPES = new Set([
  HOST_EVENTS.JOB_STARTED,
  HOST_EVENTS.JOB_QUEUED,
  HOST_EVENTS.JOB_PAUSED,
  HOST_EVENTS.JOB_PROGRESS,
  HOST_EVENTS.JOB_COMPLETED,
  HOST_EVENTS.JOB_CANCELLED,
  HOST_EVENTS.JOB_FAILED,
]);

function requestError(message, code, type, requestId) {
  const error = new Error(message);
  error.code = code;
  error.command = type;
  error.requestId = requestId;
  return error;
}

/**
 * Native Messaging client. `nativeDisconnected` is an internal event (not a host
 * protocol event) emitted once for every port disconnect, for the coordinator.
 */
export function createNativePortClient({
  connectNative = globalThis.chrome?.runtime?.connectNative,
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout,
  onEvent = () => {},
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
} = {}) {
  if (typeof connectNative !== 'function' || typeof setTimeoutFn !== 'function'
    || typeof clearTimeoutFn !== 'function' || typeof onEvent !== 'function'
    || !Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 0) {
    throw new TypeError('Dependências inválidas do host nativo.');
  }
  let port = null;
  let portListeners = null;
  let idleTimer = null;
  let idleToken = null;
  let sequence = 0;
  const pending = new Map();
  const keepAliveReasons = new Set();

  function nextRequestId() {
    sequence += 1;
    return `native-${Date.now().toString(36)}-${sequence.toString(36)}`;
  }
  function clearIdleTimer() {
    idleToken = null;
    if (idleTimer === null || idleTimer === undefined) return;
    clearTimeoutFn(idleTimer);
    idleTimer = null;
  }
  function emitEvent(event) {
    try {
      onEvent(event);
    } catch {
      // Consumer failures must never corrupt transport cleanup or correlation.
    }
  }
  function closePort({ notify = false, expectedPort = port, disconnect = true } = {}) {
    if (!port || port !== expectedPort) return;
    const disconnectedPort = port;
    const listeners = portListeners;
    port = null;
    portListeners = null;
    clearIdleTimer();
    disconnectedPort.onMessage?.removeListener?.(listeners?.message);
    disconnectedPort.onDisconnect?.removeListener?.(listeners?.disconnect);
    for (const [requestId, current] of pending) {
      pending.delete(requestId);
      if (current.timer !== null && current.timer !== undefined) clearTimeoutFn(current.timer);
      current.reject(requestError(DISCONNECTED, 'NATIVE_DISCONNECTED', current.type, requestId));
    }
    if (notify) emitEvent({ type: 'nativeDisconnected' });
    if (!disconnect) return;
    try { disconnectedPort.disconnect?.(); } catch {
      // The port is already unusable; local state has been released above.
    }
  }
  function scheduleIdleDisconnect() {
    clearIdleTimer();
    if (!port || pending.size > 0 || keepAliveReasons.size > 0) return;
    if (idleTimeoutMs === 0) {
      closePort();
      return;
    }
    const scheduledPort = port;
    const token = {};
    idleToken = token;
    idleTimer = setTimeoutFn(() => {
      if (idleToken !== token) return;
      idleTimer = null;
      idleToken = null;
      if (port === scheduledPort && pending.size === 0 && keepAliveReasons.size === 0) {
        closePort({ expectedPort: scheduledPort });
      }
    }, idleTimeoutMs);
    idleTimer?.unref?.();
  }
  function settle(requestId, callback, value) {
    const current = pending.get(requestId);
    if (!current) return false;
    pending.delete(requestId);
    if (current.timer !== null && current.timer !== undefined) clearTimeoutFn(current.timer);
    callback(value);
    scheduleIdleDisconnect();
    return true;
  }
  function handleDisconnect(connected) {
    closePort({ notify: true, expectedPort: connected, disconnect: false });
  }
  function handleMessage(connected, raw) {
    if (port !== connected) return;
    let event;
    try {
      event = assertHostEvent(raw);
    } catch {
      emitEvent({ type: 'nativeProtocolError' });
      closePort({ notify: true, expectedPort: connected });
      return;
    }
    const current = pending.get(event.requestId);
    if (current && event.type === HOST_EVENTS.JOB_FAILED) {
      const error = new Error(event.message);
      error.code = event.code;
      error.details = event.details;
      settle(event.requestId, current.reject, error);
      return;
    }
    if (current && current.expected(event)) {
      settle(event.requestId, current.resolve, event);
      return;
    }
    if (ASYNC_EVENT_TYPES.has(event.type)
      && (event.type !== HOST_EVENTS.JOB_FAILED || Object.hasOwn(event, 'jobId'))) {
      emitEvent(event);
    }
  }
  function connect() {
    if (port) return port;
    clearIdleTimer();
    const connected = connectNative(NATIVE_HOST);
    if (!connected || typeof connected.postMessage !== 'function' || !connected.onMessage?.addListener || !connected.onDisconnect?.addListener) {
      throw new Error('Não foi possível conectar ao host nativo.');
    }
    const listeners = {
      message: (raw) => handleMessage(connected, raw),
      disconnect: () => handleDisconnect(connected),
    };
    try {
      connected.onMessage.addListener(listeners.message);
      connected.onDisconnect.addListener(listeners.disconnect);
    } catch (error) {
      connected.onMessage?.removeListener?.(listeners.message);
      connected.onDisconnect?.removeListener?.(listeners.disconnect);
      try { connected.disconnect?.(); } catch {
        // The unusable partial connection has no state worth retaining.
      }
      throw error;
    }
    port = connected;
    portListeners = listeners;
    return connected;
  }
  function request(type, payload = {}) {
    const requestId = nextRequestId();
    let command;
    try { command = hostCommand(type, requestId, payload); } catch (error) { return Promise.reject(error); }
    let connected;
    try { connected = connect(); } catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      const timeoutMs = type === HOST_COMMANDS.LIST_FORMATS
        ? FORMAT_TIMEOUT_MS
        : type === HOST_COMMANDS.CHOOSE_DOWNLOAD_FOLDER
          ? FOLDER_TIMEOUT_MS
          : type === HOST_COMMANDS.EXPORT_DIAGNOSTICS
            ? DIAGNOSTICS_TIMEOUT_MS
            : DEFAULT_TIMEOUT_MS;
      const timer = setTimeoutFn(() => {
        const current = pending.get(requestId);
        if (!current) return;
        pending.delete(requestId);
        reject(requestError(TIMED_OUT, 'NATIVE_TIMEOUT', type, requestId));
        scheduleIdleDisconnect();
      }, timeoutMs);
      pending.set(requestId, {
        type,
        expected(event) {
          if (!RESPONSE_TYPES[type]?.has(event.type)) return false;
          if (type === HOST_COMMANDS.PING) return Object.hasOwn(event, 'protocolVersion');
          if (type === HOST_COMMANDS.GET_JOB) return Object.hasOwn(event, 'job');
          return true;
        },
        resolve, reject, timer,
      });
      try { connected.postMessage(command); } catch (error) { settle(requestId, reject, error); }
    });
  }

  function setKeepAlive(reason, enabled) {
    if (typeof reason !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(reason)) {
      throw new TypeError('Motivo de conexão inválido.');
    }
    if (enabled) {
      keepAliveReasons.add(reason);
      clearIdleTimer();
    } else {
      keepAliveReasons.delete(reason);
      scheduleIdleDisconnect();
    }
  }

  return Object.freeze({
    request,
    disconnect: () => closePort(),
    setKeepAlive,
    get connected() { return Boolean(port); },
    get keptAlive() { return keepAliveReasons.size > 0; },
  });
}
