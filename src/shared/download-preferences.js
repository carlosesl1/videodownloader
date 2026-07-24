export const DOWNLOAD_PREFERENCES_KEY = 'downloadPreferences';
export const DOWNLOAD_PREFERENCES_SCHEMA = 2;

export const DEFAULT_DOWNLOAD_PREFERENCES = Object.freeze({
  schemaVersion: DOWNLOAD_PREFERENCES_SCHEMA,
  askEveryTime: true,
  defaultFolder: null,
});

const INVALID_WINDOWS_SEGMENT = /[\u0000-\u001f<>:"/\\|?*]/;
const RESERVED_WINDOWS_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const VALID_OPERATION_ID = /^[A-Za-z0-9_-]{1,128}$/;

function defaultDownloadPreferences() {
  return { ...DEFAULT_DOWNLOAD_PREFERENCES };
}

function invalidFolderError() {
  return new Error('Informe uma pasta absoluta do Windows válida.');
}

function validateWindowsSegments(segments) {
  if (segments.some((segment) => (
    !segment
    || segment === '.'
    || segment === '..'
    || INVALID_WINDOWS_SEGMENT.test(segment)
    || RESERVED_WINDOWS_SEGMENT.test(segment)
    || /[ .]$/.test(segment)
  ))) {
    throw invalidFolderError();
  }
}

export function normalizeWindowsFolder(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) {
    throw invalidFolderError();
  }

  if (/^[A-Za-z]:\\/.test(value)) {
    const driveRoot = value.slice(0, 3);
    const remainder = value.slice(3).replace(/\\+$/, '');
    if (!remainder) return driveRoot;
    const segments = remainder.split('\\');
    validateWindowsSegments(segments);
    return `${driveRoot}${segments.join('\\')}`;
  }

  if (value.startsWith('\\\\')) {
    const withoutTrailingSlashes = value.replace(/\\+$/, '');
    const segments = withoutTrailingSlashes.slice(2).split('\\');
    if (segments.length < 2) throw invalidFolderError();
    validateWindowsSegments(segments);
    return `\\\\${segments.join('\\')}`;
  }

  throw invalidFolderError();
}

export function normalizeDownloadPreferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return defaultDownloadPreferences();
  }

  if (value.schemaVersion === DOWNLOAD_PREFERENCES_SCHEMA) {
    try {
      return {
        schemaVersion: DOWNLOAD_PREFERENCES_SCHEMA,
        askEveryTime: value.askEveryTime !== false,
        defaultFolder: normalizeWindowsFolder(value.defaultFolder),
      };
    } catch {
      return defaultDownloadPreferences();
    }
  }

  if (!Object.hasOwn(value, 'schemaVersion') && typeof value.automatic === 'boolean') {
    return {
      schemaVersion: DOWNLOAD_PREFERENCES_SCHEMA,
      askEveryTime: !value.automatic,
      defaultFolder: null,
    };
  }

  return defaultDownloadPreferences();
}

export function validateDownloadPreferences(value) {
  return {
    schemaVersion: DOWNLOAD_PREFERENCES_SCHEMA,
    askEveryTime: value?.askEveryTime === true,
    defaultFolder: normalizeWindowsFolder(value?.defaultFolder),
  };
}

export async function readDownloadPreferences(storageLocal) {
  try {
    const stored = await storageLocal?.get(DOWNLOAD_PREFERENCES_KEY);
    return normalizeDownloadPreferences(stored?.[DOWNLOAD_PREFERENCES_KEY]);
  } catch {
    return defaultDownloadPreferences();
  }
}

export function browserDownloadTarget(filename, preferences, operationId) {
  if (preferences?.askEveryTime !== false) {
    return { filename, saveAs: true, staging: false };
  }
  if (typeof operationId !== 'string' || !VALID_OPERATION_ID.test(operationId)) {
    throw new Error('O identificador da operação de download é inválido.');
  }
  return {
    filename: `Video Radar/.staging/${operationId}/${filename}`,
    saveAs: false,
    staging: true,
  };
}

// Temporary compatibility helpers for consumers that still use the legacy download flow.
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
    || /[\u0000-\u001f<>:"|?*]/.test(segment)
    || RESERVED_WINDOWS_SEGMENT.test(segment)
    || /[ .]$/.test(segment)
  ))) {
    throw new Error('A subpasta contém um nome ou caractere não permitido.');
  }
  return segments.join('/');
}

export function downloadTarget(filename, preferences) {
  if (
    preferences
    && typeof preferences === 'object'
    && !Array.isArray(preferences)
    && !Object.hasOwn(preferences, 'schemaVersion')
    && typeof preferences.automatic === 'boolean'
  ) {
    try {
      const subfolder = normalizeDownloadSubfolder(preferences.subfolder);
      return {
        filename: subfolder ? `${subfolder}/${filename}` : filename,
        saveAs: !preferences.automatic,
      };
    } catch {
      return { filename: `Video Radar/${filename}`, saveAs: false };
    }
  }

  const normalized = normalizeDownloadPreferences(preferences);
  return normalized.askEveryTime
    ? { filename, saveAs: true }
    : { filename: `Video Radar/${filename}`, saveAs: false };
}
