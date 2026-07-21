import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDownloadFilename, sanitizeFilename } from '../src/shared/filename.js';

test('sanitizes unsafe filename characters and reserved names', () => {
  assert.equal(sanitizeFilename('  aula: 04 / revisão?  '), 'aula 04 revisão');
  assert.equal(sanitizeFilename('CON'), 'video-CON');
  assert.equal(sanitizeFilename('CON.foo.bar'), 'video-CON.foo.bar');
  assert.equal(sanitizeFilename('NUL.tar.gz'), 'video-NUL.tar.gz');
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

test('falls back when a URL leaf sanitizes to nothing', () => {
  assert.equal(
    buildDownloadFilename({
      url: 'https://cdn.test/%3C%3E.mp4',
      kind: 'direct',
      pageTitle: 'Minha aula',
    }),
    'Minha aula.mp4',
  );
  assert.match(
    buildDownloadFilename({
      url: 'https://cdn.test/%3C%3E.mp4',
      kind: 'direct',
      pageTitle: '   ',
    }),
    /^video-\d{4}-\d{2}-\d{2}-\d{6}\.mp4$/,
  );
  assert.equal(
    buildDownloadFilename({
      url: 'https://cdn.test/.mp4',
      kind: 'direct',
      pageTitle: 'Minha aula',
    }),
    'Minha aula.mp4',
  );
});
