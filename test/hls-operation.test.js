import assert from 'node:assert/strict';
import test from 'node:test';
import { HlsError } from '../src/hls/parse-playlist.js';
import { assembleHls, inspectHls } from '../src/hls/hls-operation.js';

function response(body, { ok = true, status = 200, contentLength } = {}) {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  return {
    ok,
    status,
    headers: {
      get(name) {
        return name.toLowerCase() === 'content-length' && contentLength !== undefined
          ? String(contentLength)
          : null;
      },
    },
    async text() {
      return typeof body === 'string' ? body : new TextDecoder().decode(body);
    },
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

function streamingResponse(chunks, { onCancel = () => {}, arrayBuffer = () => {
  throw new Error('arrayBuffer must not be called for streaming responses');
} } = {}) {
  let index = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) return { done: true, value: undefined };
            const value = chunks[index];
            index += 1;
            return { done: false, value };
          },
          async cancel() {
            onCancel();
          },
        };
      },
    },
    arrayBuffer,
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

test('assembleHls composes the final Blob from per-segment Blob parts', async () => {
  const constructions = [];
  const OriginalBlob = globalThis.Blob;
  globalThis.Blob = class TrackingBlob extends OriginalBlob {
    constructor(parts, options) {
      constructions.push([...parts]);
      super(parts, options);
    }
  };

  try {
    const result = await assembleHls('https://cdn.test/media.m3u8', {
      allowedOrigins: ['https://cdn.test'],
      concurrency: 2,
      fetchImpl: async (url) => (
        url.endsWith('.m3u8')
          ? response(mediaPlaylist('one.ts', 'two.ts'))
          : response(url.endsWith('one.ts') ? 'ONE' : 'TWO')
      ),
    });

    assert.equal(await result.blob.text(), 'ONETWO');
  } finally {
    globalThis.Blob = OriginalBlob;
  }

  assert.equal(constructions.length, 3);
  assert.ok(constructions[2].every((part) => part instanceof OriginalBlob));
  assert.ok(constructions[2].every((part) => !Array.isArray(part)));
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

test('assembleHls reports monotonic segment and byte progress', async () => {
  const progress = [];
  const result = await assembleHls('https://cdn.test/media.m3u8', {
    allowedOrigins: ['https://cdn.test'],
    concurrency: 1,
    onProgress: (value) => progress.push(structuredClone(value)),
    fetchImpl: async (url) => (
      url.endsWith('.m3u8')
        ? response(mediaPlaylist('one.ts', 'two.ts'))
        : response(url.endsWith('one.ts') ? 'ONE' : 'TWOO')
    ),
  });

  assert.equal(result.size, 7);
  assert.deepEqual(progress, [
    { completedSegments: 0, totalSegments: 2, bytesReceived: 0, estimatedTotalBytes: null },
    { completedSegments: 1, totalSegments: 2, bytesReceived: 3, estimatedTotalBytes: 6 },
    { completedSegments: 2, totalSegments: 2, bytesReceived: 7, estimatedTotalBytes: 7 },
  ]);
});

test('assembleHls aborts a stalled request with a safe timeout error', async () => {
  let segmentSignal;
  let abortEvents = 0;
  await assert.rejects(
    assembleHls('https://cdn.test/media.m3u8', {
      allowedOrigins: ['https://cdn.test'],
      requestTimeoutMs: 10,
      fetchImpl: async (url, options) => {
        if (url.endsWith('.m3u8')) return response(mediaPlaylist('stalled.ts'));
        segmentSignal = options.signal;
        segmentSignal.addEventListener('abort', () => { abortEvents += 1; }, { once: true });
        return new Promise(() => {});
      },
    }),
    (error) => {
      assert.equal(error.code, 'HLS_TIMEOUT');
      assert.equal(error.details.timeoutMs, 10);
      return true;
    },
  );
  assert.equal(segmentSignal.aborted, true);
  assert.equal(abortEvents, 1);
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

test('inspectHls rejects an oversized declared manifest before reading its body', async () => {
  let textCalls = 0;
  await assert.rejects(
    inspectHls('https://cdn.test/media.m3u8', {
      fetchImpl: async () => ({
        ...response('', { contentLength: (2 * 1024 * 1024) + 1 }),
        async text() {
          textCalls += 1;
          return mediaPlaylist('one.ts');
        },
      }),
    }),
    (error) => error.code === 'HLS_MANIFEST_TOO_LARGE'
      && error.details.maxManifestBytes === 2 * 1024 * 1024,
  );
  assert.equal(textCalls, 0);
});

test('inspectHls stops an oversized streaming manifest without Content-Length', async () => {
  let cancelCalls = 0;
  let delivered = false;
  await assert.rejects(
    inspectHls('https://cdn.test/media.m3u8', {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        body: {
          getReader() {
            return {
              async read() {
                if (delivered) return { done: true, value: undefined };
                delivered = true;
                return { done: false, value: new Uint8Array((2 * 1024 * 1024) + 1) };
              },
              async cancel() {
                cancelCalls += 1;
              },
            };
          },
        },
      }),
    }),
    assertHlsError('HLS_MANIFEST_TOO_LARGE'),
  );
  assert.equal(cancelCalls, 1);
});

test('assembleHls rejects an oversized declared segment before reading its body', async () => {
  let arrayBufferCalls = 0;
  await assert.rejects(
    assembleHls('https://cdn.test/media.m3u8', {
      allowedOrigins: ['https://cdn.test'],
      maxBytes: 5,
      fetchImpl: async (url) => {
        if (url.endsWith('.m3u8')) return response(mediaPlaylist('one.ts'));
        return {
          ...response('', { contentLength: 6 }),
          async arrayBuffer() {
            arrayBufferCalls += 1;
            return new Uint8Array(6).buffer;
          },
        };
      },
    }),
    assertHlsError('HLS_TOO_LARGE'),
  );
  assert.equal(arrayBufferCalls, 0);
});

test('assembleHls uses a 256 MiB default size ceiling', async () => {
  await assert.rejects(
    assembleHls('https://cdn.test/media.m3u8', {
      allowedOrigins: ['https://cdn.test'],
      fetchImpl: async (url) => (
        url.endsWith('.m3u8')
          ? response(mediaPlaylist('one.ts'))
          : response('', { contentLength: (256 * 1024 * 1024) + 1 })
      ),
    }),
    (error) => error.code === 'HLS_TOO_LARGE'
      && error.details.maxBytes === 256 * 1024 * 1024,
  );
});

test('assembleHls accounts streaming chunks before retention and cancels on size breach', async () => {
  let arrayBufferCalls = 0;
  let cancelCalls = 0;
  let blobConstructions = 0;
  const OriginalBlob = globalThis.Blob;
  globalThis.Blob = class TrackingBlob extends OriginalBlob {
    constructor(...args) {
      blobConstructions += 1;
      super(...args);
    }
  };

  try {
    await assert.rejects(
      assembleHls('https://cdn.test/media.m3u8', {
        allowedOrigins: ['https://cdn.test'],
        maxBytes: 5,
        fetchImpl: async (url) => {
          if (url.endsWith('.m3u8')) return response(mediaPlaylist('one.ts'));
          return streamingResponse(
            [new TextEncoder().encode('AAA'), new TextEncoder().encode('BBB')],
            {
              onCancel: () => { cancelCalls += 1; },
              arrayBuffer: async () => {
                arrayBufferCalls += 1;
                return new TextEncoder().encode('AAABBB').buffer;
              },
            },
          );
        },
      }),
      assertHlsError('HLS_TOO_LARGE'),
    );
  } finally {
    globalThis.Blob = OriginalBlob;
  }

  assert.equal(arrayBufferCalls, 0);
  assert.equal(cancelCalls, 1);
  assert.equal(blobConstructions, 0);
});

test('assembleHls cancels a stalled stream reader when its request times out', async () => {
  let cancelCalls = 0;
  await assert.rejects(
    assembleHls('https://cdn.test/media.m3u8', {
      allowedOrigins: ['https://cdn.test'],
      requestTimeoutMs: 10,
      fetchImpl: async (url) => {
        if (url.endsWith('.m3u8')) return response(mediaPlaylist('one.ts'));
        return {
          ok: true,
          status: 200,
          body: {
            getReader() {
              return {
                read() {
                  return new Promise(() => {});
                },
                async cancel() {
                  cancelCalls += 1;
                },
              };
            },
          },
        };
      },
    }),
    assertHlsError('HLS_TIMEOUT'),
  );
  assert.equal(cancelCalls, 1);
});

test('assembleHls rejects an external abort during a delayed read that ignores its signal', async () => {
  const externalController = new AbortController();
  let announceRead;
  const readStarted = new Promise((resolve) => { announceRead = resolve; });
  let releaseRead;
  const delayedBytes = new Promise((resolve) => { releaseRead = resolve; });
  let streamRead = false;
  let blobConstructions = 0;
  const OriginalBlob = globalThis.Blob;
  globalThis.Blob = class TrackingBlob extends OriginalBlob {
    constructor(...args) {
      blobConstructions += 1;
      super(...args);
    }
  };

  const operation = assembleHls('https://cdn.test/media.m3u8', {
    allowedOrigins: ['https://cdn.test'],
    signal: externalController.signal,
    fetchImpl: async (url) => {
      if (url.endsWith('.m3u8')) return response(mediaPlaylist('one.ts'));
      return {
        ok: true,
        status: 200,
        body: {
          getReader() {
            return {
              async read() {
                if (streamRead) return { done: true, value: undefined };
                streamRead = true;
                announceRead();
                return { done: false, value: await delayedBytes };
              },
              async cancel() {},
            };
          },
        },
        async arrayBuffer() {
          announceRead();
          return (await delayedBytes).buffer;
        },
      };
    },
  });

  await readStarted;
  externalController.abort();
  releaseRead(new TextEncoder().encode('ONE'));

  let caught;
  try {
    await operation;
  } catch (error) {
    caught = error;
  } finally {
    globalThis.Blob = OriginalBlob;
  }

  assert.equal(caught?.code, 'HLS_NETWORK');
  assert.doesNotMatch(caught?.message || '', /AbortError|stack|signal/i);
  assert.equal(blobConstructions, 0);
});

test('assembleHls preserves HLS_TOO_LARGE when aborting a peer worker', async () => {
  let announcePeer;
  const peerStarted = new Promise((resolve) => { announcePeer = resolve; });
  let releaseLarge;
  const largeReady = new Promise((resolve) => { releaseLarge = resolve; });
  const largeBytes = new TextEncoder().encode('TOO-LARGE');

  const operation = assembleHls('https://cdn.test/media.m3u8', {
    allowedOrigins: ['https://cdn.test'],
    concurrency: 2,
    maxBytes: 5,
    fetchImpl: async (url, { signal }) => {
      if (url.endsWith('.m3u8')) return response(mediaPlaylist('peer.ts', 'large.ts'));
      if (url.endsWith('large.ts')) {
        return streamingResponse([await largeReady], {
          arrayBuffer: async () => (await largeReady).buffer,
        });
      }
      announcePeer();
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('peer aborted')), { once: true });
      });
    },
  });

  await peerStarted;
  releaseLarge(largeBytes);
  await assert.rejects(operation, assertHlsError('HLS_TOO_LARGE'));
});

test('assembleHls rejects non-HTTP segment URLs before permission checks or segment fetches', async () => {
  const calls = [];
  await assert.rejects(
    assembleHls('https://cdn.test/media.m3u8', {
      fetchImpl: async (url) => {
        calls.push(url);
        return response(mediaPlaylist('data:video/mp2t;base64,QUFB'));
      },
    }),
    assertHlsError('HLS_INVALID'),
  );
  assert.deepEqual(calls, ['https://cdn.test/media.m3u8']);
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

test('assembleHls downloads up to eight segments concurrently by default', async () => {
  let active = 0;
  let peak = 0;
  const waiters = [];
  const segmentNames = Array.from({ length: 9 }, (_, index) => `${index + 1}.ts`);
  const operation = assembleHls('https://cdn.test/media.m3u8', {
    allowedOrigins: ['https://cdn.test'],
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
  const activeAfterStart = active;
  while (waiters.length > 0 || active > 0) {
    waiters.splice(0).forEach((resolve) => resolve());
    await new Promise((resolve) => setImmediate(resolve));
  }
  await operation;
  assert.equal(activeAfterStart, 8);
  assert.equal(peak, 8);
});

test('assembleHls rejects invalid concurrency and maxBytes values', async () => {
  const neverFetch = async () => { throw new Error('fetch should not run'); };
  for (const concurrency of [0, -1, 1.5, 9, Number.MAX_SAFE_INTEGER + 1]) {
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
