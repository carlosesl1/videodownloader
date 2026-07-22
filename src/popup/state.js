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
    return {
      phase: 'preparing',
      progress,
      completedSegments,
      totalSegments,
      statusLabel: totalSegments > 0
        ? `Baixando segmentos… ${progress}% · ${completedSegments}/${totalSegments}`
        : 'Preparando a playlist…',
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
      items: updateItem(state.items, event.id, (item) => ({
        selectedIndex: event.selectedIndex,
        filename: item.variants[event.selectedIndex]?.filename ?? item.filename,
      })),
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
