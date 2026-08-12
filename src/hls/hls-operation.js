import {
  DEFAULT_HLS_PLAYLIST_LIMITS,
  HlsError,
  parseHlsPlaylist,
} from './parse-playlist.js';

const DEFAULT_MAX_BYTES = 256 * 1024 ** 2;
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const MAX_CONCURRENCY = 8;

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

function timeoutError(url, timeoutMs) {
  return new HlsError(
    'HLS_TIMEOUT',
    'Um recurso HLS demorou demais para responder.',
    { url, timeoutMs },
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

function manifestTooLarge(maxManifestBytes) {
  return new HlsError(
    'HLS_MANIFEST_TOO_LARGE',
    'A playlist HLS excede o limite de tamanho permitido.',
    { maxManifestBytes },
  );
}

function declaredContentLength(response) {
  const raw = response?.headers?.get?.('content-length');
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : Number.MAX_SAFE_INTEGER;
}

async function requestResource(url, fetchImpl, signal, timeoutMs, consume) {
  if (signal?.aborted) throw cancellationError(url);

  const requestController = new AbortController();
  let interruption;
  let rejectInterruption;
  const interrupted = new Promise((_, reject) => {
    rejectInterruption = reject;
  });
  const interrupt = (error) => {
    if (interruption) return;
    interruption = error;
    requestController.abort();
    rejectInterruption(error);
  };
  const onAbort = () => interrupt(cancellationError(url));
  signal?.addEventListener('abort', onAbort, { once: true });
  const timeoutId = setTimeout(
    () => interrupt(timeoutError(url, timeoutMs)),
    timeoutMs,
  );

  const operation = (async () => {
    try {
      const response = await fetchImpl(url, {
        credentials: 'include',
        signal: requestController.signal,
      });
      if (!response?.ok) throw networkError(url, response?.status);
      return await consume(response, requestController.signal);
    } catch (error) {
      if (error instanceof HlsError) throw error;
      if (interruption) throw interruption;
      throw networkError(url);
    }
  })();

  try {
    return await Promise.race([operation, interrupted]);
  } catch (error) {
    if (!requestController.signal.aborted) requestController.abort();
    throw error;
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function cancelReader(reader) {
  try {
    await reader.cancel();
  } catch {
    // Cancellation is best-effort; the public operation error is preserved.
  }
}

async function readReader(reader, signal, url) {
  if (signal.aborted) throw cancellationError(url);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(cancellationError(url));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } catch (error) {
    if (error instanceof HlsError) throw error;
    throw networkError(url);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function readPlaylistResponse(response, url, requestSignal, playlistLimits) {
  const { maxManifestBytes } = playlistLimits;
  const declaredBytes = declaredContentLength(response);
  if (declaredBytes !== null && declaredBytes > maxManifestBytes) {
    throw manifestTooLarge(maxManifestBytes);
  }

  const getReader = response.body?.getReader;
  if (typeof getReader !== 'function') {
    const text = await response.text();
    return parseHlsPlaylist(text, url, playlistLimits);
  }

  const reader = getReader.call(response.body);
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  const onAbort = () => { cancelReader(reader); };
  requestSignal.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      const { done, value } = await readReader(reader, requestSignal, url);
      if (done) break;
      if (!(value instanceof Uint8Array)) throw networkError(url);
      bytes += value.byteLength;
      if (bytes > maxManifestBytes) {
        await cancelReader(reader);
        throw manifestTooLarge(maxManifestBytes);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return parseHlsPlaylist(text, url, playlistLimits);
  } catch (error) {
    text = '';
    throw error;
  } finally {
    requestSignal.removeEventListener('abort', onAbort);
  }
}

async function fetchPlaylist(url, fetchImpl, signal, timeoutMs, playlistLimits) {
  return requestResource(
    url,
    fetchImpl,
    signal,
    timeoutMs,
    (response, requestSignal) => readPlaylistResponse(
      response,
      url,
      requestSignal,
      playlistLimits,
    ),
  );
}

export async function inspectHls(url, {
  fetchImpl = fetch,
  signal,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  validateUrl(url);
  validateFetch(fetchImpl);
  validatePositiveSafeInteger(requestTimeoutMs, 'requestTimeoutMs');
  const playlist = await fetchPlaylist(
    url,
    fetchImpl,
    signal,
    requestTimeoutMs,
    DEFAULT_HLS_PLAYLIST_LIMITS,
  );
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
  onProgress,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  validateUrl(url);
  validateFetch(fetchImpl);
  validateAllowedOrigins(allowedOrigins);
  validatePositiveSafeInteger(maxBytes, 'maxBytes');
  validatePositiveSafeInteger(concurrency, 'concurrency', MAX_CONCURRENCY);
  validatePositiveSafeInteger(requestTimeoutMs, 'requestTimeoutMs');
  if (onProgress !== undefined && typeof onProgress !== 'function') {
    throw invalid('A função de progresso HLS é inválida.');
  }

  let stopped = false;
  let fatalError;
  let parts;
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
    const playlist = await fetchPlaylist(
      url,
      fetchImpl,
      controller.signal,
      requestTimeoutMs,
      DEFAULT_HLS_PLAYLIST_LIMITS,
    );
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

    parts = new Array(playlist.segments.length);
    let nextIndex = 0;
    let total = 0;
    let completedSegments = 0;
    let completedBytes = 0;
    const notifyProgress = () => {
      const estimatedTotalBytes = completedSegments > 0
        ? Math.max(
          total,
          Math.min(
            Number.MAX_SAFE_INTEGER,
            Math.ceil((completedBytes / completedSegments) * playlist.segments.length),
          ),
        )
        : null;
      try {
        onProgress?.({
          completedSegments,
          totalSegments: playlist.segments.length,
          bytesReceived: total,
          estimatedTotalBytes,
        });
      } catch {
        // A falha da interface não deve interromper a montagem do vídeo.
      }
    };
    notifyProgress();

    const tooLargeError = () => new HlsError(
      'HLS_TOO_LARGE',
      'O vídeo HLS excede o limite de tamanho permitido.',
      { maxBytes },
    );
    const rejectTooLarge = () => {
      const error = tooLargeError();
      stop(error);
      throw error;
    };
    const reserve = (chunk, segmentChunks, segmentUrl) => {
      assertRunning(segmentUrl);
      if (!(chunk instanceof Uint8Array) && !(chunk instanceof ArrayBuffer)) {
        throw networkError(segmentUrl);
      }
      if (total + chunk.byteLength > maxBytes) rejectTooLarge();
      total += chunk.byteLength;
      segmentChunks.push(chunk);
    };

    const readSegment = async (response, segmentUrl, requestSignal) => {
      const declaredBytes = declaredContentLength(response);
      if (declaredBytes !== null && declaredBytes > maxBytes - total) rejectTooLarge();

      const getReader = response.body?.getReader;
      if (typeof getReader !== 'function') {
        const bytes = await response.arrayBuffer();
        assertRunning(segmentUrl);
        const segmentChunks = [];
        reserve(bytes, segmentChunks, segmentUrl);
        const part = new Blob(segmentChunks, { type: 'video/mp2t' });
        segmentChunks.length = 0;
        return part;
      }

      const reader = getReader.call(response.body);
      const segmentChunks = [];
      let readerCancelled = false;
      const cancelSegmentReader = () => {
        if (readerCancelled) return;
        readerCancelled = true;
        try {
          Promise.resolve(reader.cancel()).catch(() => {});
        } catch {
          // Cancellation is best-effort; the public operation error is preserved.
        }
      };
      requestSignal.addEventListener('abort', cancelSegmentReader, { once: true });

      try {
        while (true) {
          assertRunning(segmentUrl);
          const { done, value } = await readReader(reader, requestSignal, segmentUrl);
          assertRunning(segmentUrl);
          if (done) {
            const part = new Blob(segmentChunks, { type: 'video/mp2t' });
            segmentChunks.length = 0;
            return part;
          }
          if (!(value instanceof Uint8Array)) throw networkError(segmentUrl);
          if (total + value.byteLength > maxBytes) {
            cancelSegmentReader();
            rejectTooLarge();
          }
          total += value.byteLength;
          segmentChunks.push(value);
        }
      } catch (error) {
        segmentChunks.length = 0;
        if (stopped || requestSignal.aborted) cancelSegmentReader();
        throw error;
      } finally {
        requestSignal.removeEventListener('abort', cancelSegmentReader);
      }
    };

    const worker = async () => {
      while (!stopped) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= playlist.segments.length) return;

        const segment = playlist.segments[index];
        try {
          const part = await requestResource(
            segment.url,
            fetchImpl,
            controller.signal,
            requestTimeoutMs,
            (response, requestSignal) => readSegment(
              response,
              segment.url,
              requestSignal,
            ),
          );
          assertRunning(segment.url);
          parts[index] = part;
          completedBytes += part.size;
          completedSegments += 1;
          notifyProgress();
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
    const blob = new Blob(parts, { type: 'video/mp2t' });
    return { blob, size: total };
  } finally {
    parts?.fill(undefined);
    signal?.removeEventListener?.('abort', relayAbort);
  }
}
