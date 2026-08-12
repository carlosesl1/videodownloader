import {
  DOWNLOAD_PREFERENCES_KEY,
  readDownloadPreferences,
  validateDownloadPreferences,
} from '../shared/download-preferences.js';
import { createNativePortClient } from '../background/native-port.js';
import { HOST_COMMANDS, HOST_EVENTS } from '../youtube/protocol.js';

const HELPER_ERROR = 'Auxiliar indisponível. Reinstale o Video Radar Helper.';

export function createOptionsController({ view, storageLocal, nativeClient }) {
  if (typeof view?.render !== 'function'
    || typeof view?.status !== 'function'
    || typeof view?.renderDiagnostics !== 'function'
    || typeof view?.diagnosticStatus !== 'function'
    || typeof view?.renderDiagnosticPath !== 'function'
    || typeof storageLocal?.get !== 'function'
    || typeof storageLocal?.set !== 'function'
    || typeof nativeClient?.request !== 'function') {
    throw new TypeError('Dependências inválidas das configurações.');
  }

  let fallbackFolder = null;
  let helperAvailable = true;

  async function renderPreferences(preferences) {
    view.render({
      ...preferences,
      effectiveFolder: preferences.defaultFolder ?? fallbackFolder,
      helperAvailable,
    });
  }

  async function load() {
    const preferences = await readDownloadPreferences(storageLocal);
    try {
      const ready = await nativeClient.request(HOST_COMMANDS.PING, {});
      fallbackFolder = ready.defaultFolder;
      helperAvailable = true;
    } catch {
      fallbackFolder = null;
      helperAvailable = false;
      view.status(HELPER_ERROR, true);
      view.renderDiagnostics(null);
    }
    if (helperAvailable) {
      try {
        const diagnostics = await nativeClient.request(HOST_COMMANDS.GET_DIAGNOSTICS, {});
        view.renderDiagnostics(diagnostics);
      } catch {
        view.renderDiagnostics(null);
        view.diagnosticStatus('O diagnóstico exige a versão mais recente do auxiliar.', true);
      }
    }
    await renderPreferences(preferences);
  }

  async function persist(patch) {
    const current = await readDownloadPreferences(storageLocal);
    const next = validateDownloadPreferences({ ...current, ...patch });
    await storageLocal.set({ [DOWNLOAD_PREFERENCES_KEY]: next });
    await renderPreferences(next);
    view.status('Configuração salva.');
    return next;
  }

  async function setAskEveryTime(value) {
    return persist({ askEveryTime: value === true });
  }

  async function chooseFolder() {
    const result = await nativeClient.request(
      HOST_COMMANDS.CHOOSE_DOWNLOAD_FOLDER,
      {},
    );
    if (result.type === HOST_EVENTS.FOLDER_SELECTION_CANCELLED) {
      view.status('Seleção cancelada.');
      return null;
    }
    if (result.type !== HOST_EVENTS.FOLDER_SELECTED) {
      throw new Error('Resposta inválida do seletor de pasta.');
    }
    helperAvailable = true;
    return persist({ defaultFolder: result.path });
  }

  async function setDiagnosticsEnabled(value) {
    const diagnostics = await nativeClient.request(HOST_COMMANDS.SET_DIAGNOSTICS, {
      enabled: value === true,
    });
    view.renderDiagnostics(diagnostics);
    view.diagnosticStatus(value === true
      ? 'Registro local ativado.'
      : 'Registro local desativado.');
    return diagnostics;
  }

  async function exportDiagnostics() {
    const selection = await nativeClient.request(HOST_COMMANDS.CHOOSE_DOWNLOAD_FOLDER, {});
    if (selection.type === HOST_EVENTS.FOLDER_SELECTION_CANCELLED) {
      view.diagnosticStatus('Exportação cancelada.');
      return null;
    }
    if (selection.type !== HOST_EVENTS.FOLDER_SELECTED) {
      throw new Error('Resposta inválida do seletor de pasta.');
    }
    const exported = await nativeClient.request(HOST_COMMANDS.EXPORT_DIAGNOSTICS, {
      destinationFolder: selection.path,
    });
    view.renderDiagnosticPath(exported.path);
    view.diagnosticStatus('Pacote de diagnóstico exportado.');
    return exported.path;
  }

  async function clearDiagnostics() {
    await nativeClient.request(HOST_COMMANDS.CLEAR_DIAGNOSTICS, {});
    const diagnostics = await nativeClient.request(HOST_COMMANDS.GET_DIAGNOSTICS, {});
    view.renderDiagnostics(diagnostics);
    view.renderDiagnosticPath(null);
    view.diagnosticStatus('Registros locais apagados.');
    return diagnostics;
  }

  return Object.freeze({
    load,
    setAskEveryTime,
    chooseFolder,
    setDiagnosticsEnabled,
    exportDiagnostics,
    clearDiagnostics,
  });
}

function formatBytes(value) {
  if (!Number.isSafeInteger(value) || value < 0) return 'Não disponível';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${amount.toLocaleString('pt-BR', { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${units[unit]}`;
}

function createDomView({
  folder,
  askEveryTime,
  status,
  diagnosticsHost,
  diagnosticsArchitecture,
  diagnosticsSpace,
  diagnosticsLogCount,
  diagnosticsTools,
  diagnosticsEnabled,
  diagnosticsStatus,
  diagnosticsPath,
}) {
  return {
    render(value) {
      folder.textContent = value.effectiveFolder ?? 'Auxiliar indisponível';
      askEveryTime.checked = value.askEveryTime;
      folder.dataset.unavailable = value.helperAvailable ? 'false' : 'true';
    },
    status(message, error = false) {
      status.textContent = message;
      if (error) status.dataset.error = 'true';
      else delete status.dataset.error;
    },
    renderDiagnostics(value) {
      diagnosticsTools.replaceChildren();
      if (!value) {
        diagnosticsHost.textContent = 'Auxiliar indisponível';
        diagnosticsArchitecture.textContent = '—';
        diagnosticsSpace.textContent = '—';
        diagnosticsLogCount.textContent = '—';
        diagnosticsEnabled.checked = false;
        diagnosticsEnabled.disabled = true;
        return;
      }
      diagnosticsHost.textContent = `v${value.hostVersion} · protocolo ${value.protocolVersion}`;
      diagnosticsArchitecture.textContent = value.architecture.toUpperCase();
      diagnosticsSpace.textContent = formatBytes(value.availableBytes);
      diagnosticsLogCount.textContent = `${value.logFileCount} de 8 arquivos`;
      diagnosticsEnabled.checked = value.loggingEnabled;
      diagnosticsEnabled.disabled = false;
      for (const tool of value.tools) {
        const item = diagnosticsTools.ownerDocument.createElement('li');
        item.dataset.available = tool.available ? 'true' : 'false';
        const label = diagnosticsTools.ownerDocument.createElement('span');
        label.textContent = tool.name.replace(/\.exe$/i, '');
        const health = diagnosticsTools.ownerDocument.createElement('strong');
        health.textContent = tool.available ? (tool.version ?? 'Disponível') : 'Ausente';
        item.append(label, health);
        diagnosticsTools.append(item);
      }
    },
    diagnosticStatus(message, error = false) {
      diagnosticsStatus.textContent = message;
      if (error) diagnosticsStatus.dataset.error = 'true';
      else delete diagnosticsStatus.dataset.error;
    },
    renderDiagnosticPath(path) {
      diagnosticsPath.textContent = path ?? '';
    },
  };
}

export function bootOptions({
  chromeApi = globalThis.chrome,
  documentApi = globalThis.document,
} = {}) {
  const folder = documentApi?.querySelector('#default-folder');
  const chooseFolder = documentApi?.querySelector('#choose-folder');
  const askEveryTime = documentApi?.querySelector('#ask-every-time');
  const status = documentApi?.querySelector('#save-status');
  const diagnosticsHost = documentApi?.querySelector('#diagnostics-host');
  const diagnosticsArchitecture = documentApi?.querySelector('#diagnostics-architecture');
  const diagnosticsSpace = documentApi?.querySelector('#diagnostics-space');
  const diagnosticsLogCount = documentApi?.querySelector('#diagnostics-log-count');
  const diagnosticsTools = documentApi?.querySelector('#diagnostics-tools');
  const diagnosticsEnabled = documentApi?.querySelector('#diagnostics-enabled');
  const exportDiagnostics = documentApi?.querySelector('#export-diagnostics');
  const clearDiagnostics = documentApi?.querySelector('#clear-diagnostics');
  const diagnosticsStatus = documentApi?.querySelector('#diagnostics-status');
  const diagnosticsPath = documentApi?.querySelector('#diagnostics-path');
  if (!folder || !chooseFolder || !askEveryTime || !status
    || !diagnosticsHost || !diagnosticsArchitecture || !diagnosticsSpace
    || !diagnosticsLogCount || !diagnosticsTools || !diagnosticsEnabled
    || !exportDiagnostics || !clearDiagnostics || !diagnosticsStatus || !diagnosticsPath
    || !chromeApi?.storage?.local || !chromeApi?.runtime?.connectNative) return;

  const nativeClient = createNativePortClient({
    connectNative: (name) => chromeApi.runtime.connectNative(name),
    onEvent() {},
  });
  const view = createDomView({
    folder,
    askEveryTime,
    status,
    diagnosticsHost,
    diagnosticsArchitecture,
    diagnosticsSpace,
    diagnosticsLogCount,
    diagnosticsTools,
    diagnosticsEnabled,
    diagnosticsStatus,
    diagnosticsPath,
  });
  const controller = createOptionsController({
    view,
    storageLocal: chromeApi.storage.local,
    nativeClient,
  });

  askEveryTime.addEventListener('change', () => {
    void controller.setAskEveryTime(askEveryTime.checked).catch(() => {
      view.status('Não foi possível salvar a configuração.', true);
    });
  });
  chooseFolder.addEventListener('click', () => {
    chooseFolder.disabled = true;
    void controller.chooseFolder()
      .catch(() => view.status(HELPER_ERROR, true))
      .finally(() => { chooseFolder.disabled = false; });
  });
  diagnosticsEnabled.addEventListener('change', () => {
    diagnosticsEnabled.disabled = true;
    void controller.setDiagnosticsEnabled(diagnosticsEnabled.checked)
      .catch(() => view.diagnosticStatus(HELPER_ERROR, true))
      .finally(() => { diagnosticsEnabled.disabled = false; });
  });
  exportDiagnostics.addEventListener('click', () => {
    exportDiagnostics.disabled = true;
    void controller.exportDiagnostics()
      .catch(() => view.diagnosticStatus('Não foi possível exportar o diagnóstico.', true))
      .finally(() => { exportDiagnostics.disabled = false; });
  });
  clearDiagnostics.addEventListener('click', () => {
    clearDiagnostics.disabled = true;
    void controller.clearDiagnostics()
      .catch(() => view.diagnosticStatus('Não foi possível apagar os registros.', true))
      .finally(() => { clearDiagnostics.disabled = false; });
  });

  void controller.load();
  return controller;
}

if (typeof document !== 'undefined' && typeof chrome !== 'undefined') bootOptions();
