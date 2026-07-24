import assert from 'node:assert/strict';
import test from 'node:test';

import {
  browserDownloadTarget,
  DEFAULT_DOWNLOAD_PREFERENCES,
  downloadTarget,
  DOWNLOAD_PREFERENCES_KEY,
  DOWNLOAD_PREFERENCES_SCHEMA,
  normalizeDownloadPreferences,
  normalizeWindowsFolder,
  readDownloadPreferences,
  validateDownloadPreferences,
} from '../src/shared/download-preferences.js';

test('uses schema v2 defaults for a new installation', () => {
  assert.equal(DOWNLOAD_PREFERENCES_SCHEMA, 2);
  assert.deepEqual(DEFAULT_DOWNLOAD_PREFERENCES, {
    schemaVersion: 2,
    askEveryTime: true,
    defaultFolder: null,
  });
  assert.deepEqual(normalizeDownloadPreferences(undefined), DEFAULT_DOWNLOAD_PREFERENCES);
  assert.deepEqual(normalizeDownloadPreferences('invalid'), DEFAULT_DOWNLOAD_PREFERENCES);
});

test('migrates legacy automatic preferences without carrying the relative subfolder', () => {
  assert.deepEqual(
    normalizeDownloadPreferences({ automatic: true, subfolder: 'Cursos/IA' }),
    { schemaVersion: 2, askEveryTime: false, defaultFolder: null },
  );
  assert.deepEqual(
    normalizeDownloadPreferences({ automatic: false, subfolder: 'Cursos/IA' }),
    { schemaVersion: 2, askEveryTime: true, defaultFolder: null },
  );
});

test('normalizes valid schema v2 preferences and falls back for an invalid folder', () => {
  assert.deepEqual(
    normalizeDownloadPreferences({
      schemaVersion: 2,
      askEveryTime: false,
      defaultFolder: 'C:\\Vídeos\\\\',
    }),
    {
      schemaVersion: 2,
      askEveryTime: false,
      defaultFolder: String.raw`C:\Vídeos`,
    },
  );
  assert.deepEqual(
    normalizeDownloadPreferences({
      schemaVersion: 2,
      defaultFolder: String.raw`C:\Vídeos`,
    }),
    {
      schemaVersion: 2,
      askEveryTime: true,
      defaultFolder: String.raw`C:\Vídeos`,
    },
  );
  assert.deepEqual(
    normalizeDownloadPreferences({
      schemaVersion: 2,
      askEveryTime: false,
      defaultFolder: '../Vídeos',
    }),
    DEFAULT_DOWNLOAD_PREFERENCES,
  );
});

test('accepts absolute Windows drive and UNC folders', () => {
  assert.equal(normalizeWindowsFolder(null), null);
  assert.equal(normalizeWindowsFolder(undefined), null);
  assert.equal(normalizeWindowsFolder('C:\\'), 'C:\\');
  assert.equal(
    normalizeWindowsFolder('D:\\Vídeos\\Cursos\\\\\\'),
    String.raw`D:\Vídeos\Cursos`,
  );
  assert.equal(
    normalizeWindowsFolder('\\\\servidor\\compartilhamento\\Vídeos\\\\'),
    String.raw`\\servidor\compartilhamento\Vídeos`,
  );
});

test('rejects relative, traversal, incomplete UNC, and oversized folders safely', () => {
  const invalidFolders = [
    'Vídeos',
    String.raw`C:Vídeos`,
    String.raw`C:\Vídeos\..\Privado`,
    String.raw`C:\.\Vídeos`,
    String.raw`\\servidor`,
    `C:\\${'a'.repeat(1022)}`,
  ];

  for (const folder of invalidFolders) {
    assert.throws(
      () => normalizeWindowsFolder(folder),
      (error) => error instanceof Error && /pasta/i.test(error.message),
      folder,
    );
  }
});

test('validates preferences into exactly the schema v2 storage shape', () => {
  assert.deepEqual(
    validateDownloadPreferences({
      schemaVersion: 99,
      askEveryTime: true,
      defaultFolder: 'C:\\Vídeos\\\\',
      ignored: 'value',
    }),
    {
      schemaVersion: 2,
      askEveryTime: true,
      defaultFolder: String.raw`C:\Vídeos`,
    },
  );
  assert.deepEqual(
    validateDownloadPreferences({ askEveryTime: 1, defaultFolder: null }),
    { schemaVersion: 2, askEveryTime: false, defaultFolder: null },
  );
  assert.throws(
    () => validateDownloadPreferences({ defaultFolder: 'Vídeos' }),
    /pasta/i,
  );
});

test('builds browser targets for prompted and automatic staging downloads', () => {
  assert.deepEqual(
    browserDownloadTarget('aula.mp4', { schemaVersion: 2, askEveryTime: true }, undefined),
    { filename: 'aula.mp4', saveAs: true, staging: false },
  );
  assert.deepEqual(
    browserDownloadTarget(
      'aula.mp4',
      { schemaVersion: 2, askEveryTime: false },
      'op_2026-07-24',
    ),
    {
      filename: 'Video Radar/.staging/op_2026-07-24/aula.mp4',
      saveAs: false,
      staging: true,
    },
  );
  assert.throws(
    () => browserDownloadTarget(
      'aula.mp4',
      { schemaVersion: 2, askEveryTime: false },
      '../escape',
    ),
    /opera(?:ç|Ã§)[aã]o|identificador/i,
  );
});

test('keeps the legacy downloadTarget wrapper contract for direct callers', () => {
  assert.deepEqual(
    downloadTarget('aula.mp4', { automatic: true, subfolder: 'Cursos/IA' }),
    { filename: 'Cursos/IA/aula.mp4', saveAs: false },
  );
  assert.deepEqual(
    downloadTarget('aula.mp4', { automatic: false, subfolder: '' }),
    { filename: 'aula.mp4', saveAs: true },
  );
});

test('reads and normalizes stored preferences and falls back when storage fails', async () => {
  const requestedKeys = [];
  const storageLocal = {
    async get(key) {
      requestedKeys.push(key);
      return {
        [DOWNLOAD_PREFERENCES_KEY]: {
          schemaVersion: 2,
          askEveryTime: false,
          defaultFolder: '\\\\servidor\\midia\\Vídeos\\\\',
        },
      };
    },
  };

  assert.deepEqual(await readDownloadPreferences(storageLocal), {
    schemaVersion: 2,
    askEveryTime: false,
    defaultFolder: String.raw`\\servidor\midia\Vídeos`,
  });
  assert.deepEqual(requestedKeys, [DOWNLOAD_PREFERENCES_KEY]);

  assert.deepEqual(
    await readDownloadPreferences({ get: async () => { throw new Error('storage offline'); } }),
    DEFAULT_DOWNLOAD_PREFERENCES,
  );
});
