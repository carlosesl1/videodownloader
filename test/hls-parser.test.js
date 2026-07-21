import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { HlsError, parseHlsPlaylist } from '../src/hls/parse-playlist.js';

const fixture = (name) => readFile(new URL(`./fixtures/hls/${name}`, import.meta.url), 'utf8');

test('parses a master playlist into descending quality variants', async () => {
  const result = parseHlsPlaylist(await fixture('master.m3u8'), 'https://cdn.test/master/index.m3u8');

  assert.equal(result.kind, 'master');
  assert.deepEqual(result.variants.map((variant) => variant.label), ['1080p', '720p', '480p']);
  assert.deepEqual(result.variants, [
    {
      url: 'https://cdn.test/1080p/index.m3u8', width: 1920, height: 1080,
      bandwidth: 5200000, codecs: 'avc1.640028,mp4a.40.2', label: '1080p',
    },
    {
      url: 'https://cdn.test/720p/index.m3u8', width: 1280, height: 720,
      bandwidth: 1800000, codecs: 'avc1.4d401f,mp4a.40.2', label: '720p',
    },
    {
      url: 'https://cdn.test/480p/index.m3u8', width: 854, height: 480,
      bandwidth: 800000, codecs: 'avc1.4d401e,mp4a.40.2', label: '480p',
    },
  ]);
});

test('preserves the public HlsError message and details contract', () => {
  const error = new HlsError('HLS_INVALID', 'Invalid HLS playlist', { reason: 'missing header' });

  assert.equal(error.name, 'HlsError');
  assert.equal(error.message, 'Invalid HLS playlist');
  assert.equal(error.code, 'HLS_INVALID');
  assert.deepEqual(error.details, { reason: 'missing header' });
  assert.deepEqual(new HlsError('HLS_LIVE', 'Live playlist').details, {});
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

test('rejects METHOD=NONE when key material attributes are present', () => {
  for (const attribute of ['URI="key.bin"', 'IV=0x1234', 'KEYFORMAT="identity"']) {
    assert.throws(
      () => parseHlsPlaylist(
        `#EXTM3U\n#EXT-X-KEY:METHOD=NONE,${attribute}\n#EXT-X-ENDLIST`,
        'https://cdn.test/playlist.m3u8',
      ),
      (error) => error instanceof HlsError && error.code === 'HLS_INVALID',
    );
  }
});

test('accepts a positive bandwidth with leading zeros', () => {
  const result = parseHlsPlaylist([
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=0001800,RESOLUTION=1280x720',
    'variant.m3u8',
  ].join('\n'), 'https://cdn.test/master.m3u8');

  assert.equal(result.variants[0].bandwidth, 1800);
});

test('accepts positive resolution components with leading zeros', () => {
  const result = parseHlsPlaylist([
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=1800,RESOLUTION=001280x00720',
    'variant.m3u8',
  ].join('\n'), 'https://cdn.test/master.m3u8');

  assert.deepEqual(result.variants[0], {
    url: 'https://cdn.test/variant.m3u8', width: 1280, height: 720,
    bandwidth: 1800, codecs: null, label: '720p',
  });
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

test('rejects lower-case METHOD=none as unsupported encryption', () => {
  assert.throws(
    () => parseHlsPlaylist(
      '#EXTM3U\n#EXT-X-KEY:METHOD=none\n#EXT-X-ENDLIST',
      'https://cdn.test/playlist.m3u8',
    ),
    (error) => error instanceof HlsError && error.code === 'HLS_ENCRYPTED',
  );
});

test('rejects the fMP4 fixture', async () => {
  await assert.rejects(
    async () => parseHlsPlaylist(await fixture('rejected-fmp4.m3u8'), 'https://cdn.test/playlist.m3u8'),
    (error) => error instanceof HlsError && error.code === 'HLS_FMP4',
  );
});

test('rejects duplicate attributes before encryption can be hidden', () => {
  assert.throws(
    () => parseHlsPlaylist(
      '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,METHOD=NONE\n#EXT-X-ENDLIST',
      'https://cdn.test/playlist.m3u8',
    ),
    (error) => error instanceof HlsError && error.code === 'HLS_INVALID',
  );
});

test('requires METHOD=NONE to be the only key attribute', () => {
  assert.throws(
    () => parseHlsPlaylist(
      '#EXTM3U\n#EXT-X-KEY:METHOD=NONE,KEYFORMATVERSIONS="1"\n#EXT-X-ENDLIST',
      'https://cdn.test/playlist.m3u8',
    ),
    (error) => error instanceof HlsError && error.code === 'HLS_INVALID',
  );
});

for (const attributes of [
  'bandwidth=1000,RESOLUTION=640x360',
  'BANDWIDTH=1000, RESOLUTION=640x360',
]) {
  test(`rejects non-canonical HLS attributes: ${attributes}`, () => {
    assert.throws(
      () => parseHlsPlaylist(
        `#EXTM3U\n#EXT-X-STREAM-INF:${attributes}\nvariant.m3u8`,
        'https://cdn.test/playlist.m3u8',
      ),
      (error) => error instanceof HlsError && error.code === 'HLS_INVALID',
    );
  });
}

test('rejects mixed master and media playlists', () => {
  assert.throws(
    () => parseHlsPlaylist([
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=640x360',
      'variant.m3u8',
      '#EXTINF:4.0,',
      'segment.ts',
      '#EXT-X-ENDLIST',
    ].join('\n'), 'https://cdn.test/playlist.m3u8'),
    (error) => error instanceof HlsError && error.code === 'HLS_INVALID',
  );
});

for (const mediaOnlyTag of ['#EXT-X-ENDLIST', '#EXT-X-TARGETDURATION:6']) {
  test(`rejects a master playlist containing ${mediaOnlyTag}`, () => {
    assert.throws(
      () => parseHlsPlaylist([
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=640x360',
        'variant.m3u8',
        mediaOnlyTag,
      ].join('\n'), 'https://cdn.test/playlist.m3u8'),
      (error) => error instanceof HlsError && error.code === 'HLS_INVALID',
    );
  });
}

test('rejects an unpaired URI after a valid media segment', () => {
  assert.throws(
    () => parseHlsPlaylist([
      '#EXTM3U',
      '#EXTINF:4.0,',
      'segment.ts',
      'unexpected.ts',
      '#EXT-X-ENDLIST',
    ].join('\n'), 'https://cdn.test/playlist.m3u8'),
    (error) => error instanceof HlsError && error.code === 'HLS_INVALID',
  );
});

for (const masterOnlyTag of [
  '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1000,URI="iframe.m3u8"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",URI="audio.m3u8"',
]) {
  test(`rejects a media playlist containing ${masterOnlyTag.split(':', 1)[0]}`, () => {
    assert.throws(
      () => parseHlsPlaylist([
        '#EXTM3U',
        masterOnlyTag,
        '#EXTINF:4.0,',
        'segment.ts',
        '#EXT-X-ENDLIST',
      ].join('\n'), 'https://cdn.test/playlist.m3u8'),
      (error) => error instanceof HlsError && error.code === 'HLS_INVALID',
    );
  });
}

test('allows media tags between EXTINF and its segment URI', () => {
  const result = parseHlsPlaylist([
    '#EXTM3U',
    '#EXTINF:4.0,',
    '#EXT-X-PROGRAM-DATE-TIME:2026-07-21T12:00:00Z',
    'dated-segment.ts',
    '#EXT-X-ENDLIST',
  ].join('\n'), 'https://cdn.test/playlist.m3u8');

  assert.deepEqual(result.segments, [{
    url: 'https://cdn.test/dated-segment.ts', duration: 4,
  }]);
});

test('allows discontinuity and unencrypted key tags between EXTINF and its URI', () => {
  const result = parseHlsPlaylist([
    '#EXTM3U',
    '#EXTINF:4.0,',
    '#EXT-X-DISCONTINUITY',
    '#EXT-X-KEY:METHOD=NONE',
    'segment.ts',
    '#EXT-X-ENDLIST',
  ].join('\n'), 'https://cdn.test/playlist.m3u8');

  assert.equal(result.segments[0].url, 'https://cdn.test/segment.ts');
});

test('allows ENDLIST between EXTINF and its segment URI', () => {
  const result = parseHlsPlaylist([
    '#EXTM3U',
    '#EXTINF:4.0,',
    '#EXT-X-ENDLIST',
    'segment.ts',
  ].join('\n'), 'https://cdn.test/playlist.m3u8');

  assert.equal(result.kind, 'media');
  assert.equal(result.segments.length, 1);
});

for (const interveningTag of [
  '#EXTINF:5.0,',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",URI="audio.m3u8"',
]) {
  test(`rejects ${interveningTag.split(':', 1)[0]} between EXTINF and its URI`, () => {
    assert.throws(
      () => parseHlsPlaylist([
      '#EXTM3U',
      '#EXTINF:4.0,',
      interveningTag,
      'segment.ts',
      '#EXT-X-ENDLIST',
    ].join('\n'), 'https://cdn.test/playlist.m3u8'),
      (error) => error instanceof HlsError && error.code === 'HLS_INVALID',
    );
  });
}

for (const [name, playlist] of [
  ['exponent bandwidth', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1e3,RESOLUTION=640x360\nvariant.m3u8'],
  ['zero bandwidth', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=0,RESOLUTION=640x360\nvariant.m3u8'],
  ['non-positive resolution', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=640x0\nvariant.m3u8'],
  ['exponent EXTINF', '#EXTM3U\n#EXTINF:1e3,\nsegment.ts\n#EXT-X-ENDLIST'],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(
      () => parseHlsPlaylist(playlist, 'https://cdn.test/playlist.m3u8'),
      (error) => error instanceof HlsError && error.code === 'HLS_INVALID',
    );
  });
}

for (const segment of ['audio.aac', 'chunk.m4s', 'video.mp4']) {
  test(`rejects non-MPEG-TS segment ${segment}`, () => {
    assert.throws(
      () => parseHlsPlaylist(
        `#EXTM3U\n#EXTINF:4.0,\n${segment}?token=1\n#EXT-X-ENDLIST`,
        'https://cdn.test/playlist.m3u8',
      ),
      (error) => error instanceof HlsError && error.code === 'HLS_INVALID',
    );
  });
}

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
