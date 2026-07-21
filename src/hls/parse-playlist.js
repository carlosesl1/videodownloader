export class HlsError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'HlsError';
    this.code = code;
    this.details = details;
  }
}

function invalid(details) {
  return new HlsError('HLS_INVALID', 'Invalid HLS playlist', { reason: details });
}

const MEDIA_ONLY_TAG_PREFIXES = [
  '#EXTINF:', '#EXT-X-TARGETDURATION:', '#EXT-X-MEDIA-SEQUENCE:',
  '#EXT-X-DISCONTINUITY-SEQUENCE:', '#EXT-X-PLAYLIST-TYPE:', '#EXT-X-BYTERANGE:',
  '#EXT-X-KEY:', '#EXT-X-MAP:', '#EXT-X-PROGRAM-DATE-TIME:', '#EXT-X-DATERANGE:',
];
const MEDIA_ONLY_TAGS = new Set([
  '#EXT-X-ENDLIST', '#EXT-X-I-FRAMES-ONLY', '#EXT-X-DISCONTINUITY',
]);
const MASTER_ONLY_TAG_PREFIXES = [
  '#EXT-X-MEDIA:', '#EXT-X-STREAM-INF:', '#EXT-X-I-FRAME-STREAM-INF:',
  '#EXT-X-SESSION-DATA:', '#EXT-X-SESSION-KEY:',
];

function parseAttributes(value) {
  const attributes = {};
  let index = 0;

  while (index < value.length) {
    if (value[index] === ',' || /\s/.test(value[index] || '')) {
      throw invalid('Whitespace or trailing separator in HLS attribute list');
    }

    const nameStart = index;
    while (/[A-Z0-9-]/i.test(value[index] || '')) index += 1;
    const name = value.slice(nameStart, index);
    if (!name || value[index] !== '=') throw invalid('Invalid HLS attribute list');
    if (name !== name.toUpperCase()) throw invalid('HLS attribute names must be uppercase');
    index += 1;

    let attributeValue = '';
    if (value[index] === '"') {
      index += 1;
      const valueStart = index;
      while (index < value.length && value[index] !== '"') index += 1;
      if (index >= value.length) throw invalid('Unterminated quoted HLS attribute');
      attributeValue = value.slice(valueStart, index);
      index += 1;
    } else {
      const valueStart = index;
      while (index < value.length && value[index] !== ',') {
        if (/\s/.test(value[index])) throw invalid('Whitespace in unquoted HLS attribute');
        index += 1;
      }
      attributeValue = value.slice(valueStart, index);
    }

    if (!attributeValue) throw invalid('Empty HLS attribute');
    const normalizedName = name.toUpperCase();
    if (Object.hasOwn(attributes, normalizedName)) {
      throw invalid(`Duplicate HLS attribute: ${normalizedName}`);
    }
    attributes[normalizedName] = attributeValue;
    if (index < value.length && value[index] !== ',') throw invalid('Invalid HLS attribute separator');
    if (value[index] === ',') {
      index += 1;
      if (index >= value.length || value[index] === ',' || /\s/.test(value[index] || '')) {
        throw invalid('Whitespace or trailing separator in HLS attribute list');
      }
    }
  }

  return attributes;
}

function tagValue(line, tag) {
  return line.slice(tag.length);
}

function resolveUri(uri, playlistUrl) {
  if (!uri || uri.startsWith('#')) throw invalid('Missing HLS URI');
  try {
    return new URL(uri, playlistUrl).href;
  } catch {
    throw invalid('Invalid HLS URI');
  }
}

function parseStreamVariant(attributes, uri, playlistUrl) {
  if (!/^\d+$/.test(attributes.BANDWIDTH || '')) {
    throw invalid('Malformed EXT-X-STREAM-INF bandwidth');
  }
  const bandwidth = Number(attributes.BANDWIDTH);
  const resolution = /^(\d+)x(\d+)$/i.exec(attributes.RESOLUTION || '');
  if (!Number.isSafeInteger(bandwidth) || bandwidth < 1 || !resolution) {
    throw invalid('Malformed EXT-X-STREAM-INF');
  }

  const width = Number(resolution[1]);
  const height = Number(resolution[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw invalid('Malformed EXT-X-STREAM-INF resolution');
  }

  return {
    url: resolveUri(uri, playlistUrl),
    width,
    height,
    bandwidth,
    codecs: attributes.CODECS || null,
    label: `${height}p`,
  };
}

function parseDuration(line) {
  const durationText = tagValue(line, '#EXTINF:').split(',', 1)[0].trim();
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(durationText)) {
    throw invalid('Invalid EXTINF duration');
  }
  const duration = Number(durationText);
  if (!Number.isFinite(duration) || duration < 0) {
    throw invalid('Invalid EXTINF duration');
  }
  return duration;
}

function rejectUnsupportedTags(lines) {
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MAP:')) {
      throw new HlsError('HLS_FMP4', 'fMP4 HLS playlists are not supported');
    }
    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      throw new HlsError('HLS_BYTERANGE', 'Byte-range HLS playlists are not supported');
    }
    if (line.startsWith('#EXT-X-KEY:')) {
      const attributes = parseAttributes(tagValue(line, '#EXT-X-KEY:'));
      if (attributes.METHOD === 'NONE') {
        if (Object.keys(attributes).length !== 1) {
          throw invalid('METHOD=NONE must be the only key attribute');
        }
      } else {
        throw new HlsError('HLS_ENCRYPTED', 'Encrypted HLS playlists are not supported');
      }
    }
  }
}

function assertNoUnpairedUris(lines, consumedUriIndices) {
  for (let index = 1; index < lines.length; index += 1) {
    if (!lines[index].startsWith('#') && !consumedUriIndices.has(index)) {
      throw invalid('Unpaired HLS URI');
    }
  }
}

function parseMaster(lines, playlistUrl) {
  const variants = [];
  const consumedUriIndices = new Set();

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;

    const uri = lines[index + 1];
    if (!uri || uri.startsWith('#')) throw invalid('Missing URI after EXT-X-STREAM-INF');
    const attributes = parseAttributes(tagValue(line, '#EXT-X-STREAM-INF:'));
    variants.push(parseStreamVariant(attributes, uri, playlistUrl));
    consumedUriIndices.add(index + 1);
    index += 1;
  }

  if (variants.length === 0) throw invalid('Master playlist has no variants');
  assertNoUnpairedUris(lines, consumedUriIndices);
  variants.sort((left, right) => (
    right.height - left.height || right.width - left.width || right.bandwidth - left.bandwidth
  ));
  return { kind: 'master', variants };
}

function parseMedia(lines, playlistUrl) {
  const segments = [];
  const consumedUriIndices = new Set();
  let hasEndList = false;

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === '#EXT-X-ENDLIST') {
      hasEndList = true;
      continue;
    }
    if (!line.startsWith('#EXTINF:')) continue;

    const duration = parseDuration(line);
    let uri;
    for (index += 1; index < lines.length; index += 1) {
      const candidate = lines[index];
      if (isMediaOnlyTag(candidate)) throw invalid('Missing URI after EXTINF');
      if (!candidate.startsWith('#')) {
        uri = candidate;
        break;
      }
    }
    if (!uri) throw invalid('Missing URI after EXTINF');
    consumedUriIndices.add(index);
    const url = resolveUri(uri, playlistUrl);
    const pathname = new URL(url).pathname;
    if (/\.[^/.]+$/.test(pathname) && !/\.ts$/i.test(pathname)) {
      throw invalid('Media segment is not MPEG-TS');
    }
    segments.push({ url, duration });
  }

  if (!hasEndList) throw new HlsError('HLS_LIVE', 'Live HLS playlists are not supported');
  if (segments.length === 0) throw new HlsError('HLS_EMPTY', 'HLS playlist contains no segments');
  assertNoUnpairedUris(lines, consumedUriIndices);
  return { kind: 'media', segments };
}

function isMediaOnlyTag(line) {
  return MEDIA_ONLY_TAG_PREFIXES.some((prefix) => line.startsWith(prefix)) || MEDIA_ONLY_TAGS.has(line);
}

function isMasterOnlyTag(line) {
  return MASTER_ONLY_TAG_PREFIXES.some((prefix) => line.startsWith(prefix));
}

export function parseHlsPlaylist(text, playlistUrl) {
  let lines;
  try {
    lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    throw invalid('Invalid HLS playlist text');
  }
  if (lines[0] !== '#EXTM3U') throw invalid('Playlist must begin with EXTM3U');
  try {
    new URL(playlistUrl);
  } catch {
    throw invalid('Invalid playlist URL');
  }

  const hasMasterVariants = lines.some((line) => line.startsWith('#EXT-X-STREAM-INF:'));
  if (lines.some(isMasterOnlyTag) && lines.some(isMediaOnlyTag)) {
    throw invalid('Mixed master and media playlist');
  }
  rejectUnsupportedTags(lines);
  return hasMasterVariants
    ? parseMaster(lines, playlistUrl)
    : parseMedia(lines, playlistUrl);
}
