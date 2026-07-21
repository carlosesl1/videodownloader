import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildOriginGrant,
  canonicalMediaUrl,
  findMatchingOperation,
  permissionOriginsFromError,
  unwrapDirectResponse,
  unwrapInspectResponse,
  unwrapQueuedResponse,
} from '../src/popup/main.js';

test('builds exact safe Chrome origin patterns with ports', () => {
  assert.deepEqual(
    buildOriginGrant([
      'https://cdn.test:8443/master.m3u8?token=x',
      'https://cdn.test:8443/segment.ts',
      'http://media.test/video.ts',
    ]),
    {
      origins: ['https://cdn.test:8443', 'http://media.test'],
      patterns: ['https://cdn.test:8443/*', 'http://media.test/*'],
    },
  );
  assert.throws(() => buildOriginGrant(['data:text/plain,no']), /URL de mídia inválida/);
});

test('canonicalizes media URLs without discarding query tokens', () => {
  assert.equal(
    canonicalMediaUrl('https://cdn.test/video.m3u8?token=abc#fragment'),
    'https://cdn.test/video.m3u8?token=abc',
  );
});

test('validates direct, inspection and queued background envelopes', () => {
  assert.deepEqual(unwrapDirectResponse({ ok: true, value: { downloadId: 7 } }), { downloadId: 7 });
  assert.deepEqual(
    unwrapInspectResponse({
      ok: true,
      value: {
        kind: 'master',
        variants: [{
          url: 'https://cdn.test/720.m3u8',
          label: '720p',
          width: 1280,
          height: 720,
          bandwidth: 2500000,
          codecs: 'avc1',
        }],
      },
    }).variants[0].label,
    '720p',
  );
  assert.deepEqual(
    unwrapQueuedResponse({ ok: true, value: { operationId: 'op:1', state: 'assembling' } }),
    { operationId: 'op:1', state: 'assembling' },
  );
  assert.throws(() => unwrapDirectResponse({ ok: true, value: { downloadId: '7' } }), /resposta inválida/i);
  assert.throws(() => unwrapQueuedResponse({ ok: true, value: { operationId: '<script>', state: 'assembling' } }), /resposta inválida/i);
});

test('preserves a safe background error and extracts HLS permission origins', () => {
  const envelope = {
    ok: false,
    error: {
      code: 'HLS_PERMISSION',
      message: 'Autorização necessária',
      details: { origins: ['https://segments.test', 'file:///tmp/no'] },
    },
  };
  assert.throws(
    () => unwrapQueuedResponse(envelope),
    (error) => error.code === 'HLS_PERMISSION' && error.details.origins.length === 2,
  );
  assert.deepEqual(permissionOriginsFromError(envelope.error), ['https://segments.test']);
});

test('matches the newest persisted operation by canonical variant URL', () => {
  const item = {
    kind: 'hls',
    variants: [{ url: 'https://cdn.test/720.m3u8?token=x#old' }],
  };
  const found = findMatchingOperation(item, [
    { operationId: 'old', url: 'https://cdn.test/720.m3u8?token=x', state: 'complete', updatedAt: 1 },
    { operationId: 'new', url: 'https://cdn.test/720.m3u8?token=x', state: 'assembling', updatedAt: 2 },
  ]);
  assert.equal(found.operationId, 'new');
});
