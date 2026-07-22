import assert from 'node:assert/strict';
import test from 'node:test';

import { HOST_COMMANDS, NATIVE_HOST } from '../src/youtube/protocol.js';
import { createNativePortClient } from '../src/background/native-port.js';

function fakePort() {
  const messages = []; const onMessage = []; const onDisconnect = [];
  return {
    messages, onMessage: { addListener(fn) { onMessage.push(fn); }, removeListener(fn) { const i = onMessage.indexOf(fn); if (i >= 0) onMessage.splice(i, 1); } },
    onDisconnect: { addListener(fn) { onDisconnect.push(fn); }, removeListener(fn) { const i = onDisconnect.indexOf(fn); if (i >= 0) onDisconnect.splice(i, 1); } },
    postMessage(message) { messages.push(message); }, disconnect() { for (const fn of [...onDisconnect]) fn(); },
    emit(message) { for (const fn of [...onMessage]) fn(message); },
  };
}

function clock() {
  const timers = []; return {
    set(fn) { const timer = { fn, active: true }; timers.push(timer); return timer; },
    clear(timer) { timer.active = false; }, fire() { for (const timer of timers) if (timer.active) { timer.active = false; timer.fn(); } },
  };
}

test('conecta uma vez, correlaciona respostas e encaminha eventos posteriores', async () => {
  const port = fakePort(); const events = []; const connections = []; const timers = clock();
  const client = createNativePortClient({ connectNative(name) { connections.push(name); return port; }, setTimeoutFn: timers.set, clearTimeoutFn: timers.clear, onEvent: (event) => events.push(event) });
  const first = client.request(HOST_COMMANDS.PING); const second = client.request(HOST_COMMANDS.GET_JOB);
  assert.deepEqual(connections, [NATIVE_HOST]); assert.equal(port.messages.length, 2); assert.notEqual(port.messages[0].requestId, port.messages[1].requestId);
  port.emit({ type: 'ready', requestId: port.messages[1].requestId, job: null });
  port.emit({ type: 'ready', requestId: port.messages[0].requestId, protocolVersion: '1', nativeName: 'host' });
  assert.equal((await first).type, 'ready'); assert.equal((await second).job, null);
  port.emit({ type: 'jobProgress', requestId: 'old', jobId: 'j1', stage: 'video', percent: 50 });
  assert.deepEqual(events.at(-1), { type: 'jobProgress', requestId: 'old', jobId: 'j1', stage: 'video', percent: 50 });
});

test('não resolve ping quando recebe a variante ready de getJob', async () => {
  const port = fakePort(); const events = []; const timers = clock();
  const client = createNativePortClient({ connectNative: () => port, setTimeoutFn: timers.set, clearTimeoutFn: timers.clear, onEvent: (event) => events.push(event) });
  const request = client.request(HOST_COMMANDS.PING);
  port.emit({ type: 'ready', requestId: port.messages[0].requestId, job: null });
  assert.deepEqual(events, [{ type: 'ready', requestId: port.messages[0].requestId, job: null }]);
  timers.fire();
  await assert.rejects(request, /tempo/);
});

test('start resolve em jobStarted e cancel confirma localmente sem aguardar ack', async () => {
  const port = fakePort(); const client = createNativePortClient({ connectNative: () => port, onEvent() {} });
  const start = client.request(HOST_COMMANDS.START_DOWNLOAD, { url: 'https://youtu.be/jNQXAC9IVRw', height: 720 });
  const startCommand = port.messages[0];
  port.emit({ type: 'jobStarted', requestId: startCommand.requestId, jobId: 'j1', job: { jobId: 'j1', videoId: '', title: '', height: 720, stage: 'preparing', percent: null, path: null, errorCode: null } });
  assert.equal((await start).jobId, 'j1');
  assert.deepEqual(await client.request(HOST_COMMANDS.CANCEL_DOWNLOAD, { jobId: 'j1' }), { requested: true, requestId: port.messages[1].requestId });
});

test('timeout não tenta novamente e disconnect rejeita pendências e publica evento interno uma vez', async () => {
  const port = fakePort(); const timers = clock(); const events = []; const client = createNativePortClient({ connectNative: () => port, setTimeoutFn: timers.set, clearTimeoutFn: timers.clear, onEvent: (event) => events.push(event) });
  const timed = client.request(HOST_COMMANDS.LIST_FORMATS, { url: 'https://youtu.be/jNQXAC9IVRw' });
  timers.fire(); await assert.rejects(timed, /tempo/); assert.equal(port.messages.length, 1);
  const pending = client.request(HOST_COMMANDS.GET_JOB); port.disconnect();
  await assert.rejects(pending, /conexão/i); assert.deepEqual(events, [{ type: 'nativeDisconnected' }]); assert.equal(client.connected, false);
  port.disconnect(); assert.equal(events.length, 1);
});
