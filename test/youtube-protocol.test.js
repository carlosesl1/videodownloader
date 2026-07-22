import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HOST_COMMANDS,
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

test('valida os formatos reais de eventos do host e normaliza download', () => {
  const progressEvent = {
    type: 'jobProgress', requestId: 'r1', jobId: 'j1', stage: 'video', percent: 50,
    downloadedBytes: 50, totalBytes: 100, speedBytesPerSecond: 25, etaSeconds: 2,
  };
  assert.deepEqual(assertHostEvent(progressEvent), progressEvent);
  assert.deepEqual(assertHostEvent({ ...progressEvent, stage: 'download' }), {
    ...progressEvent, stage: 'video',
  });
  assert.deepEqual(assertHostEvent({ type: 'ready', requestId: 'r1', protocolVersion: '1', nativeName: 'host' }), {
    type: 'ready', requestId: 'r1', protocolVersion: '1', nativeName: 'host',
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
