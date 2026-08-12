const INVALID_FILENAME_CHARS = /[\\/:*?"<>|\u0000-\u001F\u007F]/g;
const DIRECTIONAL_CONTROLS = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
const RESERVED_WINDOWS_BASENAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const DIRECT_EXTENSIONS = new Set(['.mp4', '.webm', '.mov']);
const DIRECT_MIME_EXTENSIONS = new Map([
  ['video/mp4', '.mp4'],
  ['video/webm', '.webm'],
  ['video/quicktime', '.mov'],
]);

export const MAX_FILENAME_BYTES = 240;

export function sanitizeFilename(value) {
  return sanitizeFilenamePart(value) || 'video';
}

export function isValidDownloadFilename(value) {
  return typeof value === 'string'
    && value.length > 0
    && utf8ByteLength(value) <= MAX_FILENAME_BYTES
    && sanitizeFilename(value) === value;
}

export function buildDownloadFilename({ url, kind, pageTitle, type } = {}) {
  const leaf = getUrlLeaf(url);
  const extension = kind === 'hls' ? '.ts' : getDirectExtension(leaf, type);
  const baseByteLimit = MAX_FILENAME_BYTES - utf8ByteLength(extension);
  const sourceName =
    sanitizeFilenamePart(removeExtension(leaf), baseByteLimit) ||
    sanitizeFilenamePart(pageTitle, baseByteLimit) ||
    `video-${formatTimestamp()}`;

  return `${sourceName}${extension}`;
}

function sanitizeFilenamePart(value, maximumBytes = MAX_FILENAME_BYTES) {
  let filename = String(value ?? '')
    .normalize('NFC')
    .replace(INVALID_FILENAME_CHARS, '')
    .replace(DIRECTIONAL_CONTROLS, '')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim();

  if (!filename) return '';

  filename = protectReservedBasename(filename);
  filename = truncateUtf8(filename, maximumBytes).replace(/[. ]+$/g, '');
  if (!filename) return '';

  return protectReservedBasename(filename, maximumBytes);
}

function protectReservedBasename(filename, maximumBytes = MAX_FILENAME_BYTES) {
  const dotIndex = filename.indexOf('.');
  const baseName = dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
  return RESERVED_WINDOWS_BASENAME.test(baseName)
    ? truncateUtf8(`video-${filename}`, maximumBytes)
    : filename;
}

function getUrlLeaf(value) {
  try {
    const pathname = new URL(value).pathname;
    const leaf = pathname.slice(pathname.lastIndexOf('/') + 1);
    return decodeURIComponent(leaf);
  } catch {
    return '';
  }
}

function removeExtension(filename) {
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex === 0) return '';
  return dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
}

function getDirectExtension(filename, type) {
  const dotIndex = filename.lastIndexOf('.');
  const extension = dotIndex > 0 ? filename.slice(dotIndex).toLowerCase() : '';
  if (DIRECT_EXTENSIONS.has(extension)) return extension;
  const mime = String(type || '').split(';', 1)[0].trim().toLowerCase();
  return DIRECT_MIME_EXTENSIONS.get(mime) || '.mp4';
}

function utf8ByteLength(value) {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x7F) bytes += 1;
    else if (codePoint <= 0x7FF) bytes += 2;
    else if (codePoint <= 0xFFFF) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

function truncateUtf8(value, maximumBytes) {
  let output = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = utf8ByteLength(character);
    if (bytes + characterBytes > maximumBytes) break;
    output += character;
    bytes += characterBytes;
  }
  return output;
}

function formatTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join('-') +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
