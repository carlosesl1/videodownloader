import assert from 'node:assert/strict';
import test from 'node:test';

import { createOptionsController } from '../src/options/main.js';

function fakeView() {
  return {
    rendered: [],
    statuses: [],
    render(value) { this.rendered.push(structuredClone(value)); },
    status(message, error = false) { this.statuses.push({ message, error }); },
  };
}

function fakeStorage(preferences) {
  return {
    preferences: structuredClone(preferences),
    async get(key) { return { [key]: structuredClone(this.preferences) }; },
    async set(entries) {
      this.preferences = structuredClone(Object.values(entries)[0]);
    },
  };
}

function fakeNative(responses) {
  const queue = [...responses];
  return {
    requests: [],
    async request(type, payload) {
      this.requests.push({ type, payload: structuredClone(payload) });
      if (queue.length === 0) throw new Error('missing native response');
      return structuredClone(queue.shift());
    },
  };
}

test('mostra pasta atual e persiste o checkbox', async () => {
  const view = fakeView();
  const storageLocal = fakeStorage({
    schemaVersion: 2,
    askEveryTime: true,
    defaultFolder: String.raw`D:\Vídeos`,
  });
  const nativeClient = fakeNative([{
    type: 'ready',
    requestId: 'ping-1',
    protocolVersion: 3,
    nativeName: 'com.videoradar.helper',
    defaultFolder: String.raw`C:\Users\Carlos\Downloads\Video Radar`,
  }]);
  const controller = createOptionsController({ view, storageLocal, nativeClient });

  await controller.load();
  assert.equal(view.rendered.at(-1).effectiveFolder, String.raw`D:\Vídeos`);
  assert.equal(view.rendered.at(-1).askEveryTime, true);

  await controller.setAskEveryTime(false);
  assert.deepEqual(storageLocal.preferences, {
    schemaVersion: 2,
    askEveryTime: false,
    defaultFolder: String.raw`D:\Vídeos`,
  });
  assert.equal(view.statuses.at(-1).message, 'Configuração salva.');
});

test('altera pasta somente quando o seletor confirma', async () => {
  const view = fakeView();
  const storageLocal = fakeStorage({
    schemaVersion: 2,
    askEveryTime: false,
    defaultFolder: null,
  });
  const nativeClient = fakeNative([
    { type: 'folderSelectionCancelled', requestId: 'folder-1' },
    {
      type: 'folderSelected',
      requestId: 'folder-2',
      path: String.raw`E:\Cursos`,
    },
  ]);
  const controller = createOptionsController({ view, storageLocal, nativeClient });

  await controller.chooseFolder();
  assert.equal(storageLocal.preferences.defaultFolder, null);
  assert.equal(view.statuses.at(-1).message, 'Seleção cancelada.');

  await controller.chooseFolder();
  assert.equal(storageLocal.preferences.defaultFolder, String.raw`E:\Cursos`);
  assert.equal(view.rendered.at(-1).effectiveFolder, String.raw`E:\Cursos`);
});

test('ping indisponível mantém o checkbox utilizável', async () => {
  const view = fakeView();
  const storageLocal = fakeStorage({
    schemaVersion: 2,
    askEveryTime: true,
    defaultFolder: null,
  });
  const nativeClient = {
    async request() { throw new Error('helper offline'); },
  };
  const controller = createOptionsController({ view, storageLocal, nativeClient });

  await controller.load();
  assert.equal(view.rendered.at(-1).effectiveFolder, null);
  assert.equal(view.rendered.at(-1).helperAvailable, false);
  assert.equal(view.statuses.at(-1).error, true);

  await controller.setAskEveryTime(false);
  assert.equal(storageLocal.preferences.askEveryTime, false);
});
