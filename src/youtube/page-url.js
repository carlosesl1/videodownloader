const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const WATCH_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);

function hasUnsafeRawAuthorityOrPath(value) {
  const separator = value.indexOf('://');
  if (separator < 0) return true;
  const authorityStart = separator + 3;
  const authorityEnd = value.slice(authorityStart).search(/[\\/?#]/);
  const end = authorityEnd < 0 ? value.length : authorityStart + authorityEnd;
  if (value.slice(authorityStart, end).includes('@') || value.includes('\\')) return true;

  const pathEnd = value.slice(end).search(/[?#]/);
  const path = value.slice(end, pathEnd < 0 ? value.length : end + pathEnd);
  return path.split('/').some((segment) => {
    try {
      const decoded = decodeURIComponent(segment);
      return decoded === '.' || decoded === '..';
    } catch {
      return true;
    }
  });
}

function singleQueryValue(rawQuery, name) {
  let result = null;
  for (const pair of rawQuery.replace(/^\?/, '').split('&').filter(Boolean)) {
    const separator = pair.indexOf('=');
    const key = separator < 0 ? pair : pair.slice(0, separator);
    if (key !== name) continue;
    if (result !== null) return null;
    try {
      result = decodeURIComponent(separator < 0 ? '' : pair.slice(separator + 1));
    } catch {
      return null;
    }
  }
  return result;
}

/** Returns the single canonical public watch URL, or null for every other input. */
export function canonicalYouTubePageUrl(value) {
  if (typeof value !== 'string' || !value || hasUnsafeRawAuthorityOrPath(value)) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;

  let videoId = null;
  if (WATCH_HOSTS.has(url.hostname) && url.pathname === '/watch') {
    videoId = singleQueryValue(url.search, 'v');
  } else if (url.hostname === 'youtu.be' && /^\/[A-Za-z0-9_-]{11}$/.test(url.pathname)) {
    videoId = url.pathname.slice(1);
  }
  return VIDEO_ID.test(videoId ?? '') ? `https://www.youtube.com/watch?v=${videoId}` : null;
}
