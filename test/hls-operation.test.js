import assert from 'node:assert/strict';
import test from 'node:test';
import { HlsError } from '../src/hls/parse-playlist.js';
import { assembleHls, inspectHls } from '../src/hls/hls-operation.js';

function response(body, { ok = true, status = 200 } = {}) {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  return {
    ok,
    status,
    async text() {
      return typeof body === 'string' ? body : new TextDecoder().decode(body);
    },
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

const mediaPlaylist = (...segments) => [
  '#EXTM3U',
  ...segments.flatMap((segment) => ['#EXTINF:4.0,', segment]),
  '#EXT-X-ENDLIST',
].join('\n');

const masterPlaylist = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480,CODECS="avc1.4d401e,mp4a.40.2"',
  '480/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=5200000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"',
  '1080/index.m3u8',
].join('\n');

function assertHlsError(code) {
  return (error) => error instanceof HlsError && error.code === code;
}

test('inspectHls returns sorted master variants without fetching segments', async () => {
  const calls = [];
  const result = await inspectHls('https://cdn.test/master.m3u8', {
    fetchImpl: async (...args) => {
      calls.push(args);
      return response(masterPlaylist);
    },
  });

  assert.equal(result.kind, 'master');
  assert.deepEqual(result.variants.map(({ label }) => label), ['1080p', '480p']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'https://cdn.test/master.m3u8');
});

test('inspectHls exposes one selectable quality for a media playlist', async () => {
  const url = 'https://cdn.test/media.m3u8';
  const result = await inspectHls(url, {
    fetchImpl: async () => response(mediaPlaylist('one.ts')),
  });

  assert.deepEqual(result, {
    kind: 'media',
    variants: [{
      url,
      width: 0,
      height: 0,
      bandwidth: 0,
      codecs: '',
      label: 'Qualidade única',
    }],
  });
});

test('assembleHls preserves playlist order when later segments resolve first', async () => {
  let releaseFirst;
  const firstReady = new Promise((resolve) => { releaseFirst = resolve; });
  const calls = [];
  const result = await assembleHls('https://cdn.test/media.m3u8', {
    allowedOrigins: ['https://cdn.test'],
    concurrency: 2,
    fetchImpl: async (url, options) => {
      calls.push([url, options]);
      if (url.endsWith('.m3u8')) return response(mediaPlaylist('one.ts', 'two.ts'));
      if (url.endsWith('one.ts')) {
        await firstReady;
        return response('ONE');
      }
      releaseFirst();
      return response('TWO');
    },
  });

  assert.equal(await result.blob.text(), 'ONETWO');
  assert.equal(result.blob.type, 'video/mp2t');
  assert.equal(result.size, 6);
  assert.equal(result.blob.size, 6);
  assert.equal(calls.length, 3);
  for (const [, options] of calls) assert.equal(options.credentials, 'include');
});

test('assembleHls rejects unauthorized segment origins before fetching a segment', async () => {
  const calls = [];
  await assert.rejects(
    assembleHls('https://cdn.test/media.m3u8', {
      allowedOrigins: ['https://cdn.test'],
      fetchImpl: async (url) => {
        calls.push(url);
        return response(mediaPlaylist('https://media.test/1.ts'));
      },
    }),
    (error) => {
      assert.equal(error.code, 'HLS_PERMISSION');
      assert.deepEqual(error.details.origins, ['https://media.test']);
      return true;
    },
  );
  assert.deepEqual(calls, ['https://cdn.test/media.m3u8']);
});

test('assembleHls rejects when accumulated bytes exceed maxBytes', async () => {
  await assert.rejects(
    assembleHls('https://cdn.test/media.m3u8', {
      allowedOrigins: ['https://cdn.test'],
      maxBytes: 5,
      fetchImpl: async (url) => (
        url.endsWith('.m3u8') ? response(mediaPlaylist('one.ts', 'two.ts')) : response('AAA')
      ),
    }),
    (error) => {
      assert.equal(error.code, 'HLS_TOO_LARGE');
      assert.equal(error.details.maxBytes, 5);
      return true;
    },
  );
});

test('assembleHls requires selecting a media variant from a master playlist', async () => {
  await assert.rejects(
    assembleHls('https://cdn.test/master.m3u8', {
      fetchImpl: async () => response(masterPlaylist),
    }),
    assertHlsError('HLS_VARIANT_REQUIRED'),
  );
});

test('non-ok HTTP responses become safe HLS_NETWORK errors', async () => {
  await assert.rejects(
    inspectHls('https://cdn.test/media.m3u8', {
      fetchImpl: async () => response('private upstream response', { ok: false, status: 503 }),
    }),
    (error) => {
      assert.equal(error.code, 'HLS_NETWORK');
      assert.equal(error.details.status, 503);
      assert.equal(error.details.url, 'https://cdn.test/media.m3u8');
      assert.doesNotMatch(error.message, /private upstream response/);
      return true;
    },
  );
});

test('thrown fetch failures become safe HLS_NETWORK errors without leaking raw errors', async () => {
  const secret = 'SECRET_INTERNAL_STACK_VALUE';
  const rawError = new Error(secret);
  rawError.stack = `${secret}\nprivate stack`;

  await assert.rejects(
    inspectHls('https://cdn.test/media.m3u8', {
      fetchImpl: async () => { throw rawError; },
    }),
    (error) => {
      assert.equal(error.code, 'HLS_NETWORK');
      assert.equal(error.details.url, 'https://cdn.test/media.m3u8');
      assert.doesNotMatch(error.message, new RegExp(secret));
      assert.equal('cause' in error, false);
      return true;
    },
  );
});

test('assembleHls passes credentials include to manifest and segment fetches', async () => {
  const optionsSeen = [];
  await assembleHls('https://cdn.test/media.m3u8', {
    allowedOrigins: ['https://cdn.test'],
    fetchImpl: async (url, options) => {
      optionsSeen.push(options);
      return url.endsWith('.m3u8') ? response(mediaPlaylist('one.ts')) : response('ONE');
    },
  });

  assert.equal(optionsSeen.length, 2);
  assert.ok(optionsSeen.every(({ credentials }) => credentials === 'include'));
});

test('assembleHls honors its concurrency limit', async () => {
  let active = 0;
  let peak = 0;
  const waiters = [];
  const segmentNames = ['1.ts', '2.ts', '3.ts', '4.ts', '5.ts'];
  const operation = assembleHls('https://cdn.test/media.m3u8', {
    allowedOrigins: ['https://cdn.test'],
    concurrency: 2,
    fetchImpl: async (url) => {
      if (url.endsWith('.m3u8')) return response(mediaPlaylist(...segmentNames));
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => waiters.push(resolve));
      active -= 1;
      return response('X');
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 2);
  while (waiters.length > 0 || active > 0) {
    waiters.splice(0).forEach((resolve) => resolve());
    await new Promise((resolve) => setImmediate(resolve));
  }
  const result = await operation;
  assert.equal(peak, 2);
  assert.equal(result.size, 5);
});

test('assembleHls rejects invalid concurrency and maxBytes values', async () => {
  const neverFetch = async () => { throw new Error('fetch should not run'); };
  for (const concurrency of [0, -1, 1.5, 5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      assembleHls('https://cdn.test/media.m3u8', { concurrency, fetchImpl: neverFetch }),
      assertHlsError('HLS_INVALID'),
    );
  }
  for (const maxBytes of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      assembleHls('https://cdn.test/media.m3u8', { maxBytes, fetchImpl: neverFetch }),
      assertHlsError('HLS_INVALID'),
    );
  }
});

test('assembleHls validates allowedOrigins before fetching', async () => {
  const neverFetch = async () => { throw new Error('fetch should not run'); };
  for (const allowedOrigins of [
    null,
    'https://cdn.test',
    ['https://cdn.test/path'],
    ['ftp://cdn.test'],
    ['not a URL'],
  ]) {
    await assert.rejects(
      assembleHls('https://cdn.test/media.m3u8', { allowedOrigins, fetchImpl: neverFetch }),
      assertHlsError('HLS_INVALID'),
    );
  }
});

test('assembleHls rejects malformed and non-HTTP playlist URLs before fetching', async () => {
  const neverFetch = async () => { throw new Error('fetch should not run'); };
  for (const url of ['relative.m3u8', 'ftp://cdn.test/media.m3u8', new URL('https://cdn.test/media.m3u8')]) {
    await assert.rejects(
      assembleHls(url, { fetchImpl: neverFetch }),
      assertHlsError('HLS_INVALID'),
    );
  }
});
