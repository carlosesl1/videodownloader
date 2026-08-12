import assert from 'node:assert/strict';
import test from 'node:test';

import { createOptionsController } from '../src/options/main.js';

function fakeView() {
  return {
    rendered: [],
    statuses: [],
    diagnostics: [],
    diagnosticStatuses: [],
    diagnosticPaths: [],
    render(value) { this.rendered.push(structuredClone(value)); },
    status(message, error = false) { this.statuses.push({ message, error }); },
    renderDiagnostics(value) { this.diagnostics.push(structuredClone(value)); },
    diagnosticStatus(message, error = false) {
      this.diagnosticStatuses.push({ message, error });
    },
    renderDiagnosticPath(value) { this.diagnosticPaths.push(value); },
  };
}

function diagnosticsEvent(overrides = {}) {
  return {
    type: 'diagnostics',
    requestId: 'diagnostics-1',
    generatedAt: '2026-08-12T12:00:00Z',
    hostVersion: '1.2.0',
    protocolVersion: 5,
    architecture: 'x64',
    operatingSystem: 'Microsoft Windows 11',
    availableBytes: 1000,
    loggingEnabled: false,
    logFileCount: 0,
    tools: [],
    ...overrides,
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
  const nativeClient = fakeNative([
    {
      type: 'ready',
      requestId: 'ping-1',
      protocolVersion: 5,
      nativeName: 'com.videoradar.helper',
      hostVersion: '1.1.0',
      capabilities: ['idempotentStart', 'idempotentMove'],
      defaultFolder: String.raw`C:\Users\Carlos\Downloads\Video Radar`,
    },
    diagnosticsEvent(),
  ]);
  const controller = createOptionsController({ view, storageLocal, nativeClient });

  await controller.load();
  assert.equal(view.rendered.at(-1).effectiveFolder, String.raw`D:\Vídeos`);
  assert.equal(view.rendered.at(-1).askEveryTime, true);
  assert.equal(view.diagnostics.at(-1).hostVersion, '1.2.0');

  await controller.setAskEveryTime(false);
  assert.deepEqual(storageLocal.preferences, {
    schemaVersion: 2,
    askEveryTime: false,
    defaultFolder: String.raw`D:\Vídeos`,
  });
  assert.equal(view.statuses.at(-1).message, 'Configuração salva.');
});

test('ativa, exporta e limpa diagnósticos somente por ação explícita', async () => {
  const view = fakeView();
  const storageLocal = fakeStorage({
    schemaVersion: 2,
    askEveryTime: false,
    defaultFolder: null,
  });
  const exportPath = String.raw`D:\Suporte\VideoRadar-Diagnostics-20260812.zip`;
  const nativeClient = fakeNative([
    diagnosticsEvent({ loggingEnabled: true }),
    { type: 'folderSelected', requestId: 'folder-1', path: String.raw`D:\Suporte` },
    { type: 'diagnosticsExported', requestId: 'export-1', path: exportPath },
    { type: 'diagnosticsCleared', requestId: 'clear-1' },
    diagnosticsEvent({ loggingEnabled: true, logFileCount: 0 }),
  ]);
  const controller = createOptionsController({ view, storageLocal, nativeClient });

  await controller.setDiagnosticsEnabled(true);
  assert.equal(view.diagnostics.at(-1).loggingEnabled, true);
  assert.equal(view.diagnosticStatuses.at(-1).message, 'Registro local ativado.');

  assert.equal(await controller.exportDiagnostics(), exportPath);
  assert.equal(view.diagnosticPaths.at(-1), exportPath);

  await controller.clearDiagnostics();
  assert.equal(view.diagnosticPaths.at(-1), null);
  assert.deepEqual(nativeClient.requests.map(({ type }) => type), [
    'setDiagnostics',
    'chooseDownloadFolder',
    'exportDiagnostics',
    'clearDiagnostics',
    'getDiagnostics',
  ]);
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
