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

function validatePositiveSafeInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw invalid(`A opção ${name} para HLS é inválida.`, { [name]: value });
  }
}

async function fetchOk(url, fetchImpl, signal) {
  const options = { credentials: 'include' };
  if (signal !== undefined) options.signal = signal;

  let response;
  try {
    response = await fetchImpl(url, options);
  } catch (error) {
    if (error instanceof HlsError) throw error;
    throw networkError(url);
  }

  if (!response?.ok) throw networkError(url, response?.status);
  return response;
}

async function readText(response, url) {
  try {
    return await response.text();
  } catch (error) {
    if (error instanceof HlsError) throw error;
    throw networkError(url);
  }
}

async function readBytes(response, url) {
  try {
    return await response.arrayBuffer();
  } catch (error) {
    if (error instanceof HlsError) throw error;
    throw networkError(url);
  }
}

async function fetchPlaylist(url, fetchImpl, signal) {
  const response = await fetchOk(url, fetchImpl, signal);
  return parseHlsPlaylist(await readText(response, url), url);
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

  const controller = new AbortController();
  const relayAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) relayAbort();
  else signal?.addEventListener?.('abort', relayAbort, { once: true });

  try {
    const playlist = await fetchPlaylist(url, fetchImpl, controller.signal);
    if (playlist.kind === 'master') {
      throw new HlsError(
        'HLS_VARIANT_REQUIRED',
        'Selecione uma qualidade HLS antes de iniciar o download.',
      );
    }

    const permitted = new Set(allowedOrigins);
    const missingOrigins = [];
    const seenMissing = new Set();
    for (const segment of playlist.segments) {
      const origin = new URL(segment.url).origin;
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
    let stopped = false;

    const stop = () => {
      stopped = true;
      controller.abort();
    };

    const worker = async () => {
      while (!stopped) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= playlist.segments.length) return;

        const segment = playlist.segments[index];
        try {
          const response = await fetchOk(segment.url, fetchImpl, controller.signal);
          const bytes = await readBytes(response, segment.url);
          if (stopped) return;

          if (total + bytes.byteLength > maxBytes) {
            stop();
            throw new HlsError(
              'HLS_TOO_LARGE',
              'O vídeo HLS excede o limite de tamanho permitido.',
              { maxBytes },
            );
          }
          total += bytes.byteLength;
          parts[index] = bytes;
        } catch (error) {
          if (!stopped) stop();
          throw error;
        }
      }
    };

    const workerCount = Math.min(concurrency, playlist.segments.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    const blob = new Blob(parts, { type: 'video/mp2t' });
    return { blob, size: total };
  } finally {
    signal?.removeEventListener?.('abort', relayAbort);
  }
}
