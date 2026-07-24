import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HOST_COMMANDS,
  HOST_EVENTS,
  MIN_NATIVE_PROTOCOL_VERSION,
  assertFormatsResult,
  assertHostEvent,
  hostCommand,
} from '../src/youtube/protocol.js';
import { canonicalYouTubePageUrl } from '../src/youtube/page-url.js';

const videoId = 'jNQXAC9IVRw';
const snapshot = {
  jobId: 'job-1', videoId, title: 'Me at the zoo', height: 720,
  stage: 'video', percent: 50, path: null, errorCode: null,
};

test('canonicaliza somente URLs YouTube equivalentes ao host nativo', () => {
  for (const input of [
    `https://youtube.com/watch?v=${videoId}`,
    `https://www.youtube.com/watch?v=${videoId}&t=3`,
    `https://m.youtube.com/watch?v=${videoId}`,
    `https://youtu.be/${videoId}?t=3`,
  ]) assert.equal(canonicalYouTubePageUrl(input), `https://www.youtube.com/watch?v=${videoId}`);
});

test('rejeita URLs YouTube com autoridade, caminho ou query ambíguos', () => {
  for (const input of [
    `http://youtube.com/watch?v=${videoId}`, `https://user@youtube.com/watch?v=${videoId}`,
    `https://@youtube.com/watch?v=${videoId}`, `https://youtube.com:444/watch?v=${videoId}`,
    `https://youtube.com.evil.test/watch?v=${videoId}`, `https://youtube.com/./watch?v=${videoId}`,
    `https://youtube.com/%2e/watch?v=${videoId}`, `https://youtube.com/extra/../watch?v=${videoId}`,
    `https://youtube.com\\watch?v=${videoId}`, `https://youtube.com/playlist?list=x`,
    `https://youtube.com/shorts/${videoId}`, `https://youtube.com/embed/${videoId}`,
    `https://youtu.be/${videoId}/extra`, `https://youtu.be/${videoId.slice(0, -1)}`,
    `https://youtube.com/watch?v=${videoId}&v=${videoId}`, `https://youtube.com/watch?v=${videoId}!`,
    `https://evil.test/watch?v=${videoId}`,
  ]) assert.equal(canonicalYouTubePageUrl(input), null, input);
});

test('hostCommand aceita só comando, request ID e payload objeto seguros', () => {
  assert.deepEqual(hostCommand(HOST_COMMANDS.PING, 'r.1', {}), {
    type: 'ping', requestId: 'r.1', payload: {},
  });
  for (const value of ['bad command', '', 'x'.repeat(129)]) {
    assert.throws(() => hostCommand(value, 'r1'), /Mensagem inválida/);
  }
  assert.throws(() => hostCommand(HOST_COMMANDS.PING, 'has space'), /Mensagem inválida/);
  assert.throws(() => hostCommand(HOST_COMMANDS.PING, 'r1', []), /Mensagem inválida/);
});

test('expõe os comandos e eventos nomeados do protocolo nativo v2', () => {
  assert.equal(MIN_NATIVE_PROTOCOL_VERSION, 2);
  assert.equal(HOST_COMMANDS.CHOOSE_DOWNLOAD_FOLDER, 'chooseDownloadFolder');
  assert.equal(HOST_COMMANDS.MOVE_DOWNLOADED_FILE, 'moveDownloadedFile');
  assert.equal(HOST_EVENTS.FOLDER_SELECTED, 'folderSelected');
  assert.equal(HOST_EVENTS.FOLDER_SELECTION_CANCELLED, 'folderSelectionCancelled');
  assert.equal(HOST_EVENTS.FILE_MOVED, 'fileMoved');
  assert.equal(Object.isFrozen(HOST_EVENTS), true);
});

test('valida os formatos reais de eventos do host e normaliza download', () => {
  const progressEvent = {
    type: 'jobProgress', requestId: 'r1', jobId: 'j1', stage: 'video', percent: 50,
    downloadedBytes: 50, totalBytes: 100, speedBytesPerSecond: 25, etaSeconds: 2,
  };
  assert.deepEqual(assertHostEvent(progressEvent), progressEvent);
  assert.deepEqual(assertHostEvent({ ...progressEvent, stage: 'download' }), {
    ...progressEvent, stage: 'video',
  });
  assert.deepEqual(assertHostEvent({
    type: 'ready', requestId: 'r1', protocolVersion: 2, nativeName: 'host',
    defaultFolder: 'C:\\Users\\Carlos\\Downloads',
  }), {
    type: 'ready', requestId: 'r1', protocolVersion: 2, nativeName: 'host',
    defaultFolder: 'C:\\Users\\Carlos\\Downloads',
  });
  assert.deepEqual(assertHostEvent({ type: 'ready', requestId: 'r1', job: null }), {
    type: 'ready', requestId: 'r1', job: null,
  });
  assert.deepEqual(assertHostEvent({ type: 'jobStarted', requestId: 'r1', jobId: 'j1', job: snapshot }), {
    type: 'jobStarted', requestId: 'r1', jobId: 'j1', job: snapshot,
  });
  assert.deepEqual(assertHostEvent({ type: 'jobCompleted', requestId: 'r1', jobId: 'j1', path: 'C:/Downloads/a.mp4' }), {
    type: 'jobCompleted', requestId: 'r1', jobId: 'j1', path: 'C:/Downloads/a.mp4',
  });
  assert.deepEqual(assertHostEvent({ type: 'jobCancelled', requestId: 'r1', jobId: 'j1' }), {
    type: 'jobCancelled', requestId: 'r1', jobId: 'j1',
  });
  assert.deepEqual(assertHostEvent({ type: 'jobFailed', requestId: 'r1', jobId: 'j1', code: 'HOST_ERROR', message: 'Falha segura', details: { command: 'download' } }), {
    type: 'jobFailed', requestId: 'r1', jobId: 'j1', code: 'HOST_ERROR', message: 'Falha segura', details: { command: 'download' },
  });
  assert.deepEqual(assertHostEvent({ type: 'jobFailed', requestId: 'r1', code: 'YOUTUBE_METADATA', message: 'Falha segura', details: { operation: 'listFormats' } }), {
    type: 'jobFailed', requestId: 'r1', code: 'YOUTUBE_METADATA', message: 'Falha segura', details: { operation: 'listFormats' },
  });
});

test('valida seleção, cancelamento e movimentação de destino', () => {
  assert.deepEqual(assertHostEvent({
    type: 'folderSelected', requestId: 'root', path: 'C:\\',
  }), {
    type: 'folderSelected', requestId: 'root', path: 'C:\\',
  });
  assert.deepEqual(assertHostEvent({
    type: 'folderSelected', requestId: 'r1', path: 'C:\\Users\\Carlos\\Downloads',
  }), {
    type: 'folderSelected', requestId: 'r1', path: 'C:\\Users\\Carlos\\Downloads',
  });
  assert.deepEqual(assertHostEvent({
    type: 'folderSelected', requestId: 'r2', path: '\\\\server\\share\\videos',
  }), {
    type: 'folderSelected', requestId: 'r2', path: '\\\\server\\share\\videos',
  });
  assert.deepEqual(assertHostEvent({
    type: 'folderSelectionCancelled', requestId: 'r3',
  }), {
    type: 'folderSelectionCancelled', requestId: 'r3',
  });
  assert.deepEqual(assertHostEvent({
    type: 'fileMoved', requestId: 'r4', downloadId: 0,
    finalPath: 'D:\\Videos\\clip.mp4',
  }), {
    type: 'fileMoved', requestId: 'r4', downloadId: 0,
    finalPath: 'D:\\Videos\\clip.mp4',
  });
});

test('rejeita caminhos relativos, segmentos ambíguos e chaves extras nos novos eventos', () => {
  for (const event of [
    { type: 'folderSelected', requestId: 'r1', path: 'Downloads\\video' },
    { type: 'folderSelected', requestId: 'r1', path: 'C:\\Downloads\\..\\Windows' },
    { type: 'folderSelected', requestId: 'r1', path: 'C:/Downloads' },
    { type: 'folderSelected', requestId: 'r1', path: 'C:\\Downloads', extra: true },
    { type: 'folderSelectionCancelled', requestId: 'r1', extra: true },
    { type: 'fileMoved', requestId: 'r1', downloadId: -1, finalPath: 'C:\\Downloads\\a.mp4' },
    { type: 'fileMoved', requestId: 'r1', downloadId: Number.MAX_SAFE_INTEGER + 1, finalPath: 'C:\\Downloads\\a.mp4' },
    { type: 'fileMoved', requestId: 'r1', downloadId: 1, finalPath: 'a.mp4' },
    { type: 'fileMoved', requestId: 'r1', downloadId: 1, finalPath: 'C:\\Downloads\\a.mp4', extra: true },
  ]) assert.throws(() => assertHostEvent(event), /Mensagem inválida/);
});

test('rejeita prefixos de dispositivo Windows em todos os caminhos do protocolo', () => {
  for (const path of [
    '\\\\?\\C:\\temp',
    '\\\\.\\C:\\temp',
    '\\\\?\\UNC\\server\\share\\temp',
    '\\\\.\\Volume{1234}\\temp',
    '\\\\??\\C:\\temp',
  ]) {
    for (const event of [
      { type: 'folderSelected', requestId: 'r1', path },
      { type: 'fileMoved', requestId: 'r1', downloadId: 1, finalPath: path },
      {
        type: 'ready', requestId: 'r1', protocolVersion: 2,
        nativeName: 'host', defaultFolder: path,
      },
    ]) assert.throws(() => assertHostEvent(event), /Mensagem inválida/, `${event.type}: ${path}`);
  }
});

test('rejeita caminhos Windows não canônicos ou com segmentos inválidos', () => {
  for (const path of [
    'C:\\foo:bar',
    'C:\\CON',
    'C:\\foo\\\\bar',
  ]) {
    assert.throws(() => assertHostEvent({
      type: 'folderSelected', requestId: 'r1', path,
    }), /Mensagem inválida/, path);
  }
});

test('ready do ping exige protocolo compatível, caminho absoluto e formato exato', () => {
  const ready = {
    type: 'ready', requestId: 'r1', protocolVersion: 2, nativeName: 'host',
    defaultFolder: 'C:\\Users\\Carlos\\Downloads',
  };
  assert.deepEqual(assertHostEvent(ready), ready);
  for (const event of [
    { ...ready, protocolVersion: 1 },
    { ...ready, protocolVersion: 1000 },
    { ...ready, protocolVersion: '2' },
    { ...ready, defaultFolder: 'Downloads' },
    { ...ready, extra: true },
    { type: 'ready', requestId: 'r1', protocolVersion: 2, nativeName: 'host' },
  ]) assert.throws(() => assertHostEvent(event), /Mensagem inválida/);
});

test('rejeita limites e valores inseguros vindos do host', () => {
  const base = { type: 'jobProgress', requestId: 'r1', jobId: 'j1', stage: 'video', percent: 50 };
  for (const event of [
    { ...base, percent: 101 }, { ...base, downloadedBytes: -1 }, { ...base, totalBytes: Infinity },
    { ...base, stage: 'unknown' }, { ...base, etaSeconds: NaN },
    { type: 'jobCompleted', requestId: 'r1', jobId: 'j1', path: 'x'.repeat(1025) },
    { type: 'jobFailed', requestId: 'r1', code: 'lowercase', message: 'falha', details: {} },
    { type: 'jobFailed', requestId: 'r1', code: 'HOST_ERROR', message: 'x'.repeat(257), details: {} },
    { type: 'jobFailed', requestId: 'r1', code: 'HOST_ERROR', message: 'falha', details: { nested: new Date() } },
    { type: 'formats', requestId: 'r1', videoId, title: 'x'.repeat(513), durationSeconds: 1, qualities: [] },
  ]) assert.throws(() => assertHostEvent(event), /Mensagem inválida/);
});

test('reduz formatos válidos com alturas distintas e ordenadas', () => {
  const event = {
    type: 'formats', requestId: 'r1', videoId, title: 'Me at the zoo', durationSeconds: 19,
    qualities: [
      { height: 1080, label: '1080p', container: 'mp4', combined: false },
      { height: 720, label: '720p', container: 'webm', combined: true },
    ],
  };
  assert.deepEqual(assertFormatsResult(event), {
    videoId, title: 'Me at the zoo', durationSeconds: 19, qualities: event.qualities,
  });
  assert.throws(() => assertHostEvent({ ...event, qualities: [...event.qualities, { ...event.qualities[1] }] }), /Mensagem inválida/);
});
