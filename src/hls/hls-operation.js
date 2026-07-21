import { HlsError, parseHlsPlaylist } from './parse-playlist.js';

const DEFAULT_MAX_BYTES = 1024 ** 3;
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 4;

function invalid(message, details = {}) {
  return new HlsError('HLS_INVALID', message, details);
}

function networkError(url, status) {
  const details = status === undefined ? { url } : { url, status };
  return new HlsError(
    'HLS_NETWORK',
    status === undefined
      ? 'Não foi possível acessar o recurso HLS.'
      : 'O servidor não conseguiu fornecer o recurso HLS.',
    details,
  );
}

function cancellationError(url) {
  return new HlsError(
    'HLS_NETWORK',
    'A operação HLS foi cancelada.',
    { url },
  );
}

function validateUrl(url) {
  if (typeof url !== 'string') {
    throw invalid('A URL HLS informada é inválida.');
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error();
    return parsed.href;
  } catch {
    throw invalid('A URL HLS informada é inválida.', { url });
  }
}

function validateFetch(fetchImpl) {
  if (typeof fetchImpl !== 'function') {
    throw invalid('A função de rede HLS é inválida.');
  }
}

function validateAllowedOrigins(allowedOrigins) {
  if (!Array.isArray(allowedOrigins)) {
    throw invalid('As origens permitidas para HLS são inválidas.');
  }

  for (const origin of allowedOrigins) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw invalid('Uma origem permitida para HLS é inválida.', { origin });
    }
    if (
      typeof origin !== 'string'
      || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || parsed.origin !== origin
    ) {
      throw invalid('Uma origem permitida para HLS é inválida.', { origin });
    }
  }
}

function segmentOrigin(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error();
    return parsed.origin;
  } catch {
    throw invalid('A URL de um segmento HLS é inválida.');
  }
}

function validatePositiveSafeInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw invalid(`A opção ${name} para HLS é inválida.`, { [name]: value });
  }
}

async function awaitWithAbort(operation, signal, url) {
  if (!signal) return operation;
  if (signal.aborted) throw cancellationError(url);

  let onAbort;
  const aborted = new Promise((resolve, reject) => {
    onAbort = () => reject(cancellationError(url));
    signal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    const result = await Promise.race([operation, aborted]);
    if (signal.aborted) throw cancellationError(url);
    return result;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function fetchOk(url, fetchImpl, signal) {
  const options = { credentials: 'include' };
  if (signal !== undefined) options.signal = signal;

  let response;
  try {
    response = await awaitWithAbort(fetchImpl(url, options), signal, url);
  } catch (error) {
    if (error instanceof HlsError) throw error;
    throw networkError(url);
  }

  if (!response?.ok) throw networkError(url, response?.status);
  return response;
}

async function readText(response, url, signal) {
  try {
    return await awaitWithAbort(response.text(), signal, url);
  } catch (error) {
    if (error instanceof HlsError) throw error;
    throw networkError(url);
  }
}

async function readBytes(response, url, signal) {
  try {
    return await awaitWithAbort(response.arrayBuffer(), signal, url);
  } catch (error) {
    if (error instanceof HlsError) throw error;
    throw networkError(url);
  }
}

async function readStreamChunk(reader, url, signal) {
  try {
    return await awaitWithAbort(reader.read(), signal, url);
  } catch (error) {
    if (error instanceof HlsError) throw error;
    throw networkError(url);
  }
}

async function fetchPlaylist(url, fetchImpl, signal) {
  const response = await fetchOk(url, fetchImpl, signal);
  return parseHlsPlaylist(await readText(response, url, signal), url);
}

export async function inspectHls(url, { fetchImpl = fetch, signal } = {}) {
  validateUrl(url);
  validateFetch(fetchImpl);
  const playlist = await fetchPlaylist(url, fetchImpl, signal);
  if (playlist.kind === 'master') return playlist;

  return {
    kind: 'media',
    variants: [{
      url,
      width: 0,
      height: 0,
      bandwidth: 0,
      codecs: '',
      label: 'Qualidade única',
    }],
  };
}

export async function assembleHls(url, {
  fetchImpl = fetch,
  allowedOrigins = [],
  maxBytes = DEFAULT_MAX_BYTES,
  concurrency = DEFAULT_CONCURRENCY,
  signal,
} = {}) {
  validateUrl(url);
  validateFetch(fetchImpl);
  validateAllowedOrigins(allowedOrigins);
  validatePositiveSafeInteger(maxBytes, 'maxBytes');
  validatePositiveSafeInteger(concurrency, 'concurrency', MAX_CONCURRENCY);

  let stopped = false;
  let fatalError;
  const controller = new AbortController();

  const stop = (error) => {
    if (!fatalError) fatalError = error;
    stopped = true;
    if (!controller.signal.aborted) controller.abort();
    return fatalError;
  };
  const relayAbort = () => stop(cancellationError(url));
  const assertRunning = (resourceUrl = url) => {
    if (stopped || controller.signal.aborted) {
      throw fatalError || cancellationError(resourceUrl);
    }
  };

  if (signal?.aborted) relayAbort();
  else signal?.addEventListener?.('abort', relayAbort, { once: true });

  try {
    assertRunning();
    const playlist = await fetchPlaylist(url, fetchImpl, controller.signal);
    assertRunning();
    if (playlist.kind === 'master') {
      throw new HlsError(
        'HLS_VARIANT_REQUIRED',
        'Selecione uma qualidade HLS antes de iniciar o download.',
      );
    }

    const segmentOrigins = playlist.segments.map((segment) => segmentOrigin(segment.url));
    const permitted = new Set(allowedOrigins);
    const missingOrigins = [];
    const seenMissing = new Set();
    for (const origin of segmentOrigins) {
      if (!permitted.has(origin) && !seenMissing.has(origin)) {
        seenMissing.add(origin);
        missingOrigins.push(origin);
      }
    }
    if (missingOrigins.length > 0) {
      throw new HlsError(
        'HLS_PERMISSION',
        'Autorize os endereços dos segmentos HLS antes de baixar.',
        { origins: missingOrigins },
      );
    }

    const parts = new Array(playlist.segments.length);
    let nextIndex = 0;
    let total = 0;

    const tooLargeError = () => new HlsError(
      'HLS_TOO_LARGE',
      'O vídeo HLS excede o limite de tamanho permitido.',
      { maxBytes },
    );
    const reserve = (chunk, segmentChunks) => {
      assertRunning();
      if (!(chunk instanceof Uint8Array) && !(chunk instanceof ArrayBuffer)) {
        throw networkError(url);
      }
      if (total + chunk.byteLength > maxBytes) {
        const error = tooLargeError();
        if (!fatalError) fatalError = error;
        stop(error);
        throw error;
      }
      total += chunk.byteLength;
      segmentChunks.push(chunk);
    };

    const readSegment = async (response, segmentUrl) => {
      const getReader = response.body?.getReader;
      if (typeof getReader !== 'function') {
        const bytes = await readBytes(response, segmentUrl, controller.signal);
        assertRunning(segmentUrl);
        const segmentChunks = [];
        reserve(bytes, segmentChunks);
        return segmentChunks;
      }

      const reader = getReader.call(response.body);
      const segmentChunks = [];
      let readerCancelled = false;
      const cancelReader = () => {
        if (readerCancelled) return;
        readerCancelled = true;
        try {
          Promise.resolve(reader.cancel()).catch(() => {});
        } catch {
          // Cancellation is best-effort; the public operation error is preserved.
        }
      };

      try {
        while (true) {
          assertRunning(segmentUrl);
          const { done, value } = await readStreamChunk(reader, segmentUrl, controller.signal);
          assertRunning(segmentUrl);
          if (done) return segmentChunks;
          if (!(value instanceof Uint8Array)) throw networkError(segmentUrl);

          if (total + value.byteLength > maxBytes) {
            const error = tooLargeError();
            if (!fatalError) fatalError = error;
            cancelReader();
            stop(error);
            throw error;
          }
          total += value.byteLength;
          segmentChunks.push(value);
        }
      } catch (error) {
        if (stopped || controller.signal.aborted) cancelReader();
        throw error;
      }
    };

    const worker = async () => {
      while (!stopped) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= playlist.segments.length) return;

        const segment = playlist.segments[index];
        try {
          const response = await fetchOk(segment.url, fetchImpl, controller.signal);
          assertRunning(segment.url);
          parts[index] = await readSegment(response, segment.url);
          assertRunning(segment.url);
        } catch (error) {
          const safeError = error instanceof HlsError ? error : networkError(segment.url);
          throw stop(safeError);
        }
      }
    };

    const workerCount = Math.min(concurrency, playlist.segments.length);
    const results = await Promise.allSettled(Array.from({ length: workerCount }, () => worker()));
    if (!fatalError) {
      const failed = results.find((result) => result.status === 'rejected');
      if (failed) fatalError = failed.reason instanceof HlsError ? failed.reason : networkError(url);
    }
    if (fatalError) throw fatalError;
    assertRunning();
    const orderedChunks = parts.flat();
    assertRunning();
    const blob = new Blob(orderedChunks, { type: 'video/mp2t' });
    return { blob, size: total };
  } finally {
    signal?.removeEventListener?.('abort', relayAbort);
  }
}
