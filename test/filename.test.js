import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDownloadFilename, sanitizeFilename } from '../src/shared/filename.js';

test('sanitizes unsafe filename characters and reserved names', () => {
  assert.equal(sanitizeFilename('  aula: 04 / revisão?  '), 'aula 04 revisão');
  assert.equal(sanitizeFilename('CON'), 'video-CON');
});

test('builds filenames for direct and HLS media', () => {
  assert.equal(
    buildDownloadFilename({ url: 'https://cdn.test/aula.mp4?token=x', kind: 'direct' }),
    'aula.mp4',
  );
  assert.equal(
    buildDownloadFilename({
      url: 'https://cdn.test/master.m3u8',
      kind: 'hls',
      pageTitle: 'Minha aula',
    }),
    'master.ts',
  );
});
