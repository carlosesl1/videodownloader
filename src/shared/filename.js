const INVALID_FILENAME_CHARS = /[\\/:*?"<>|\u0000-\u001F]/g;
const RESERVED_WINDOWS_BASENAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const DIRECT_EXTENSIONS = new Set(['.mp4', '.webm', '.mov']);

export function sanitizeFilename(value) {
  return sanitizeFilenamePart(value) || 'video';
}

export function buildDownloadFilename({ url, kind, pageTitle } = {}) {
  const leaf = getUrlLeaf(url);
  const extension = kind === 'hls' ? '.ts' : getDirectExtension(leaf);
  const sourceName =
    sanitizeFilenamePart(removeExtension(leaf)) ||
    sanitizeFilenamePart(pageTitle) ||
    `video-${Date.now()}`;

  return `${sourceName}${extension}`;
}

function sanitizeFilenamePart(value) {
  const filename = String(value ?? '')
    .replace(INVALID_FILENAME_CHARS, '')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim();

  if (!filename) return '';

  const dotIndex = filename.lastIndexOf('.');
  const baseName = dotIndex > 0 ? filename.slice(0, dotIndex) : filename;

  return RESERVED_WINDOWS_BASENAME.test(baseName) ? `video-${filename}` : filename;
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
  return dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
}

function getDirectExtension(filename) {
  const dotIndex = filename.lastIndexOf('.');
  const extension = dotIndex > 0 ? filename.slice(dotIndex).toLowerCase() : '';
  return DIRECT_EXTENSIONS.has(extension) ? extension : '.mp4';
}
