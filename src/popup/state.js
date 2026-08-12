import { normalizeJobView } from '../youtube/job-view.js';
import { canonicalMediaPage } from '../media/page-url.js';

const ERROR_MESSAGES = Object.freeze({
  SCAN_INTERRUPTED: 'A busca foi interrompida pelo navegador. Clique em Buscar novamente.',
  PERMISSION_DENIED: 'Autorize o acesso ao servidor de mídia para continuar.',
  BACKGROUND_PERMISSION_BUSY: 'A autorização expirou. Autorize o servidor de mídia novamente.',
  HLS_ENCRYPTED: 'Esta playlist usa criptografia não suportada.',
  HLS_FMP4: 'Esta playlist usa segmentos fMP4, não suportados nesta versão.',
  HLS_BYTERANGE: 'Esta playlist usa intervalos de bytes não suportados.',
  HLS_SEPARATE_AUDIO: 'Esta qualidade usa áudio separado e não pode ser salva com segurança nesta versão.',
  HLS_LIVE: 'Transmissões HLS ao vivo não são suportadas nesta versão.',
  HLS_MANIFEST_TOO_LARGE: 'A playlist HLS ultrapassa os limites seguros de análise.',
  HLS_VARIANT_LIMIT: 'A playlist HLS anuncia qualidades demais para processar com segurança.',
  HLS_SEGMENT_LIMIT: 'A playlist HLS contém segmentos demais para processar com segurança.',
  HLS_DURATION_LIMIT: 'O vídeo HLS ultrapassa a duração máxima segura.',
  HLS_TOO_LARGE: 'O vídeo ultrapassa o limite seguro de 256 MiB para HLS.',
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
  YOUTUBE_METADATA_TIMEOUT: 'O YouTube demorou demais para responder. Tente novamente.',
  YOUTUBE_DOWNLOAD: 'Não foi possível iniciar o download do vídeo. Tente novamente.',
  INVALID_URL: 'Esta URL do YouTube não é válida. Abra um vídeo e tente novamente.',
  LOGIN_REQUIRED: 'A plataforma exigiu login para acessar este vídeo.',
  RATE_LIMITED: 'A plataforma limitou temporariamente as consultas. Tente novamente mais tarde.',
  FORMAT_UNAVAILABLE: 'A qualidade escolhida não está mais disponível. Busque o vídeo novamente.',
  MEDIA_ACCESS_DENIED: 'O servidor da plataforma recusou o arquivo. Busque o vídeo novamente ou tente mais tarde.',
  MEDIA_DOWNLOAD_FAILED: 'Não foi possível baixar o arquivo de vídeo. Tente novamente.',
  MEDIA_VALIDATION_FAILED: 'O arquivo baixado não passou pela validação final e foi descartado com segurança.',
  QUEUE_FULL: 'A fila está cheia. Aguarde ou cancele um download antes de adicionar outro.',
  INVALID_JOB_STATE: 'Este download não pode executar essa ação no estado atual.',
  JOB_NOT_FOUND: 'Este download não foi encontrado na fila.',
  JOB_OWNED_BY_ANOTHER_HOST: 'O download está sendo controlado por outra janela. Tente novamente em instantes.',
  PRIVATE_CONTENT: 'Este vídeo não está disponível publicamente.',
  NO_VIDEO: 'Este post não contém um vídeo compatível.',
  UNSUPPORTED_POST: 'Este tipo de publicação ainda não é compatível.',
  EXTRACTOR_CHANGED: 'A plataforma mudou e o auxiliar precisa ser atualizado.',
  DESTINATION_INVALID: 'A pasta de downloads não é válida. Configure outra pasta.',
  DESTINATION_NOT_CONFIGURED: 'Escolha uma pasta para salvar os downloads.',
  DESTINATION_MOVE_FAILED: 'Não foi possível mover o arquivo para a pasta escolhida.',
  DESTINATION_HELPER_UNAVAILABLE: 'O auxiliar de downloads não está disponível. Verifique a instalação.',
  HELPER_UNAVAILABLE: 'O auxiliar de downloads não está disponível. Verifique a instalação.',
  REVEAL_FAILED: 'Não foi possível mostrar o arquivo no Explorer. Tente novamente.',
});

const ACTIVE_OPERATION_STATES = new Set(['starting', 'assembling', 'assembled']);
const DESTINATION_ERRORS = new Set([
  'DESTINATION_INVALID',
  'DESTINATION_NOT_CONFIGURED',
  'DESTINATION_MOVE_FAILED',
  'DESTINATION_HELPER_UNAVAILABLE',
  'HELPER_UNAVAILABLE',
  'NATIVE_DISCONNECTED',
]);

export const initialState = Object.freeze({
  status: 'restoring',
  target: '',
  items: [],
  downloads: [],
  busyId: null,
  message: 'Restaurando downloads…',
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
    return { phase: 'sent', statusLabel: 'Download em andamento' };
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

function restoredHlsItem(record) {
  const filename = typeof record.filename === 'string' && record.filename.trim()
    ? record.filename
    : 'video.ts';
  return {
    id: `hls-operation:${record.operationId}`,
    kind: 'hls',
    url: record.url,
    filename,
    variants: [{
      url: record.url,
      label: 'Qualidade escolhida',
      filename,
    }],
    inspected: true,
    selectedIndex: 0,
    allowedOrigins: [],
    format: 'ts',
    operationId: record.operationId,
    ...operationView(record),
  };
}

function relocationView(record) {
  if (record.status === 'downloading') {
    return { phase: 'sent', statusLabel: 'Baixando…' };
  }
  if (record.status === 'moving') {
    return { phase: 'preparing', statusLabel: 'Movendo para a pasta escolhida…' };
  }
  if (record.status === 'complete') {
    return {
      phase: 'complete',
      finalPath: record.finalPath,
      statusLabel: `Salvo em ${record.finalPath}`,
    };
  }
  if (record.status === 'moveFailed') {
    return {
      phase: 'error',
      stagingPath: record.stagingPath,
      statusLabel: `Não foi possível mover. Arquivo preservado em ${record.stagingPath}`,
      error: { code: record.errorCode ?? 'DESTINATION_MOVE_FAILED' },
      action: 'open-download-settings',
    };
  }
  if (record.status === 'interrupted') {
    return {
      phase: 'error',
      stagingPath: record.stagingPath,
      statusLabel: record.stagingPath
        ? `Download interrompido. Arquivo parcial em ${record.stagingPath}`
        : 'O download foi interrompido. Tente novamente.',
      error: { code: record.errorCode ?? 'BROWSER_DOWNLOAD_INTERRUPTED' },
    };
  }
  return {};
}

function restoredRelocationItem(record) {
  return {
    id: `download:${record.downloadId}`,
    kind: record.mediaKind,
    url: record.mediaUrl,
    filename: record.displayName,
    variants: [{
      url: record.mediaUrl,
      label: 'Qualidade escolhida',
      filename: record.displayName,
    }],
    inspected: true,
    selectedIndex: 0,
    allowedOrigins: [],
    format: record.mediaKind === 'hls' ? 'ts' : 'vídeo',
    operationId: record.operationId,
    downloadId: record.downloadId,
    ...relocationView(record),
  };
}

function currentBusyId(items, downloads = []) {
  return [...items, ...downloads].find((item) => item.phase === 'preparing')?.id ?? null;
}

function updateStateItem(state, id, update) {
  if (state.items.some((item) => item.id === id)) {
    return { ...state, items: updateItem(state.items, id, update) };
  }
  return { ...state, downloads: updateItem(state.downloads ?? [], id, update) };
}

function updateStateOperation(state, operationId, record) {
  return {
    ...state,
    items: updateOperation(state.items, operationId, record),
    downloads: updateOperation(state.downloads ?? [], operationId, record),
  };
}

function youtubeFilename(title, format) {
  return `${title}-${format.label}.${format.container}`;
}

function youtubeView(snapshot, existing) {
  const page = canonicalMediaPage(snapshot.url);
  const platform = page?.platform ?? 'youtube';
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
  const matchesPersisted = (variant) => snapshot.format.height === 0
    ? variant.audioOnly === true || variant.height === 0
    : variant.height === snapshot.format.height;
  const variants = ['youtube', 'remote-media'].includes(existing?.kind) && existing.variants?.length
    ? existing.variants.map((variant) => matchesPersisted(variant)
      ? { ...variant, ...persistedVariant }
      : variant)
    : [persistedVariant];
  const selectedIndex = Math.max(0, variants.findIndex(matchesPersisted));
  const selected = variants[selectedIndex] ?? persistedVariant;
  return {
    id: `${platform}:${snapshot.videoId}`,
    kind: platform === 'youtube' ? 'youtube' : 'remote-media',
    platform, url: snapshot.url, title: snapshot.title, filename: selected.filename,
    variants, selectedIndex, predictedFormat: selected.container,
    phase: view.stage, jobId: snapshot.jobId, active: view.active, progress: view.percent,
    statusLabel: snapshot.stage === 'failed' && snapshot.error ? userMessageForError(snapshot.error) : view.statusLabel,
    path: view.path, error: snapshot.error, format: { ...snapshot.format },
    downloadedBytes: snapshot.downloadedBytes, totalBytes: snapshot.totalBytes,
    speedBytesPerSecond: snapshot.speedBytesPerSecond, etaSeconds: snapshot.etaSeconds,
    updatedAt: snapshot.updatedAt,
    ...(Array.isArray(existing?.subtitles) ? {
      subtitles: existing.subtitles.map((subtitle) => ({ ...subtitle })),
      selectedSubtitleIndex: existing.selectedSubtitleIndex ?? -1,
      audioLanguages: [...(existing.audioLanguages ?? [])],
    } : {}),
  };
}

function queueSelectionMatches(variant, selection) {
  if (variant?.selection) {
    return variant.selection.height === selection.height
      && variant.selection.audioOnly === selection.audioOnly;
  }
  return selection.audioOnly ? variant?.audioOnly === true : variant?.height === selection.height;
}

function queueJobView(job, existing) {
  const page = canonicalMediaPage(job.url);
  const platform = page?.platform ?? 'youtube';
  const format = job.selection.audioOnly
    ? { height: 0, label: 'Somente áudio', container: 'm4a', combined: false }
    : {
        height: job.selection.height,
        label: `${job.selection.height}p`,
        container: 'mp4',
        combined: false,
      };
  const fallbackVariant = {
    ...format,
    audioOnly: job.selection.audioOnly,
    selection: { ...job.selection },
    filename: job.selection.audioOnly
      ? `${job.title}-audio.m4a`
      : youtubeFilename(job.title, format),
  };
  const variants = ['youtube', 'remote-media'].includes(existing?.kind)
    && existing.variants?.length
    ? existing.variants.map((variant) => ({ ...variant }))
    : [fallbackVariant];
  let selectedIndex = variants.findIndex((variant) => queueSelectionMatches(variant, job.selection));
  if (selectedIndex < 0) {
    variants.push(fallbackVariant);
    selectedIndex = variants.length - 1;
  }
  variants[selectedIndex] = {
    ...variants[selectedIndex],
    selection: { ...job.selection },
  };
  const selected = variants[selectedIndex];
  const view = normalizeJobView({
    jobId: job.jobId,
    operationId: job.operationId,
    videoId: job.videoId,
    title: job.title,
    height: job.height,
    stage: job.stage,
    percent: job.percent,
    path: job.path,
    errorCode: job.error,
  });
  const nonterminal = ['queued', 'running', 'paused'].includes(job.state);
  const queuedLabel = job.position
    ? `Na fila · posição ${job.position}`
    : 'Na fila…';
  const statusLabel = job.state === 'queued'
    ? queuedLabel
    : job.state === 'paused'
      ? `${view.statusLabel}${job.resumePartial ? ' · progresso preservado' : ''}`
      : job.state === 'failed' && job.error
        ? userMessageForError(job.error)
        : view.statusLabel;
  const subtitles = Array.isArray(existing?.subtitles)
    ? existing.subtitles.map((subtitle) => ({ ...subtitle }))
    : null;
  const selectedSubtitleIndex = subtitles === null
    ? null
    : job.selection.subtitleLanguage === null
      ? -1
      : subtitles.findIndex((subtitle) => (
          subtitle.language.toLowerCase() === job.selection.subtitleLanguage.toLowerCase()
          && subtitle.automatic === job.selection.includeAutomaticSubtitles
        ));
  return {
    id: `media-job:${job.jobId}`,
    kind: platform === 'youtube' ? 'youtube' : 'remote-media',
    platform,
    url: job.url,
    title: job.title,
    filename: selected.filename ?? fallbackVariant.filename,
    variants,
    selectedIndex,
    predictedFormat: selected.container ?? format.container,
    phase: view.stage,
    jobId: job.jobId,
    operationId: job.operationId,
    active: nonterminal,
    progress: view.percent,
    statusLabel,
    path: view.path,
    error: job.error,
    format,
    selection: { ...job.selection },
    queueState: job.state,
    isQueueJob: true,
    position: job.position,
    resumePartial: job.resumePartial,
    attemptCount: job.attemptCount,
    downloadedBytes: job.downloadedBytes,
    totalBytes: job.totalBytes,
    speedBytesPerSecond: job.speedBytesPerSecond,
    etaSeconds: job.etaSeconds,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(subtitles === null ? {} : {
      subtitles,
      selectedSubtitleIndex: selectedSubtitleIndex >= 0 ? selectedSubtitleIndex : -1,
      audioLanguages: [...(existing.audioLanguages ?? [])],
    }),
  };
}

function pendingPlaceholderForJob(item, job) {
  if (item?.isQueueJob
    || !['youtube', 'remote-media'].includes(item?.kind)
    || item.phase !== 'preparing') return false;
  const itemPage = canonicalMediaPage(item.url);
  const jobPage = canonicalMediaPage(job.url);
  const selected = item.variants?.[item.selectedIndex ?? 0];
  return itemPage?.canonicalUrl === jobPage?.canonicalUrl
    && queueSelectionMatches(selected, job.selection);
}

function resetMediaPlaceholder(item) {
  const {
    operationId, format, selection, queueState, isQueueJob, position, resumePartial,
    attemptCount, downloadedBytes, totalBytes, speedBytesPerSecond, etaSeconds,
    createdAt, updatedAt, ...source
  } = item;
  const selected = source.variants?.[source.selectedIndex ?? 0];
  return {
    ...source,
    filename: selected?.filename ?? source.filename,
    jobId: null,
    phase: 'ready',
    active: false,
    progress: null,
    path: null,
    error: null,
    statusLabel: '',
  };
}

function mergeQueueJob(state, job) {
  const matches = (entry) => entry.jobId === job.jobId;
  const existingItem = state.items.find(matches);
  const existingDownload = (state.downloads ?? []).find(matches);
  const placeholder = existingItem?.isQueueJob
    ? null
    : existingItem ?? state.items.find((entry) => pendingPlaceholderForJob(entry, job));
  const item = queueJobView(job, existingDownload ?? existingItem ?? placeholder);
  const items = state.items
    .filter((entry) => entry !== existingItem || !existingItem?.isQueueJob)
    .map((entry) => entry === placeholder ? resetMediaPlaceholder(entry) : entry);
  const downloads = [
    ...(state.downloads ?? []).filter((entry) => !matches(entry)),
    item,
  ];
  return {
    ...state,
    status: state.status === 'restoring' ? 'restoring' : 'results',
    target: state.target || 'downloads',
    items,
    downloads,
    busyId: currentBusyId(items, downloads),
    message: item.active ? item.statusLabel : 'Download atualizado',
  };
}

export function reduceState(state, event) {
  if (event.type === 'RESTORE_COMPLETED') {
    if (state.status !== 'restoring') return state;
    const hasDownloads = (state.downloads ?? []).length > 0;
    return {
      ...state,
      status: hasDownloads ? 'results' : 'idle',
      target: hasDownloads ? 'downloads' : '',
      message: hasDownloads ? 'Downloads restaurados' : '',
    };
  }

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

  if (event.type === 'YOUTUBE_LOOKUP_STARTED' || event.type === 'MEDIA_LOOKUP_STARTED') {
    const target = event.target ?? 'youtube.com';
    const platformLabel = {
      'youtube.com': 'YouTube',
      'tiktok.com': 'TikTok',
      'instagram.com': 'Instagram',
      'x.com': 'X',
    }[target] ?? target.split('.')[0].replace(/^./, (letter) => letter.toUpperCase());
    return {
      ...state,
      status: 'scanning',
      target,
      items: [],
      busyId: null,
      pendingPermission: null,
      message: `Carregando qualidades do ${platformLabel}…`,
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

  if (event.type === 'DOWNLOAD_STARTED' || event.type === 'MEDIA_DOWNLOAD_STARTED') {
    const next = updateStateItem(state, event.id, (item) => {
      const hls = event.kind === 'hls' || item.kind === 'hls';
      return {
        selectedIndex: event.selectedIndex ?? 0,
        phase: 'preparing',
        active: false,
        progress: hls ? 0 : null,
        completedSegments: hls ? 0 : undefined,
        totalSegments: hls ? 0 : undefined,
        statusLabel: hls ? 'Preparando a playlist…' : 'Iniciando download…',
        error: undefined,
      };
    });
    return { ...next, busyId: event.id };
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
    return updateStateItem(state, event.id, (item) => {
      if (item.active || ['permission', 'preparing', 'sent'].includes(item.phase)) return {};
      const selected = item.variants[event.selectedIndex];
      if (!selected) return {};
      return {
        selectedIndex: event.selectedIndex,
        filename: selected.filename ?? item.filename,
        ...(['youtube', 'remote-media'].includes(item.kind) ? { predictedFormat: selected.container } : {}),
      };
    });
  }

  if (event.type === 'SUBTITLE_SELECTED') {
    return updateStateItem(state, event.id, (item) => {
      if (item.active || ['permission', 'preparing', 'sent'].includes(item.phase)) return {};
      const selectedIndex = event.selectedIndex;
      if (!Number.isSafeInteger(selectedIndex)
        || selectedIndex < -1
        || selectedIndex >= (item.subtitles?.length ?? 0)) return {};
      return { selectedSubtitleIndex: selectedIndex };
    });
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
    const deduplicated = state.items.filter((item) => (
      item.id === event.id || item.operationId !== event.record.operationId
    ));
    const items = updateItem(deduplicated, event.id, () => ({
      operationId: event.record.operationId,
      selectedIndex: event.selectedIndex,
      ...operationView(event.record),
    }));
    const downloads = (state.downloads ?? []).filter((item) => item.operationId !== event.record.operationId);
    return { ...state, items, downloads, busyId: currentBusyId(items, downloads) };
  }

  if (event.type === 'HLS_OPERATION_UPDATED') {
    const next = updateStateOperation(state, event.operationId, event.record);
    return { ...next, busyId: currentBusyId(next.items, next.downloads) };
  }

  if (event.type === 'HLS_OPERATION_RESTORED') {
    const restored = restoredHlsItem(event.record);
    const existingItem = state.items.find((item) => item.operationId === event.record.operationId);
    if (existingItem) {
      const items = state.items.map((item) => item === existingItem
        ? { ...item, ...operationView(event.record) }
        : item);
      return { ...state, items, busyId: currentBusyId(items, state.downloads) };
    }
    const downloads = [
      ...(state.downloads ?? []).filter((item) => item.operationId !== event.record.operationId),
      restored,
    ];
    return {
      ...state,
      status: state.status === 'restoring' ? 'restoring' : 'results',
      target: state.target || 'downloads',
      downloads,
      busyId: currentBusyId(state.items, downloads),
      message: restored.phase === 'complete'
        ? 'Download concluído'
        : restored.phase === 'error' ? restored.statusLabel : 'Download em andamento',
    };
  }

  if (event.type === 'PERMISSION_REQUIRED') {
    const next = updateStateItem(state, event.id, () => ({
      phase: 'permission',
      selectedIndex: event.selectedIndex,
      statusLabel: ERROR_MESSAGES.HLS_PERMISSION,
    }));
    return {
      ...next,
      busyId: currentBusyId(next.items, next.downloads),
      pendingPermission: {
        id: event.id,
        selectedIndex: event.selectedIndex,
        origins: event.origins,
      },
      message: 'Autorize o servidor de mídia para continuar.',
    };
  }

  if (event.type === 'DIRECT_SENT') {
    const next = updateStateItem(state, event.id, () => ({
      selectedIndex: event.selectedIndex,
      downloadId: event.downloadId,
      phase: 'sent',
      statusLabel: 'Download iniciado',
      error: undefined,
    }));
    return {
      ...next,
      busyId: currentBusyId(next.items, next.downloads),
      message: 'Download iniciado',
    };
  }

  if (event.type === 'DOWNLOAD_RELOCATION_UPDATED') {
    const record = event.record;
    const matches = (item) => item.downloadId === record.downloadId
      || item.operationId === record.operationId;
    const existingItem = state.items.find(matches);
    const existingDownload = (state.downloads ?? []).find(matches);
    const existing = existingItem ?? existingDownload;
    const updated = existing
      ? {
          ...existing,
          operationId: record.operationId,
          downloadId: record.downloadId,
          ...relocationView(record),
        }
      : restoredRelocationItem(record);
    const items = existingItem
      ? state.items.map((item) => item === existingItem ? updated : item)
      : state.items;
    const downloads = existingItem
      ? (state.downloads ?? []).filter((item) => !matches(item))
      : [...(state.downloads ?? []).filter((item) => !matches(item)), updated];
    return {
      ...state,
      status: state.status === 'restoring' ? 'restoring' : 'results',
      target: state.target || 'downloads',
      items,
      downloads,
      busyId: currentBusyId(items, downloads),
      message: record.status === 'complete' ? 'Download concluído' : 'Download atualizado',
    };
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
    const page = canonicalMediaPage(event.snapshot.url);
    const itemId = `${page?.platform ?? 'youtube'}:${event.snapshot.videoId}`;
    const matches = (entry) => entry.id === itemId || entry.jobId === event.snapshot.jobId;
    const existingItem = state.items.find(matches);
    const existingDownload = (state.downloads ?? []).find(matches);
    if (existingItem?.isQueueJob || existingDownload?.isQueueJob) return state;
    const item = youtubeView(event.snapshot, existingItem ?? existingDownload);
    const items = existingItem
      ? state.items.map((entry) => entry === existingItem ? item : entry)
      : state.items;
    const downloads = existingItem
      ? (state.downloads ?? []).filter((entry) => !matches(entry))
      : [...(state.downloads ?? []).filter((entry) => !matches(entry)), item];
    return {
      ...state,
      status: state.status === 'restoring' ? 'restoring' : 'results',
      target: state.target || (page?.platform === 'x' ? 'x.com' : `${page?.platform ?? 'youtube'}.com`),
      items,
      downloads,
      busyId: item.active ? item.id : currentBusyId(items, downloads),
      message: item.active ? 'Download em andamento' : 'Download restaurado',
    };
  }

  if (event.type === 'YOUTUBE_JOB_UPDATED') {
    if (!event.snapshot) return state;
    const page = canonicalMediaPage(event.snapshot.url);
    const itemId = `${page?.platform ?? 'youtube'}:${event.snapshot.videoId}`;
    const matches = (entry) => (
      ['youtube', 'remote-media'].includes(entry.kind) && entry.jobId === event.snapshot.jobId
    ) || entry.id === itemId;
    const existingItem = state.items.find(matches);
    const existingDownload = (state.downloads ?? []).find(matches);
    // v5 publishes the durable queue entry before its compatibility snapshot.
    // Once either section owns that job as a queue item, the lossy legacy view
    // must not replace it or remove pause/resume controls from the download.
    if (existingItem?.isQueueJob || existingDownload?.isQueueJob) return state;
    const item = youtubeView(event.snapshot, existingItem ?? existingDownload);
    const items = existingItem
      ? state.items.map((entry) => entry === existingItem ? item : entry)
      : state.items;
    const downloads = existingItem
      ? (state.downloads ?? []).filter((entry) => !matches(entry))
      : [...(state.downloads ?? []).filter((entry) => !matches(entry)), item];
    return {
      ...state,
      status: 'results', target: state.target || 'downloads', items, downloads,
      busyId: item.active ? item.id : currentBusyId(items, downloads),
      message: item.active ? 'Download em andamento' : state.message || 'Download atualizado',
    };
  }

  if (event.type === 'DOWNLOAD_QUEUE_JOB_UPDATED') {
    if (!event.job) return state;
    return mergeQueueJob(state, event.job);
  }

  if (event.type === 'DOWNLOAD_QUEUE_RESTORED') {
    if (!Array.isArray(event.jobs)) return state;
    const jobIds = new Set(event.jobs.map((job) => job.jobId));
    const reconciled = {
      ...state,
      items: state.items.filter((item) => !item.isQueueJob || jobIds.has(item.jobId)),
      downloads: (state.downloads ?? [])
        .filter((item) => !item.isQueueJob || jobIds.has(item.jobId)),
    };
    return event.jobs.reduce(mergeQueueJob, reconciled);
  }

  if (event.type === 'YOUTUBE_START_CANCELLED') {
    const next = updateStateItem(state, event.id, () => ({
      phase: 'ready',
      active: false,
      statusLabel: '',
      error: null,
    }));
    return {
      ...next,
      busyId: currentBusyId(next.items, next.downloads),
      message: 'Download cancelado',
    };
  }

  if (event.type === 'REVEAL_FAILED') {
    const message = userMessageForError('REVEAL_FAILED');
    return {
      ...updateStateItem(state, event.id, () => ({ statusLabel: message, revealError: true })),
      message,
    };
  }

  if (event.type === 'FAILED') {
    const errorMessage = userMessageForError(event.code);
    if (event.id) {
      const next = updateStateItem(state, event.id, () => ({
        phase: 'error',
        active: false,
        statusLabel: errorMessage,
        error: { code: event.code, details: event.details ?? {} },
        ...(DESTINATION_ERRORS.has(event.code) ? { action: 'open-download-settings' } : {}),
      }));
      return {
        ...next,
        busyId: currentBusyId(next.items, next.downloads),
        pendingPermission: state.pendingPermission?.id === event.id ? null : state.pendingPermission,
        message: errorMessage,
      };
    }
    return {
      ...state,
      status: state.items.length || (state.downloads ?? []).length ? 'results' : 'error',
      busyId: null,
      message: errorMessage,
    };
  }

  return state;
}
