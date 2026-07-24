import { normalizeJobView } from '../youtube/job-view.js';

const ERROR_MESSAGES = Object.freeze({
  PERMISSION_DENIED: 'Autorize o acesso ao servidor de mídia para continuar.',
  BACKGROUND_PERMISSION_BUSY: 'A autorização expirou. Autorize o servidor de mídia novamente.',
  HLS_ENCRYPTED: 'Esta playlist usa criptografia não suportada.',
  HLS_FMP4: 'Esta playlist usa segmentos fMP4, não suportados nesta versão.',
  HLS_BYTERANGE: 'Esta playlist usa intervalos de bytes não suportados.',
  HLS_LIVE: 'Transmissões HLS ao vivo não são suportadas nesta versão.',
  HLS_TOO_LARGE: 'O vídeo ultrapassa o limite seguro de 1 GiB para HLS.',
  HLS_TIMEOUT: 'Um segmento demorou demais para responder. Tente novamente.',
  HLS_BUSY: 'Aguarde o outro vídeo HLS terminar e tente novamente.',
  HLS_NETWORK: 'Não foi possível acessar todos os segmentos. Tente novamente.',
  HLS_PERMISSION: 'Este vídeo usa outro servidor de mídia. Autorize-o para continuar.',
  SCAN_FAILED: 'Não foi possível analisar esta aba. Recarregue a página e tente novamente.',
  NATIVE_DISCONNECTED: 'O auxiliar de download foi desconectado. Reconecte-o e tente novamente.',
  NATIVE_JOB_MISSING: 'O download não foi encontrado no auxiliar. Tente novamente.',
  NATIVE_JOB_MISMATCH: 'O download aberto não corresponde a esta solicitação. Tente novamente.',
  YOUTUBE_BUSY: 'Aguarde o download do YouTube em andamento terminar.',
  YOUTUBE_METADATA: 'Não foi possível ler as qualidades deste vídeo do YouTube. Tente novamente.',
  YOUTUBE_DOWNLOAD: 'Não foi possível iniciar o download do YouTube. Tente novamente.',
  INVALID_URL: 'Esta URL do YouTube não é válida. Abra um vídeo e tente novamente.',
});

const ACTIVE_OPERATION_STATES = new Set(['starting', 'assembling', 'assembled']);

export const initialState = Object.freeze({
  status: 'idle',
  target: '',
  items: [],
  busyId: null,
  message: '',
  pendingPermission: null,
});

export function userMessageForError(code) {
  return ERROR_MESSAGES[code] ?? 'Não foi possível concluir a operação. Tente novamente.';
}

function formatByteSize(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const fractionDigits = unitIndex === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  const rounded = Number(value.toFixed(fractionDigits));
  return `${String(rounded).replace('.', ',')} ${units[unitIndex]}`;
}

function hlsSizeLabel(progress, completedSegments, totalSegments) {
  const bytesReceived = progress?.bytesReceived;
  if (!Number.isSafeInteger(bytesReceived) || bytesReceived <= 0) return '';
  const receivedLabel = formatByteSize(bytesReceived);
  const estimated = progress?.estimatedTotalBytes;
  if (
    completedSegments === totalSegments
    && totalSegments > 0
  ) return receivedLabel;
  if (!Number.isSafeInteger(estimated) || estimated < bytesReceived) {
    return `${receivedLabel} baixados`;
  }
  return `${receivedLabel} de ~${formatByteSize(estimated)}`;
}

function updateItem(items, id, update) {
  return items.map((item) => item.id === id ? { ...item, ...update(item) } : item);
}

function updateOperation(items, operationId, record) {
  return items.map((item) => {
    if (item.operationId !== operationId) return item;
    return { ...item, ...operationView(record) };
  });
}

function operationView(record) {
  if (ACTIVE_OPERATION_STATES.has(record?.state)) {
    const progress = Number.isFinite(record.progress?.percent)
      ? Math.max(0, Math.min(100, Math.floor(record.progress.percent)))
      : 0;
    const completedSegments = Number.isSafeInteger(record.progress?.completedSegments)
      ? record.progress.completedSegments
      : 0;
    const totalSegments = Number.isSafeInteger(record.progress?.totalSegments)
      ? record.progress.totalSegments
      : 0;
    const segmentLabel = totalSegments > 0
      ? `Baixando segmentos… ${progress}% · ${completedSegments}/${totalSegments}`
      : 'Preparando a playlist…';
    const sizeLabel = hlsSizeLabel(record.progress, completedSegments, totalSegments);
    return {
      phase: 'preparing',
      progress,
      completedSegments,
      totalSegments,
      statusLabel: sizeLabel ? `${segmentLabel} · ${sizeLabel}` : segmentLabel,
    };
  }
  if (record?.state === 'downloading') {
    return { phase: 'sent', statusLabel: 'Download enviado ao Chrome' };
  }
  if (record?.state === 'complete') {
    return { phase: 'complete', statusLabel: 'Download concluído' };
  }
  if (record?.state === 'interrupted') {
    return { phase: 'error', statusLabel: 'O download foi interrompido. Tente novamente.' };
  }
  if (record?.state === 'failed') {
    return {
      phase: 'error',
      statusLabel: userMessageForError(record.error?.code),
      error: record.error,
    };
  }
  return {};
}

function currentBusyId(items) {
  return items.find((item) => item.phase === 'preparing')?.id ?? null;
}

function youtubeFilename(title, format) {
  return `${title}-${format.label}.${format.container}`;
}

function youtubeView(snapshot, existing) {
  const view = normalizeJobView({
    jobId: snapshot.jobId,
    videoId: snapshot.videoId,
    title: snapshot.title,
    height: snapshot.height,
    stage: snapshot.stage,
    percent: snapshot.percent,
    path: snapshot.path,
    errorCode: snapshot.error,
  });
  const persistedVariant = {
    ...snapshot.format,
    filename: youtubeFilename(snapshot.title, snapshot.format),
  };
  const variants = existing?.kind === 'youtube' && existing.variants?.length
    ? existing.variants.map((variant) => variant.height === snapshot.format.height ? persistedVariant : variant)
    : [persistedVariant];
  const selectedIndex = Math.max(0, variants.findIndex((variant) => variant.height === snapshot.format.height));
  const selected = variants[selectedIndex] ?? persistedVariant;
  return {
    id: `youtube:${snapshot.videoId}`,
    kind: 'youtube', url: snapshot.url, title: snapshot.title, filename: selected.filename,
    variants, selectedIndex, predictedFormat: selected.container,
    phase: view.stage, jobId: snapshot.jobId, active: view.active, progress: view.percent,
    statusLabel: snapshot.stage === 'failed' && snapshot.error ? userMessageForError(snapshot.error) : view.statusLabel,
    path: view.path, error: snapshot.error, format: { ...snapshot.format },
    downloadedBytes: snapshot.downloadedBytes, totalBytes: snapshot.totalBytes,
    speedBytesPerSecond: snapshot.speedBytesPerSecond, etaSeconds: snapshot.etaSeconds,
    updatedAt: snapshot.updatedAt,
  };
}

export function reduceState(state, event) {
  if (event.type === 'SCAN_STARTED') {
    return {
      ...state,
      status: 'scanning',
      target: '',
      items: [],
      busyId: null,
      pendingPermission: null,
      message: 'Analisando a página…',
    };
  }

  if (event.type === 'SCAN_SUCCEEDED') {
    const hasItems = event.items.length > 0;
    return {
      ...state,
      status: hasItems ? 'results' : 'empty',
      target: event.target ?? '',
      items: event.items,
      busyId: null,
      pendingPermission: null,
      message: hasItems
        ? `${event.items.length} ${event.items.length === 1 ? 'vídeo encontrado' : 'vídeos encontrados'}`
        : 'Nenhum vídeo direto ou HLS foi encontrado. Reproduza o vídeo e busque novamente.',
    };
  }

  if (event.type === 'DOWNLOAD_STARTED') {
    const items = updateItem(state.items, event.id, () => ({
      selectedIndex: event.selectedIndex ?? 0,
      phase: 'preparing',
      progress: 0,
      completedSegments: 0,
      totalSegments: 0,
      statusLabel: 'Preparando a playlist…',
      error: undefined,
    }));
    return { ...state, items, busyId: event.id };
  }

  if (event.type === 'HLS_INSPECTED') {
    const items = updateItem(state.items, event.id, () => ({
      inspected: true,
      variants: event.variants,
      allowedOrigins: event.allowedOrigins,
      selectedIndex: 0,
      phase: 'ready',
      statusLabel: `${event.variants.length} ${event.variants.length === 1 ? 'qualidade encontrada' : 'qualidades encontradas'}`,
      error: undefined,
    }));
    return {
      ...state,
      items,
      busyId: currentBusyId(items),
      message: `${event.variants.length} ${event.variants.length === 1 ? 'qualidade encontrada' : 'qualidades encontradas'}`,
    };
  }

  if (event.type === 'QUALITY_SELECTED') {
    return {
      ...state,
      items: updateItem(state.items, event.id, (item) => {
        const selected = item.variants[event.selectedIndex];
        return {
          selectedIndex: event.selectedIndex,
          filename: selected?.filename ?? item.filename,
          ...(item.kind === 'youtube' && selected ? { predictedFormat: selected.container } : {}),
        };
      }),
    };
  }

  if (event.type === 'HLS_QUEUED') {
    const items = updateItem(state.items, event.id, () => ({
      operationId: event.operationId,
      selectedIndex: event.selectedIndex,
      phase: 'preparing',
      progress: 0,
      completedSegments: 0,
      totalSegments: 0,
      statusLabel: 'Preparando a playlist…',
      error: undefined,
    }));
    return { ...state, items, busyId: event.id, pendingPermission: null };
  }

  if (event.type === 'HLS_OPERATION_RECONCILED') {
    const items = updateItem(state.items, event.id, () => ({
      operationId: event.record.operationId,
      selectedIndex: event.selectedIndex,
      ...operationView(event.record),
    }));
    return { ...state, items, busyId: currentBusyId(items) };
  }

  if (event.type === 'HLS_OPERATION_UPDATED') {
    const items = updateOperation(state.items, event.operationId, event.record);
    return { ...state, items, busyId: currentBusyId(items) };
  }

  if (event.type === 'PERMISSION_REQUIRED') {
    const items = updateItem(state.items, event.id, () => ({
      phase: 'permission',
      selectedIndex: event.selectedIndex,
      statusLabel: ERROR_MESSAGES.HLS_PERMISSION,
    }));
    return {
      ...state,
      items,
      busyId: currentBusyId(items),
      pendingPermission: {
        id: event.id,
        selectedIndex: event.selectedIndex,
        origins: event.origins,
      },
      message: 'Autorize o servidor de mídia para continuar.',
    };
  }

  if (event.type === 'DIRECT_SENT') {
    const items = updateItem(state.items, event.id, () => ({
      selectedIndex: event.selectedIndex,
      phase: 'sent',
      statusLabel: 'Download enviado ao Chrome',
      error: undefined,
    }));
    return { ...state, items, busyId: currentBusyId(items), message: 'Download enviado ao Chrome' };
  }

  if (event.type === 'YOUTUBE_FORMATS_LOADED') {
    return {
      ...state,
      status: 'results', target: event.target ?? 'youtube.com', items: [event.item], busyId: null,
      pendingPermission: null, message: '1 vídeo encontrado',
    };
  }

  if (event.type === 'YOUTUBE_JOB_RESTORED') {
    if (!event.snapshot) return state;
    const item = youtubeView(event.snapshot, state.items.find((entry) => entry.id === `youtube:${event.snapshot.videoId}`));
    const items = [...state.items.filter((entry) => entry.id !== item.id), item];
    return {
      ...state,
      status: 'results', target: 'youtube.com', items,
      busyId: item.active ? item.id : currentBusyId(items), message: '1 vídeo encontrado',
    };
  }

  if (event.type === 'YOUTUBE_JOB_UPDATED') {
    if (!event.snapshot) return state;
    const existing = state.items.find((entry) => entry.kind === 'youtube' && entry.jobId === event.snapshot.jobId)
      ?? state.items.find((entry) => entry.id === `youtube:${event.snapshot.videoId}`);
    const item = youtubeView(event.snapshot, existing);
    const items = existing
      ? state.items.map((entry) => entry === existing ? item : entry)
      : [...state.items, item];
    return {
      ...state,
      status: 'results', target: state.target || 'youtube.com', items,
      busyId: item.active ? item.id : currentBusyId(items),
      message: state.message || '1 vídeo encontrado',
    };
  }

  if (event.type === 'FAILED') {
    const errorMessage = userMessageForError(event.code);
    if (event.id) {
      const items = updateItem(state.items, event.id, () => ({
        phase: 'error',
        statusLabel: errorMessage,
        error: { code: event.code, details: event.details ?? {} },
      }));
      return {
        ...state,
        items,
        busyId: currentBusyId(items),
        pendingPermission: state.pendingPermission?.id === event.id ? null : state.pendingPermission,
        message: errorMessage,
      };
    }
    return {
      ...state,
      status: state.items.length ? 'results' : 'error',
      busyId: null,
      message: errorMessage,
    };
  }

  return state;
}
