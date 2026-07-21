export class HlsError extends Error {
  constructor(code, details) {
    super(code);
    this.name = 'HlsError';
    this.code = code;
    this.details = details;
  }
}

function invalid(details) {
  return new HlsError('HLS_INVALID', details);
}

function parseAttributes(value) {
  const attributes = {};
  let index = 0;

  while (index < value.length) {
    while (value[index] === ',' || /\s/.test(value[index] || '')) index += 1;
    if (index >= value.length) break;

    const nameStart = index;
    while (/[A-Z0-9-]/i.test(value[index] || '')) index += 1;
    const name = value.slice(nameStart, index);
    if (!name || value[index] !== '=') throw invalid('Invalid HLS attribute list');
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
      while (index < value.length && value[index] !== ',') index += 1;
      attributeValue = value.slice(valueStart, index).trim();
    }

    if (!attributeValue) throw invalid('Empty HLS attribute');
    attributes[name.toUpperCase()] = attributeValue;
    if (index < value.length && value[index] !== ',') throw invalid('Invalid HLS attribute separator');
    if (value[index] === ',') index += 1;
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
  const bandwidth = Number(attributes.BANDWIDTH);
  const resolution = /^([0-9]+)x([0-9]+)$/i.exec(attributes.RESOLUTION || '');
  if (!Number.isFinite(bandwidth) || bandwidth < 0 || !resolution) {
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
  const duration = Number(durationText);
  if (!durationText || !Number.isFinite(duration) || duration < 0) {
    throw invalid('Invalid EXTINF duration');
  }
  return duration;
}

function rejectUnsupportedTags(lines) {
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MAP:')) throw new HlsError('HLS_FMP4');
    if (line.startsWith('#EXT-X-BYTERANGE:')) throw new HlsError('HLS_BYTERANGE');
    if (line.startsWith('#EXT-X-KEY:')) {
      const attributes = parseAttributes(tagValue(line, '#EXT-X-KEY:'));
      if (attributes.METHOD?.toUpperCase() !== 'NONE') throw new HlsError('HLS_ENCRYPTED');
    }
  }
}

function parseMaster(lines, playlistUrl) {
  const variants = [];

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;

    const uri = lines[index + 1];
    if (!uri || uri.startsWith('#')) throw invalid('Missing URI after EXT-X-STREAM-INF');
    const attributes = parseAttributes(tagValue(line, '#EXT-X-STREAM-INF:'));
    variants.push(parseStreamVariant(attributes, uri, playlistUrl));
    index += 1;
  }

  if (variants.length === 0) throw invalid('Master playlist has no variants');
  variants.sort((left, right) => (
    right.height - left.height || right.width - left.width || right.bandwidth - left.bandwidth
  ));
  return { kind: 'master', variants };
}

function parseMedia(lines, playlistUrl) {
  const segments = [];
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
      if (candidate.startsWith('#EXTINF:')) throw invalid('Missing URI after EXTINF');
      if (!candidate.startsWith('#')) {
        uri = candidate;
        break;
      }
    }
    if (!uri) throw invalid('Missing URI after EXTINF');
    segments.push({ url: resolveUri(uri, playlistUrl), duration });
  }

  if (!hasEndList) throw new HlsError('HLS_LIVE');
  if (segments.length === 0) throw new HlsError('HLS_EMPTY');
  return { kind: 'media', segments };
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

  rejectUnsupportedTags(lines);
  return lines.some((line) => line.startsWith('#EXT-X-STREAM-INF:'))
    ? parseMaster(lines, playlistUrl)
    : parseMedia(lines, playlistUrl);
}
