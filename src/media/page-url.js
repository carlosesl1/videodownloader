const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const TIKTOK_ID = /^\d{10,30}$/;
const TIKTOK_USER = /^[A-Za-z0-9._-]{1,64}$/;
const TIKTOK_SHORT_ID = /^[A-Za-z0-9_-]{5,32}$/;
const INSTAGRAM_ID = /^[A-Za-z0-9_-]{5,64}$/;
const X_USER = /^[A-Za-z0-9_]{1,50}$/;
const X_ID = /^\d{5,30}$/;

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
const TIKTOK_HOSTS = new Set(['tiktok.com', 'www.tiktok.com', 'm.tiktok.com']);
const TIKTOK_SHORT_HOSTS = new Set(['vm.tiktok.com', 'vt.tiktok.com']);
const INSTAGRAM_HOSTS = new Set(['instagram.com', 'www.instagram.com', 'm.instagram.com']);
const X_HOSTS = new Set([
  'x.com', 'www.x.com', 'mobile.x.com',
  'twitter.com', 'www.twitter.com', 'mobile.twitter.com',
]);

function hasUnsafeRawAuthorityOrPath(value) {
  const separator = value.indexOf('://');
  if (separator < 0) return true;
  const authorityStart = separator + 3;
  const authorityEndOffset = value.slice(authorityStart).search(/[\\/?#]/);
  const authorityEnd = authorityEndOffset < 0 ? value.length : authorityStart + authorityEndOffset;
  if (value.slice(authorityStart, authorityEnd).includes('@') || value.includes('\\')) return true;

  const pathEndOffset = value.slice(authorityEnd).search(/[?#]/);
  const pathEnd = pathEndOffset < 0 ? value.length : authorityEnd + pathEndOffset;
  return value.slice(authorityEnd, pathEnd).split('/').some((segment) => {
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

function result(platform, canonicalUrl, mediaId) {
  return Object.freeze({ platform, canonicalUrl, mediaId });
}

function youtubePage(url) {
  let mediaId = null;
  if (YOUTUBE_HOSTS.has(url.hostname) && url.pathname === '/watch') {
    mediaId = singleQueryValue(url.search, 'v');
  } else if (YOUTUBE_HOSTS.has(url.hostname) && /^\/shorts\/[A-Za-z0-9_-]{11}$/.test(url.pathname)) {
    mediaId = url.pathname.slice('/shorts/'.length);
  } else if (url.hostname === 'youtu.be' && /^\/[A-Za-z0-9_-]{11}$/.test(url.pathname)) {
    mediaId = url.pathname.slice(1);
  }
  return YOUTUBE_ID.test(mediaId ?? '')
    ? result('youtube', `https://www.youtube.com/watch?v=${mediaId}`, mediaId)
    : null;
}

function tiktokPage(url) {
  if (TIKTOK_SHORT_HOSTS.has(url.hostname)) {
    const match = /^\/([A-Za-z0-9_-]{5,32})\/?$/.exec(url.pathname);
    if (!match || !TIKTOK_SHORT_ID.test(match[1])) return null;
    return result('tiktok', `https://${url.hostname}/${match[1]}/`, `short:${match[1]}`);
  }
  if (!TIKTOK_HOSTS.has(url.hostname)) return null;
  const match = /^\/@([A-Za-z0-9._-]{1,64})\/video\/(\d{10,30})\/?$/.exec(url.pathname);
  if (!match || !TIKTOK_USER.test(match[1]) || !TIKTOK_ID.test(match[2])) return null;
  return result('tiktok', `https://www.tiktok.com/@${match[1]}/video/${match[2]}`, match[2]);
}

function instagramPage(url) {
  if (!INSTAGRAM_HOSTS.has(url.hostname)) return null;
  const match = /^\/(p|reel|reels|tv)\/([A-Za-z0-9_-]{5,64})\/?$/.exec(url.pathname);
  if (!match || !INSTAGRAM_ID.test(match[2])) return null;
  const kind = match[1] === 'reels' ? 'reel' : match[1];
  return result('instagram', `https://www.instagram.com/${kind}/${match[2]}/`, match[2]);
}

function xPage(url) {
  if (!X_HOSTS.has(url.hostname)) return null;
  const match = /^\/([A-Za-z0-9_]{1,50})\/status\/(\d{5,30})(?:\/(?:video|photo)\/\d{1,3})?\/?$/.exec(url.pathname);
  if (!match || !X_USER.test(match[1]) || !X_ID.test(match[2])) return null;
  return result('x', `https://x.com/${match[1]}/status/${match[2]}`, match[2]);
}

/** Returns a strict canonical public media page, or null for every unsupported input. */
export function canonicalMediaPage(value) {
  if (typeof value !== 'string' || !value || hasUnsafeRawAuthorityOrPath(value)) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  return youtubePage(url) ?? tiktokPage(url) ?? instagramPage(url) ?? xPage(url);
}
