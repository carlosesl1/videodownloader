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
    snapshotMessageListeners() { return [...onMessage]; },
    snapshotDisconnectListeners() { return [...onDisconnect]; },
  };
}

function clock() {
  const timers = []; return {
    set(fn, delay) { const timer = { fn, delay, active: true }; timers.push(timer); return timer; },
    clear(timer) { timer.active = false; }, fire() { for (const timer of timers) if (timer.active) { timer.active = false; timer.fn(); } },
    close() { for (const timer of timers) timer.active = false; },
    get delays() { return timers.map(({ delay }) => delay); },
    get entries() { return [...timers]; },
  };
}

test('conecta uma vez, correlaciona respostas e encaminha eventos posteriores', async () => {
  const port = fakePort(); const events = []; const connections = []; const timers = clock();
  const client = createNativePortClient({ connectNative(name) { connections.push(name); return port; }, setTimeoutFn: timers.set, clearTimeoutFn: timers.clear, onEvent: (event) => events.push(event) });
  const first = client.request(HOST_COMMANDS.PING); const second = client.request(HOST_COMMANDS.GET_JOB);
  assert.deepEqual(connections, [NATIVE_HOST]); assert.equal(port.messages.length, 2); assert.notEqual(port.messages[0].requestId, port.messages[1].requestId);
  port.emit({ type: 'ready', requestId: port.messages[1].requestId, job: null });
  port.emit({
    type: 'ready', requestId: port.messages[0].requestId, protocolVersion: 5,
    nativeName: 'host', hostVersion: '1.1.0', capabilities: [],
    defaultFolder: 'C:\\Users\\Carlos\\Downloads',
  });
  assert.equal((await first).type, 'ready'); assert.equal((await second).job, null);
  port.emit({ type: 'jobProgress', requestId: 'old', jobId: 'j1', stage: 'video', percent: 50 });
  assert.deepEqual(events.at(-1), { type: 'jobProgress', requestId: 'old', jobId: 'j1', stage: 'video', percent: 50 });
  client.disconnect();
});

test('não resolve nem encaminha ping quando recebe a variante ready de getJob', async () => {
  const port = fakePort(); const events = []; const timers = clock();
  const client = createNativePortClient({ connectNative: () => port, setTimeoutFn: timers.set, clearTimeoutFn: timers.clear, onEvent: (event) => events.push(event) });
  const request = client.request(HOST_COMMANDS.PING);
  port.emit({ type: 'ready', requestId: port.messages[0].requestId, job: null });
  assert.deepEqual(events, []);
  timers.fire();
  await assert.rejects(request, /tempo/);
  client.disconnect();
});

test('start e cancel só resolvem com a confirmação correlacionada do host', async () => {
  const port = fakePort(); const timers = clock(); const client = createNativePortClient({ connectNative: () => port, setTimeoutFn: timers.set, clearTimeoutFn: timers.clear, onEvent() {} });
  const start = client.request(HOST_COMMANDS.START_DOWNLOAD, { operationId: 'op-1', url: 'https://youtu.be/jNQXAC9IVRw', height: 720 });
  const startCommand = port.messages[0];
  port.emit({ type: 'jobStarted', requestId: startCommand.requestId, jobId: 'j1', job: { jobId: 'j1', operationId: 'op-1', videoId: '', title: '', height: 720, stage: 'preparing', percent: null, path: null, errorCode: null } });
  assert.equal((await start).jobId, 'j1');
  const cancel = client.request(HOST_COMMANDS.CANCEL_DOWNLOAD, { jobId: 'j1' });
  port.emit({
    type: 'jobCancelled', requestId: port.messages[1].requestId, jobId: 'j1',
  });
  assert.deepEqual(await cancel, {
    type: 'jobCancelled', requestId: port.messages[1].requestId, jobId: 'j1',
  });
  client.disconnect();
});

test('cancelamento aguarda confirmação e não esconde falha de outro processo do host', async () => {
  const port = fakePort(); const timers = clock();
  const client = createNativePortClient({
    connectNative: () => port,
    setTimeoutFn: timers.set,
    clearTimeoutFn: timers.clear,
    onEvent() {},
  });
  const cancellation = client.request(HOST_COMMANDS.CANCEL_DOWNLOAD, { jobId: 'job-edge' });
  const requestId = port.messages[0].requestId;
  let settled = false;
  cancellation.finally(() => { settled = true; }).catch(() => {});
  await Promise.resolve();
  assert.equal(settled, false);

  port.emit({
    type: 'jobFailed', requestId, code: 'JOB_OWNED_BY_ANOTHER_HOST',
    message: 'O download está ativo em outro processo do host.',
    details: { operation: 'cancelDownload' },
  });
  await assert.rejects(cancellation, (error) => (
    error.code === 'JOB_OWNED_BY_ANOTHER_HOST'
  ));
  client.disconnect();
});

test('correlaciona seleção e cancelamento de pasta', async () => {
  const port = fakePort(); const timers = clock(); const client = createNativePortClient({ connectNative: () => port, setTimeoutFn: timers.set, clearTimeoutFn: timers.clear, onEvent() {} });
  const selected = client.request(HOST_COMMANDS.CHOOSE_DOWNLOAD_FOLDER);
  port.emit({
    type: 'folderSelected', requestId: port.messages[0].requestId,
    path: 'C:\\Users\\Carlos\\Downloads',
  });
  assert.deepEqual(await selected, {
    type: 'folderSelected', requestId: port.messages[0].requestId,
    path: 'C:\\Users\\Carlos\\Downloads',
  });

  const cancelled = client.request(HOST_COMMANDS.CHOOSE_DOWNLOAD_FOLDER);
  port.emit({
    type: 'folderSelectionCancelled', requestId: port.messages[1].requestId,
  });
  assert.deepEqual(await cancelled, {
    type: 'folderSelectionCancelled', requestId: port.messages[1].requestId,
  });
  client.disconnect();
});

test('seletor de pasta usa um timeout longo e continua pendente antes dele', async () => {
  const port = fakePort(); const timers = clock();
  const client = createNativePortClient({
    connectNative: () => port,
    setTimeoutFn: timers.set,
    clearTimeoutFn: timers.clear,
    onEvent() {},
  });
  const selected = client.request(HOST_COMMANDS.CHOOSE_DOWNLOAD_FOLDER);
  const requestId = port.messages[0].requestId;
  assert.deepEqual(timers.delays, [5 * 60_000]);
  let outcome = 'pending';
  selected.then(() => { outcome = 'resolved'; }, () => { outcome = 'rejected'; });

  port.emit({
    type: 'folderSelected', requestId,
    path: 'C:\\Users\\Carlos\\Downloads',
  });
  assert.deepEqual(await selected, {
    type: 'folderSelected', requestId,
    path: 'C:\\Users\\Carlos\\Downloads',
  });
  client.disconnect();
});

test('correlaciona movimentação e ignora resposta de tipo errado', async () => {
  const port = fakePort(); const events = [];
  const timers = clock();
  const client = createNativePortClient({ connectNative: () => port, setTimeoutFn: timers.set, clearTimeoutFn: timers.clear, onEvent: (event) => events.push(event) });
  const payload = {
    operationId: 'op_1',
    downloadId: 7,
    sourcePath: 'C:\\Downloads\\Video Radar\\.staging\\op_1\\clip.mp4',
    destinationFolder: 'D:\\Videos',
  };
  const moved = client.request(HOST_COMMANDS.MOVE_DOWNLOADED_FILE, payload);
  const requestId = port.messages[0].requestId;
  assert.deepEqual(port.messages[0], {
    type: 'moveDownloadedFile', requestId, payload,
  });
  let resolved = false;
  moved.then(() => { resolved = true; });

  port.emit({ type: 'folderSelectionCancelled', requestId });
  await Promise.resolve();
  assert.equal(resolved, false);
  assert.deepEqual(events, []);

  port.emit({
    type: 'fileMoved', requestId, operationId: 'op_1', downloadId: 7,
    finalPath: 'D:\\Videos\\clip.mp4',
  });
  assert.deepEqual(await moved, {
    type: 'fileMoved', requestId, operationId: 'op_1', downloadId: 7,
    finalPath: 'D:\\Videos\\clip.mp4',
  });

  const revealPayload = { path: 'D:\\Videos\\clip.mp4' };
  const revealed = client.request(HOST_COMMANDS.REVEAL_DOWNLOADED_FILE, revealPayload);
  const revealRequestId = port.messages.at(-1).requestId;
  assert.deepEqual(port.messages.at(-1), {
    type: 'revealDownloadedFile', requestId: revealRequestId, payload: revealPayload,
  });
  port.emit({ type: 'fileRevealed', requestId: revealRequestId });
  assert.deepEqual(await revealed, { type: 'fileRevealed', requestId: revealRequestId });
  client.disconnect();
});

test('timeout não tenta novamente e disconnect rejeita pendências e publica evento interno uma vez', async () => {
  const port = fakePort(); const timers = clock(); const events = []; const client = createNativePortClient({ connectNative: () => port, setTimeoutFn: timers.set, clearTimeoutFn: timers.clear, onEvent: (event) => events.push(event) });
  const timed = client.request(HOST_COMMANDS.LIST_FORMATS, { url: 'https://youtu.be/jNQXAC9IVRw' });
  assert.deepEqual(timers.delays, [45_000]);
  timers.fire(); await assert.rejects(timed, /tempo/); assert.equal(port.messages.length, 1);
  const pending = client.request(HOST_COMMANDS.CHOOSE_DOWNLOAD_FOLDER); port.disconnect();
  await assert.rejects(pending, /conexão/i); assert.deepEqual(events, [{ type: 'nativeDisconnected' }]); assert.equal(client.connected, false);
  port.disconnect(); assert.equal(events.length, 1);
});

test('preserva o código seguro devolvido pelo auxiliar', async () => {
  const port = fakePort();
  const timers = clock();
  const client = createNativePortClient({ connectNative: () => port, setTimeoutFn: timers.set, clearTimeoutFn: timers.clear, onEvent() {} });
  const request = client.request(HOST_COMMANDS.LIST_FORMATS, {
    url: 'https://youtu.be/jNQXAC9IVRw',
  });
  port.emit({
    type: 'jobFailed',
    requestId: port.messages[0].requestId,
    code: 'YOUTUBE_METADATA_TIMEOUT',
    message: 'O YouTube demorou demais para responder.',
    details: { operation: 'listFormats' },
  });

  await assert.rejects(request, (error) => {
    assert.equal(error.code, 'YOUTUBE_METADATA_TIMEOUT');
    assert.equal(error.message, 'O YouTube demorou demais para responder.');
    return true;
  });
  client.disconnect();
});

test('ignora callbacks atrasados de uma porta antiga após reconectar', async () => {
  const firstPort = fakePort();
  const secondPort = fakePort();
  const timers = clock();
  const ports = [firstPort, secondPort];
  const client = createNativePortClient({
    connectNative: () => ports.shift(),
    setTimeoutFn: timers.set,
    clearTimeoutFn: timers.clear,
    onEvent() {},
  });

  const first = client.request(HOST_COMMANDS.PING);
  const staleMessage = firstPort.snapshotMessageListeners()[0];
  const staleDisconnect = firstPort.snapshotDisconnectListeners()[0];
  client.disconnect();
  await assert.rejects(first, (error) => error.code === 'NATIVE_DISCONNECTED');

  const second = client.request(HOST_COMMANDS.GET_JOB);
  staleDisconnect();
  staleMessage({ type: 'jobCancelled', requestId: 'old', jobId: 'old-job' });
  assert.equal(client.connected, true);
  secondPort.emit({ type: 'ready', requestId: secondPort.messages[0].requestId, job: null });
  assert.equal((await second).job, null);
  client.disconnect();
});

test('ignora idle timer já enfileirado de uma conexão anterior', async () => {
  const firstPort = fakePort();
  const secondPort = fakePort();
  const timers = clock();
  const ports = [firstPort, secondPort];
  const client = createNativePortClient({
    connectNative: () => ports.shift(),
    setTimeoutFn: timers.set,
    clearTimeoutFn: timers.clear,
    onEvent() {},
  });

  const first = client.request(HOST_COMMANDS.GET_JOB);
  firstPort.emit({ type: 'ready', requestId: firstPort.messages[0].requestId, job: null });
  await first;
  const staleIdle = timers.entries.at(-1).fn;
  client.disconnect();

  const second = client.request(HOST_COMMANDS.GET_JOB);
  secondPort.emit({ type: 'ready', requestId: secondPort.messages[0].requestId, job: null });
  await second;
  const currentIdle = timers.entries.at(-1).fn;

  staleIdle();
  assert.equal(client.connected, true);

  client.setKeepAlive('test', true);
  client.setKeepAlive('test', false);
  currentIdle();
  assert.equal(client.connected, true);
  client.disconnect();
});

test('descarta conexão parcialmente inicializada e permite tentar novamente', async () => {
  let partialDisconnects = 0;
  const partial = {
    postMessage() {},
    disconnect() { partialDisconnects += 1; },
    onMessage: { addListener() {}, removeListener() {} },
    onDisconnect: {
      addListener() { throw new Error('listener failure'); },
      removeListener() {},
    },
  };
  const healthy = fakePort();
  const timers = clock();
  const ports = [partial, healthy];
  const client = createNativePortClient({
    connectNative: () => ports.shift(),
    setTimeoutFn: timers.set,
    clearTimeoutFn: timers.clear,
    onEvent() {},
  });

  await assert.rejects(client.request(HOST_COMMANDS.PING), /listener failure/);
  assert.equal(client.connected, false);
  assert.equal(partialDisconnects, 1);

  const request = client.request(HOST_COMMANDS.GET_JOB);
  healthy.emit({ type: 'ready', requestId: healthy.messages[0].requestId, job: null });
  assert.equal((await request).job, null);
  client.disconnect();
});

test('falha protocolo imediatamente, limpa pendências e isola falha do observador', async () => {
  const port = fakePort();
  const timers = clock();
  const client = createNativePortClient({
    connectNative: () => port,
    setTimeoutFn: timers.set,
    clearTimeoutFn: timers.clear,
    onEvent() { throw new Error('observer failure'); },
  });
  const pending = client.request(HOST_COMMANDS.GET_JOB);

  port.emit({ type: 'ready', requestId: port.messages[0].requestId, job: { unsafe: true } });

  await assert.rejects(pending, (error) => error.code === 'NATIVE_DISCONNECTED');
  assert.equal(client.connected, false);
});

test('não encaminha respostas correlacionáveis que chegaram depois do timeout', async () => {
  const port = fakePort();
  const timers = clock();
  const events = [];
  const client = createNativePortClient({
    connectNative: () => port,
    setTimeoutFn: timers.set,
    clearTimeoutFn: timers.clear,
    onEvent: (event) => events.push(event),
  });
  const request = client.request(HOST_COMMANDS.GET_JOB);
  const requestId = port.messages[0].requestId;
  client.setKeepAlive('test', true);
  timers.fire();
  await assert.rejects(request, (error) => error.code === 'NATIVE_TIMEOUT');

  port.emit({ type: 'ready', requestId, job: null });
  port.emit({ type: 'jobCancelled', requestId: 'event-1', jobId: 'job-1' });
  assert.deepEqual(events, [{
    type: 'jobCancelled',
    requestId: 'event-1',
    jobId: 'job-1',
  }]);
  client.setKeepAlive('test', false);
  client.disconnect();
});
