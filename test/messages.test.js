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
  assert.equal(assertOffscreenMessage({ ...download, target: 'offscreen' }).target, 'offscreen');
  assert.equal(
    assertOffscreenMessage({
      target: 'offscreen',
      action: ACTIONS.RELEASE_BLOB,
      payload: { blobUrl: 'blob:https://extension.test/abc' },
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
        payload: { blobUrl: 'https://extension.test/not-a-blob' },
      }),
    /Mensagem inválida/,
  );
});
