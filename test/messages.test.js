import assert from 'node:assert/strict';
import test from 'node:test';
import { ACTIONS, assertBackgroundMessage, assertOffscreenMessage } from '../src/shared/messages.js';

test('accepts a complete direct-download background message', () => {
  const message = {
    target: 'background',
    action: ACTIONS.DOWNLOAD_DIRECT,
    payload: { url: 'https://cdn.test/aula.mp4', filename: 'aula.mp4' },
  };

  assert.equal(assertBackgroundMessage(message), message);
});

test('rejects malformed actions and non-http media URLs', () => {
  assert.throws(
    () => assertBackgroundMessage({ target: 'background', action: 'ERASE_ALL', payload: {} }),
    /Mensagem inválida/,
  );
  assert.throws(
    () =>
      assertBackgroundMessage({
        target: 'background',
        action: ACTIONS.DOWNLOAD_DIRECT,
        payload: { url: 'file:///secret', filename: 'secret.mp4' },
      }),
    /URL inválida/,
  );
});

test('accepts complete HLS background and offscreen messages', () => {
  const inspect = {
    target: 'background',
    action: ACTIONS.INSPECT_HLS,
    payload: { url: 'https://cdn.test/master.m3u8', permissionPatterns: ['https://cdn.test/*'] },
  };
  const download = {
    target: 'background',
    action: ACTIONS.DOWNLOAD_HLS,
    payload: {
      url: 'https://cdn.test/master.m3u8',
      filename: 'aula.ts',
      allowedOrigins: ['https://cdn.test'],
      permissionPatterns: ['https://cdn.test/*'],
    },
  };

  assert.equal(assertBackgroundMessage(inspect), inspect);
  assert.equal(assertBackgroundMessage(download), download);
  assert.equal(assertOffscreenMessage({ ...inspect, target: 'offscreen' }).target, 'offscreen');
  assert.throws(() => assertOffscreenMessage({ ...download, target: 'offscreen' }), /Mensagem inválida/);
  assert.equal(
    assertOffscreenMessage({
      target: 'offscreen',
      action: ACTIONS.RELEASE_BLOB,
      payload: { operationId: 'operation-1', blobUrl: 'blob:https://extension.test/abc' },
    }).action,
    ACTIONS.RELEASE_BLOB,
  );
});

test('rejects malformed HLS arrays, coerced URLs, and blob releases', () => {
  assert.throws(
    () =>
      assertBackgroundMessage({
        target: 'background',
        action: ACTIONS.INSPECT_HLS,
        payload: { url: ['https://cdn.test/master.m3u8'], permissionPatterns: ['https://cdn.test/*'] },
      }),
    /URL inválida/,
  );
  assert.throws(
    () =>
      assertBackgroundMessage({
        target: 'background',
        action: ACTIONS.INSPECT_HLS,
        payload: { url: 'https://cdn.test/master.m3u8', permissionPatterns: [''] },
      }),
    /Mensagem inválida/,
  );
  assert.throws(
    () =>
      assertBackgroundMessage({
        target: 'background',
        action: ACTIONS.DOWNLOAD_HLS,
        payload: {
          url: 'https://cdn.test/master.m3u8',
          filename: 'aula.ts',
          allowedOrigins: ['https://cdn.test', null],
          permissionPatterns: ['https://cdn.test/*'],
        },
      }),
    /Mensagem inválida/,
  );
  assert.throws(
    () =>
      assertOffscreenMessage({
        target: 'offscreen',
        action: ACTIONS.RELEASE_BLOB,
        payload: { operationId: 'operation-1', blobUrl: 'https://extension.test/not-a-blob' },
      }),
    /Mensagem inválida/,
  );
});

test('accepts internal acknowledged HLS operation messages', () => {
  const start = {
    target: 'offscreen',
    action: ACTIONS.START_HLS,
    payload: {
      operationId: 'operation-1',
      url: 'https://cdn.test/video.m3u8?token=abc',
      allowedOrigins: ['https://cdn.test'],
    },
  };
  const completed = {
    target: 'background',
    action: ACTIONS.HLS_COMPLETED,
    payload: {
      operationId: 'operation-1',
      result: { blobUrl: 'blob:extension.test/operation-1', size: 12 },
    },
  };
  const failed = {
    ...completed,
    payload: {
      operationId: 'operation-2',
      error: { code: 'HLS_NETWORK', message: 'Falha HLS segura', details: { status: 503 } },
    },
  };

  assert.equal(assertOffscreenMessage(start), start);
  assert.equal(assertBackgroundMessage(completed), completed);
  assert.equal(assertBackgroundMessage(failed), failed);
  const released = {
    target: 'background',
    action: ACTIONS.HLS_RELEASED,
    payload: { operationId: 'operation-1', blobUrl: 'blob:extension.test/operation-1' },
  };
  assert.equal(assertBackgroundMessage(released), released);
  const armInspectionCleanup = {
    target: 'offscreen',
    action: ACTIONS.ARM_INSPECTION_CLEANUP,
    payload: { leaseId: 'inspection-1' },
  };
  const inspectionCleanup = {
    target: 'background',
    action: ACTIONS.INSPECTION_CLEANUP,
    payload: { leaseId: 'inspection-1' },
  };
  assert.equal(assertOffscreenMessage(armInspectionCleanup), armInspectionCleanup);
  assert.equal(assertBackgroundMessage(inspectionCleanup), inspectionCleanup);
});

test('rejects malformed or metadata-bearing HLS completions', () => {
  const valid = {
    target: 'background',
    action: ACTIONS.HLS_COMPLETED,
    payload: {
      operationId: 'operation-1',
      result: { blobUrl: 'blob:extension.test/operation-1', size: 12 },
    },
  };

  for (const payload of [
    { operationId: '', result: valid.payload.result },
    { operationId: 'operation-1', result: { ...valid.payload.result, filename: 'untrusted.ts' } },
    { operationId: 'operation-1', result: { blobUrl: 'https://cdn.test/video.ts', size: 12 } },
    { operationId: 'operation-1', result: valid.payload.result, error: { code: 'HLS_BAD', message: 'x', details: {} } },
    { operationId: 'operation-1', error: { code: 'bad-code', message: 'x', details: {} } },
    { operationId: 'operation-1', error: { code: 'HLS_BAD', message: 'x', details: { value: 1n } } },
  ]) {
    assert.throws(() => assertBackgroundMessage({ ...valid, payload }), /Mensagem inválida/);
  }
});

test('accepts bounded HLS progress messages and rejects invalid counters', () => {
  const progress = {
    target: 'background',
    action: ACTIONS.HLS_PROGRESS,
    payload: {
      operationId: 'operation-1',
      completedSegments: 12,
      totalSegments: 30,
      bytesReceived: 4096,
    },
  };

  assert.equal(assertBackgroundMessage(progress), progress);
  for (const payload of [
    { ...progress.payload, completedSegments: 31 },
    { ...progress.payload, totalSegments: 0 },
    { ...progress.payload, bytesReceived: -1 },
    { ...progress.payload, percent: 40 },
  ]) {
    assert.throws(() => assertBackgroundMessage({ ...progress, payload }), /Mensagem inv.lida/);
  }
});

test('rejects metadata-bearing inspection cleanup messages', () => {
  assert.throws(() => assertOffscreenMessage({
    target: 'offscreen',
    action: ACTIONS.ARM_INSPECTION_CLEANUP,
    payload: { leaseId: 'inspection-1', permissionPatterns: ['https://untrusted.test/*'] },
  }), /Mensagem inválida/);
  assert.throws(() => assertBackgroundMessage({
    target: 'background',
    action: ACTIONS.INSPECTION_CLEANUP,
    payload: { leaseId: '', permissionPatterns: [] },
  }), /Mensagem inválida/);
});
