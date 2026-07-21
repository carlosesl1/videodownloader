import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { HlsError, parseHlsPlaylist } from '../src/hls/parse-playlist.js';

const fixture = (name) => readFile(new URL(`./fixtures/hls/${name}`, import.meta.url), 'utf8');

test('parses a master playlist into descending quality variants', async () => {
  const result = parseHlsPlaylist(await fixture('master.m3u8'), 'https://cdn.test/master/index.m3u8');

  assert.equal(result.kind, 'master');
  assert.deepEqual(result.variants.map((variant) => variant.label), ['1080p', '720p', '480p']);
  assert.deepEqual(result.variants[0], {
    url: 'https://cdn.test/1080p/index.m3u8',
    width: 1920,
    height: 1080,
    bandwidth: 5200000,
    codecs: 'avc1.640028,mp4a.40.2',
    label: '1080p',
  });
});

test('parses a finite media playlist into ordered resolved MPEG-TS segments', async () => {
  const result = parseHlsPlaylist(await fixture('1080p.m3u8'), 'https://cdn.test/720/index.m3u8');

  assert.deepEqual(result, {
    kind: 'media',
    segments: [
      { url: 'https://cdn.test/720/seg-1.ts', duration: 9.009 },
      { url: 'https://cdn.test/720/seg-2.ts', duration: 8.5 },
    ],
  });
});

test('accepts an explicitly unencrypted media playlist', () => {
  const result = parseHlsPlaylist([
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=NONE',
    '#EXTINF:4.0,',
    'segment.ts',
    '#EXT-X-ENDLIST',
  ].join('\n'), 'https://cdn.test/playlist.m3u8');

  assert.equal(result.kind, 'media');
  assert.equal(result.segments.length, 1);
});

for (const [name, playlist, expectedCode] of [
  ['encrypted AES-128', '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.key"\n#EXT-X-ENDLIST', 'HLS_ENCRYPTED'],
  ['fMP4 initialization map', '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-ENDLIST', 'HLS_FMP4'],
  ['byte range segments', '#EXTM3U\n#EXT-X-BYTERANGE:1000@0\n#EXT-X-ENDLIST', 'HLS_BYTERANGE'],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(
      () => parseHlsPlaylist(playlist, 'https://cdn.test/playlist.m3u8'),
      (error) => error instanceof HlsError && error.code === expectedCode,
    );
  });
}

test('rejects the fMP4 fixture', async () => {
  await assert.rejects(
    async () => parseHlsPlaylist(await fixture('rejected-fmp4.m3u8'), 'https://cdn.test/playlist.m3u8'),
    (error) => error instanceof HlsError && error.code === 'HLS_FMP4',
  );
});

for (const [name, playlist, expectedCode] of [
  ['a playlist without EXTM3U', '#EXTINF:4.0,\nsegment.ts\n#EXT-X-ENDLIST', 'HLS_INVALID'],
  ['a live media playlist without ENDLIST', '#EXTM3U\n#EXTINF:4.0,\nsegment.ts', 'HLS_LIVE'],
  ['an empty finite media playlist', '#EXTM3U\n#EXT-X-ENDLIST', 'HLS_EMPTY'],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(
      () => parseHlsPlaylist(playlist, 'https://cdn.test/playlist.m3u8'),
      (error) => error instanceof HlsError && error.code === expectedCode,
    );
  });
}
