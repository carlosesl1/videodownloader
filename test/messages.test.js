import assert from 'node:assert/strict';
import test from 'node:test';
import { ACTIONS, assertBackgroundMessage } from '../src/shared/messages.js';

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
