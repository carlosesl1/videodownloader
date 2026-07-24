export const DOWNLOAD_PREFERENCES_KEY = 'downloadPreferences';

export const DEFAULT_DOWNLOAD_PREFERENCES = Object.freeze({
  subfolder: 'Video Radar',
  automatic: true,
});

const INVALID_SEGMENT = /[\u0000-\u001f<>:"|?*]/;
const RESERVED_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export function normalizeDownloadSubfolder(value) {
  if (typeof value !== 'string') throw new Error('Informe uma subpasta válida.');
  const normalized = value.trim().replaceAll('\\', '/');
  if (!normalized) return '';
  if (normalized.length > 180 || normalized.startsWith('/') || normalized.endsWith('/')) {
    throw new Error('Use somente uma subpasta dentro de Downloads.');
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => (
    !segment
    || segment === '.'
    || segment === '..'
    || INVALID_SEGMENT.test(segment)
    || RESERVED_SEGMENT.test(segment)
    || /[ .]$/.test(segment)
  ))) {
    throw new Error('A subpasta contém um nome ou caractere não permitido.');
  }
  return segments.join('/');
}

export function normalizeDownloadPreferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_DOWNLOAD_PREFERENCES };
  }
  try {
    return {
      subfolder: normalizeDownloadSubfolder(value.subfolder),
      automatic: typeof value.automatic === 'boolean'
        ? value.automatic
        : DEFAULT_DOWNLOAD_PREFERENCES.automatic,
    };
  } catch {
    return { ...DEFAULT_DOWNLOAD_PREFERENCES };
  }
}

export function validateDownloadPreferences(value) {
  return {
    subfolder: normalizeDownloadSubfolder(value?.subfolder),
    automatic: value?.automatic === true,
  };
}

export async function readDownloadPreferences(storageLocal) {
  try {
    const stored = await storageLocal?.get(DOWNLOAD_PREFERENCES_KEY);
    return normalizeDownloadPreferences(stored?.[DOWNLOAD_PREFERENCES_KEY]);
  } catch {
    return { ...DEFAULT_DOWNLOAD_PREFERENCES };
  }
}

export function downloadTarget(filename, preferences) {
  const normalized = normalizeDownloadPreferences(preferences);
  return {
    filename: normalized.subfolder ? `${normalized.subfolder}/${filename}` : filename,
    saveAs: !normalized.automatic,
  };
}
