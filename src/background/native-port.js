import { HOST_COMMANDS, NATIVE_HOST, assertHostEvent, hostCommand } from '../youtube/protocol.js';

const RESPONSE_TYPES = Object.freeze({
  [HOST_COMMANDS.PING]: 'ready', [HOST_COMMANDS.LIST_FORMATS]: 'formats',
  [HOST_COMMANDS.START_DOWNLOAD]: 'jobStarted', [HOST_COMMANDS.GET_JOB]: 'ready',
});
const TIMEOUT_MS = 15_000;
const DISCONNECTED = 'A conexão com o host nativo foi encerrada.';
const TIMED_OUT = 'A conexão com o host nativo excedeu o tempo esperado.';

/**
 * Native Messaging client. `nativeDisconnected` is an internal event (not a host
 * protocol event) emitted once for every port disconnect, for the coordinator.
 */
export function createNativePortClient({
  connectNative = globalThis.chrome?.runtime?.connectNative,
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout,
  onEvent = () => {},
} = {}) {
  if (typeof connectNative !== 'function' || typeof setTimeoutFn !== 'function' || typeof clearTimeoutFn !== 'function' || typeof onEvent !== 'function') {
    throw new TypeError('Dependências inválidas do host nativo.');
  }
  let port = null;
  let sequence = 0;
  const pending = new Map();

  function nextRequestId() {
    sequence += 1;
    return `native-${Date.now().toString(36)}-${sequence.toString(36)}`;
  }
  function settle(requestId, callback, value) {
    const current = pending.get(requestId);
    if (!current) return false;
    pending.delete(requestId);
    clearTimeoutFn(current.timer);
    callback(value);
    return true;
  }
  function handleDisconnect() {
    if (!port) return;
    const disconnectedPort = port;
    port = null;
    disconnectedPort.onMessage?.removeListener?.(handleMessage);
    disconnectedPort.onDisconnect?.removeListener?.(handleDisconnect);
    for (const [requestId, current] of pending) {
      pending.delete(requestId);
      clearTimeoutFn(current.timer);
      current.reject(new Error(DISCONNECTED));
    }
    onEvent({ type: 'nativeDisconnected' });
  }
  function handleMessage(raw) {
    let event;
    try { event = assertHostEvent(raw); } catch { onEvent({ type: 'nativeProtocolError' }); return; }
    const current = pending.get(event.requestId);
    if (current && event.type === 'jobFailed') {
      settle(event.requestId, current.reject, new Error(event.message));
      return;
    }
    if (current && current.expected(event)) {
      settle(event.requestId, current.resolve, event);
      return;
    }
    onEvent(event);
  }
  function connect() {
    if (port) return port;
    const connected = connectNative(NATIVE_HOST);
    if (!connected || typeof connected.postMessage !== 'function' || !connected.onMessage?.addListener || !connected.onDisconnect?.addListener) {
      throw new Error('Não foi possível conectar ao host nativo.');
    }
    port = connected;
    port.onMessage.addListener(handleMessage);
    port.onDisconnect.addListener(handleDisconnect);
    return port;
  }
  function request(type, payload = {}) {
    const requestId = nextRequestId();
    let command;
    try { command = hostCommand(type, requestId, payload); } catch (error) { return Promise.reject(error); }
    let connected;
    try { connected = connect(); } catch (error) { return Promise.reject(error); }
    if (type === HOST_COMMANDS.CANCEL_DOWNLOAD) {
      try { connected.postMessage(command); return Promise.resolve({ requested: true, requestId }); } catch (error) { return Promise.reject(error); }
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeoutFn(() => {
        const current = pending.get(requestId);
        if (!current) return;
        pending.delete(requestId);
        reject(new Error(TIMED_OUT));
      }, TIMEOUT_MS);
      pending.set(requestId, {
        expected(event) {
          if (event.type !== RESPONSE_TYPES[type]) return false;
          if (type === HOST_COMMANDS.PING) return Object.hasOwn(event, 'protocolVersion');
          if (type === HOST_COMMANDS.GET_JOB) return Object.hasOwn(event, 'job');
          return true;
        },
        resolve, reject, timer,
      });
      try { connected.postMessage(command); } catch (error) { settle(requestId, reject, error); }
    });
  }

  return Object.freeze({
    request,
    disconnect: () => port?.disconnect(),
    get connected() { return Boolean(port); },
  });
}
