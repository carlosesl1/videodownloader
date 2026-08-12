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
    `https://youtube.com/shorts/${videoId}`,
    `https://www.youtube.com/shorts/${videoId}?feature=share`,
    `https://m.youtube.com/shorts/${videoId}`,
  ]) assert.equal(canonicalYouTubePageUrl(input), `https://www.youtube.com/watch?v=${videoId}`);
});

test('preserva plataforma allowlisted em catálogos sociais', () => {
  const event = {
    type: 'formats',
    requestId: 'r-social',
    platform: 'tiktok',
    videoId: '7488298911734435077',
    title: 'Public TikTok',
    durationSeconds: 12,
    qualities: [{ height: 720, label: '720p', container: 'mp4', combined: true }],
  };

  assert.deepEqual(assertFormatsResult(event), {
    platform: 'tiktok',
    videoId: event.videoId,
    title: event.title,
    durationSeconds: 12,
    qualities: event.qualities,
  });
  assert.throws(
    () => assertHostEvent({ ...event, platform: 'evil' }),
    /Mensagem inválida/,
  );
});

test('rejeita URLs YouTube com autoridade, caminho ou query ambíguos', () => {
  for (const input of [
    `http://youtube.com/watch?v=${videoId}`, `https://user@youtube.com/watch?v=${videoId}`,
    `https://@youtube.com/watch?v=${videoId}`, `https://youtube.com:444/watch?v=${videoId}`,
    `https://youtube.com.evil.test/watch?v=${videoId}`, `https://youtube.com/./watch?v=${videoId}`,
    `https://youtube.com/%2e/watch?v=${videoId}`, `https://youtube.com/extra/../watch?v=${videoId}`,
    `https://youtube.com\\watch?v=${videoId}`, `https://youtube.com/playlist?list=x`,
    `https://youtube.com/shorts/${videoId}/extra`, `https://youtube.com/shorts/${videoId.slice(0, -1)}`,
    `https://youtube.com/embed/${videoId}`,
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

test('expõe os comandos e eventos nomeados do protocolo nativo v5', () => {
  assert.equal(MIN_NATIVE_PROTOCOL_VERSION, 5);
  assert.equal(HOST_COMMANDS.CHOOSE_DOWNLOAD_FOLDER, 'chooseDownloadFolder');
  assert.equal(HOST_COMMANDS.MOVE_DOWNLOADED_FILE, 'moveDownloadedFile');
  assert.equal(HOST_COMMANDS.REVEAL_DOWNLOADED_FILE, 'revealDownloadedFile');
  assert.equal(HOST_EVENTS.FOLDER_SELECTED, 'folderSelected');
  assert.equal(HOST_EVENTS.FOLDER_SELECTION_CANCELLED, 'folderSelectionCancelled');
  assert.equal(HOST_EVENTS.FILE_MOVED, 'fileMoved');
  assert.equal(HOST_EVENTS.FILE_REVEALED, 'fileRevealed');
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
    type: 'ready', requestId: 'r1', protocolVersion: 5, nativeName: 'host',
    hostVersion: '1.2.0', capabilities: ['idempotentStart', 'idempotentMove'],
    defaultFolder: 'C:\\Users\\Carlos\\Downloads',
  }), {
    type: 'ready', requestId: 'r1', protocolVersion: 5, nativeName: 'host',
    hostVersion: '1.2.0', capabilities: ['idempotentStart', 'idempotentMove'],
    defaultFolder: 'C:\\Users\\Carlos\\Downloads',
  });
  assert.deepEqual(assertHostEvent({ type: 'ready', requestId: 'r1', job: null }), {
    type: 'ready', requestId: 'r1', job: null,
  });
  assert.deepEqual(assertHostEvent({ type: 'jobStarted', requestId: 'r1', jobId: 'j1', job: snapshot }), {
    type: 'jobStarted', requestId: 'r1', jobId: 'j1', job: snapshot,
  });
  assert.deepEqual(assertHostEvent({ type: 'jobCompleted', requestId: 'r1', jobId: 'j1', path: 'C:\\Downloads\\a.mp4' }), {
    type: 'jobCompleted', requestId: 'r1', jobId: 'j1', path: 'C:\\Downloads\\a.mp4',
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
    type: 'fileMoved', requestId: 'r4', operationId: 'move-1', downloadId: 0,
    finalPath: 'D:\\Videos\\clip.mp4',
  }), {
    type: 'fileMoved', requestId: 'r4', operationId: 'move-1', downloadId: 0,
    finalPath: 'D:\\Videos\\clip.mp4',
  });
  assert.deepEqual(assertHostEvent({
    type: 'fileRevealed', requestId: 'r5',
  }), {
    type: 'fileRevealed', requestId: 'r5',
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
    { type: 'fileRevealed', requestId: 'r1', path: 'C:\\Downloads\\a.mp4' },
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
      { type: 'fileMoved', requestId: 'r1', operationId: 'move-1', downloadId: 1, finalPath: path },
      {
        type: 'ready', requestId: 'r1', protocolVersion: 5,
        nativeName: 'host', hostVersion: '1.1.0', capabilities: [], defaultFolder: path,
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
    type: 'ready', requestId: 'r1', protocolVersion: 5, nativeName: 'host',
    hostVersion: '1.1.0', capabilities: ['idempotentStart'],
    defaultFolder: 'C:\\Users\\Carlos\\Downloads',
  };
  assert.deepEqual(assertHostEvent(ready), ready);
  for (const event of [
    { ...ready, protocolVersion: 2 },
    { ...ready, protocolVersion: 1000 },
    { ...ready, protocolVersion: '2' },
    { ...ready, defaultFolder: 'Downloads' },
    { ...ready, extra: true },
    {
      type: 'ready', requestId: 'r1', protocolVersion: 5, nativeName: 'host',
      hostVersion: '1.1.0', capabilities: ['idempotentStart'],
    },
  ]) assert.throws(() => assertHostEvent(event), /Mensagem inválida/);
});

test('rejeita limites e valores inseguros vindos do host', () => {
  const base = { type: 'jobProgress', requestId: 'r1', jobId: 'j1', stage: 'video', percent: 50 };
  for (const event of [
    { ...base, percent: 101 }, { ...base, downloadedBytes: -1 }, { ...base, totalBytes: Infinity },
    { ...base, stage: 'unknown' }, { ...base, etaSeconds: NaN },
    { type: 'jobStarted', requestId: 'r1', jobId: 'j1', job: { ...snapshot, jobId: 123 } },
    { type: 'jobCompleted', requestId: 'r1', jobId: 'j1', path: 'x'.repeat(1025) },
    { type: 'jobFailed', requestId: 'r1', code: 123, message: 'falha', details: {} },
    { type: 'jobFailed', requestId: 'r1', code: 'lowercase', message: 'falha', details: {} },
    { type: 'jobFailed', requestId: 'r1', code: 'HOST_ERROR', message: 'x'.repeat(257), details: {} },
    { type: 'jobFailed', requestId: 'r1', code: 'HOST_ERROR', message: 'falha', details: { nested: new Date() } },
    { type: 'formats', requestId: 'r1', videoId, title: 'x'.repeat(513), durationSeconds: 1, qualities: [] },
    { type: 'formats', requestId: 'r1', videoId: 123, title: 'video', durationSeconds: 1, qualities: [] },
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

test('valida diagnóstico redigido e caminhos de exportação', () => {
  const diagnostics = {
    type: 'diagnostics', requestId: 'health-1', generatedAt: '2026-08-12T12:00:00Z',
    hostVersion: '1.2.0', protocolVersion: 5, architecture: 'arm64',
    operatingSystem: 'Microsoft Windows 11', availableBytes: 123456,
    loggingEnabled: true, logFileCount: 2,
    tools: [{
      name: 'ffprobe.exe', available: true, version: '8.0', sizeBytes: 123,
      sha256: 'a'.repeat(64),
    }],
  };
  assert.deepEqual(assertHostEvent(diagnostics), diagnostics);
  assert.deepEqual(assertHostEvent({
    type: 'diagnosticsExported', requestId: 'export-1',
    path: 'D:\\Suporte\\VideoRadar-Diagnostics-20260812.zip',
  }), {
    type: 'diagnosticsExported', requestId: 'export-1',
    path: 'D:\\Suporte\\VideoRadar-Diagnostics-20260812.zip',
  });
  assert.deepEqual(assertHostEvent({
    type: 'diagnosticsCleared', requestId: 'clear-1',
  }), {
    type: 'diagnosticsCleared', requestId: 'clear-1',
  });

  for (const event of [
    { ...diagnostics, architecture: 'x86' },
    { ...diagnostics, availableBytes: -1 },
    { ...diagnostics, logFileCount: 9 },
    { ...diagnostics, tools: [{ ...diagnostics.tools[0], sha256: 'secret' }] },
    { ...diagnostics, rawLog: 'https://private.example/video' },
  ]) assert.throws(() => assertHostEvent(event), /Mensagem inválida/);
});

test('preserva catálogo rico de vídeo, áudio, codec, HDR, tamanho e legendas', () => {
  const quality = {
    height: 2160, label: '2160p60 HDR', container: 'webm', combined: false,
    fps: 60, hdr: true, dynamicRange: 'HDR10', videoCodec: 'vp9.2', audioCodec: 'opus',
    bitrateKbps: 18000.5, estimatedSizeBytes: 2_000_000_000,
    estimatedSizeApproximate: true,
  };
  const format = {
    formatId: '251', height: null, container: 'WEBM', combined: false,
    audioOnly: true, fps: null, hdr: false, dynamicRange: null, videoCodec: null,
    audioCodec: 'opus', bitrateKbps: 160, fileSizeBytes: 4_000_000,
    fileSizeApproximate: false, language: 'pt-BR',
  };
  const subtitle = {
    language: 'pt-BR', label: 'Português', automatic: false, containers: ['VTT'],
  };
  const event = {
    type: 'formats', requestId: 'rich-1', platform: 'youtube', videoId,
    title: 'Me at the zoo', durationSeconds: 19, qualities: [quality],
    formats: [format], subtitles: [subtitle], audioLanguages: ['pt-BR'],
  };
  assert.deepEqual(assertFormatsResult(event), {
    platform: 'youtube', videoId, title: 'Me at the zoo', durationSeconds: 19,
    qualities: [quality],
    formats: [{ ...format, container: 'webm' }],
    subtitles: [subtitle],
    audioLanguages: ['pt-BR'],
  });

  for (const invalidEvent of [
    { ...event, qualities: [{ ...quality, fps: Infinity }] },
    { ...event, formats: [{ ...format, audioOnly: true, height: 720 }] },
    { ...event, subtitles: [{ ...subtitle, language: '../pt' }] },
    { ...event, audioLanguages: ['pt-BR', 'PT-br'] },
  ]) assert.throws(() => assertFormatsResult(invalidEvent), /Mensagem inválida/);
});
