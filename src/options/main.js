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

  return Object.freeze({ load, setAskEveryTime, chooseFolder });
}

function createDomView({ folder, askEveryTime, status }) {
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
  if (!folder || !chooseFolder || !askEveryTime || !status
    || !chromeApi?.storage?.local || !chromeApi?.runtime?.connectNative) return;

  const nativeClient = createNativePortClient({
    connectNative: (name) => chromeApi.runtime.connectNative(name),
    onEvent() {},
  });
  const view = createDomView({ folder, askEveryTime, status });
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

  void controller.load();
  return controller;
}

if (typeof document !== 'undefined' && typeof chrome !== 'undefined') bootOptions();
