import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDownloadFilename,
  isValidDownloadFilename,
  MAX_FILENAME_BYTES,
  sanitizeFilename,
} from '../src/shared/filename.js';

test('sanitizes unsafe filename characters and reserved names', () => {
  assert.equal(sanitizeFilename('  aula: 04 / revisão?  '), 'aula 04 revisão');
  assert.equal(sanitizeFilename('CON'), 'video-CON');
  assert.equal(sanitizeFilename('CON.foo.bar'), 'video-CON.foo.bar');
  assert.equal(sanitizeFilename('NUL.tar.gz'), 'video-NUL.tar.gz');
  assert.equal(sanitizeFilename('Cafe\u0301.mp4'), 'Café.mp4');
  assert.equal(sanitizeFilename('safe\u202Egnp.exe'), 'safegnp.exe');
});

test('builds filenames for direct and HLS media', () => {
  assert.equal(
    buildDownloadFilename({ url: 'https://cdn.test/aula.mp4?token=x', kind: 'direct' }),
    'aula.mp4',
  );
  assert.equal(
    buildDownloadFilename({ url: 'https://cdn.test/aula', kind: 'direct' }),
    'aula.mp4',
  );
  assert.equal(
    buildDownloadFilename({
      url: 'https://cdn.test/playback',
      kind: 'direct',
      type: 'video/webm; codecs=vp9',
    }),
    'playback.webm',
  );
  assert.equal(
    buildDownloadFilename({
      url: 'https://cdn.test/aula.bin',
      kind: 'direct',
      type: 'video/quicktime',
    }),
    'aula.mov',
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

test('bounds normalized filenames by UTF-8 bytes while preserving the extension', () => {
  const filename = buildDownloadFilename({
    url: 'https://cdn.test/%3C%3E.mp4',
    kind: 'direct',
    pageTitle: `Cafe\u0301 ${'🚀'.repeat(100)}`,
  });

  assert.ok(Buffer.byteLength(filename, 'utf8') <= MAX_FILENAME_BYTES);
  assert.ok(filename.endsWith('.mp4'));
  assert.ok(filename.startsWith('Café '));
  assert.equal(filename.includes('\uFFFD'), false);
  assert.equal(isValidDownloadFilename(filename), true);
  assert.equal(isValidDownloadFilename(`${'🚀'.repeat(100)}.mp4`), false);
  assert.equal(isValidDownloadFilename('../aula.mp4'), false);
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
