import {
  DEFAULT_DOWNLOAD_PREFERENCES,
  DOWNLOAD_PREFERENCES_KEY,
  normalizeDownloadPreferences,
  validateDownloadPreferences,
} from '../shared/download-preferences.js';

export function bootOptions({
  chromeApi = globalThis.chrome,
  documentApi = globalThis.document,
} = {}) {
  const form = documentApi.querySelector('#download-preferences');
  const subfolder = documentApi.querySelector('#subfolder');
  const automatic = documentApi.querySelector('#automatic');
  const preview = documentApi.querySelector('#path-preview');
  const status = documentApi.querySelector('#save-status');
  if (!form || !subfolder || !automatic || !preview || !status || !chromeApi?.storage?.local) return;

  function updatePreview() {
    const folder = subfolder.value.trim().replaceAll('\\', '/');
    preview.textContent = folder
      ? `Destino: Downloads / ${folder}`
      : 'Destino: pasta Downloads padrão';
  }

  async function load() {
    let preferences = DEFAULT_DOWNLOAD_PREFERENCES;
    try {
      const stored = await chromeApi.storage.local.get(DOWNLOAD_PREFERENCES_KEY);
      preferences = normalizeDownloadPreferences(stored?.[DOWNLOAD_PREFERENCES_KEY]);
    } catch {
      // Defaults keep the page usable if local storage is temporarily unavailable.
    }
    subfolder.value = preferences.subfolder;
    automatic.checked = preferences.automatic;
    updatePreview();
  }

  subfolder.addEventListener('input', updatePreview);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    status.textContent = '';
    delete status.dataset.error;
    try {
      const preferences = validateDownloadPreferences({
        subfolder: subfolder.value,
        automatic: automatic.checked,
      });
      await chromeApi.storage.local.set({ [DOWNLOAD_PREFERENCES_KEY]: preferences });
      subfolder.value = preferences.subfolder;
      updatePreview();
      status.textContent = 'Configuração salva.';
    } catch (error) {
      status.dataset.error = 'true';
      status.textContent = error instanceof Error
        ? error.message
        : 'Não foi possível salvar a configuração.';
    }
  });

  void load();
}

if (typeof document !== 'undefined' && typeof chrome !== 'undefined') bootOptions();
