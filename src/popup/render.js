function node(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function button(label, className, dataName, dataValue) {
  const element = node('button', className, label);
  element.type = 'button';
  if (dataName) element.dataset[dataName] = dataValue ?? '';
  return element;
}

function appendHeader(root, state) {
  const header = node('header', 'header');
  const identity = node('div', 'identity');
  identity.append(
    node('span', 'eyebrow', 'Detector sob demanda'),
    node('h1', '', 'Vídeo Radar'),
  );

  header.append(identity);
  if (state.items.length > 0) {
    const signature = node('div', 'target-signature');
    const count = node('strong', 'target-signature__count', String(state.items.length).padStart(2, '0'));
    const label = node('span', 'target-signature__label', state.items.length === 1 ? 'vídeo' : 'vídeos');
    signature.setAttribute(
      'aria-label',
      `${state.items.length} ${state.items.length === 1 ? 'vídeo encontrado' : 'vídeos encontrados'}`,
    );
    signature.append(count, label);
    header.append(signature);
  }
  root.append(header);
}

function appendScanAction(container, label = 'Buscar vídeos') {
  container.append(button(label, 'button button--primary', 'scan'));
}

function appendIdle(surface) {
  const panel = node('section', 'intro');
  const mark = node('span', 'scan-mark', 'SCAN');
  mark.setAttribute('aria-hidden', 'true');
  panel.append(
    mark,
    node('h2', '', 'Encontre a mídia desta página'),
    node('p', '', 'A análise só começa quando você solicitar.'),
  );
  surface.append(panel);
  appendScanAction(surface, 'Buscar vídeos nesta página');
}

function appendRestoring(surface) {
  const panel = node('section', 'state-panel state-panel--scanning');
  panel.append(
    node('span', 'state-kicker', 'RETOMANDO ESTADO'),
    node('h2', '', 'Restaurando downloads…'),
    node('p', '', 'Aguarde enquanto as operações em andamento são recuperadas.'),
  );
  surface.append(panel);
}

function appendScanning(surface, state) {
  const platformNames = {
    'youtube.com': 'YouTube',
    'tiktok.com': 'TikTok',
    'instagram.com': 'Instagram',
    'x.com': 'X',
  };
  const platform = platformNames[state.target];
  const panel = node('section', 'state-panel state-panel--scanning');
  panel.append(
    node('span', 'state-kicker', platform ? `${platform.toUpperCase()} DETECTADO` : 'VARREDURA HÍBRIDA'),
    node('h2', '', platform ? `Consultando vídeo do ${platform}` : 'Analisando a página…'),
    node('p', '', platform ? state.message : 'Verificando players e recursos já carregados.'),
  );
  surface.append(panel);
}

function appendNoResults(surface, state) {
  const isError = state.status === 'error';
  const panel = node('section', `state-panel${isError ? ' state-panel--error' : ''}`);
  panel.append(
    node('span', 'state-kicker', isError ? 'NÃO FOI POSSÍVEL ANALISAR' : 'NENHUMA MÍDIA LOCALIZADA'),
    node('h2', '', isError ? 'Tente novamente nesta aba' : 'O vídeo pode ainda não ter carregado'),
    node('p', '', state.message),
  );
  surface.append(panel);
  appendScanAction(surface, 'Buscar novamente');
}

function actionLabel(item, blockedByHls) {
  if (item.phase === 'preparing') return 'Preparando…';
  if (blockedByHls) return 'Aguarde';
  if (item.phase === 'permission') return 'Aguardando autorização';
  if (item.phase === 'sent') return 'Em andamento';
  if (item.kind === 'hls' && !item.inspected) return 'Ver qualidades';
  if (item.phase === 'complete' || item.phase === 'error') return 'Baixar novamente';
  return 'Baixar';
}

function appendQualityControl(row, item) {
  const variants = item.variants ?? [];
  const inspected = item.kind === 'youtube' || item.kind === 'remote-media' || item.inspected;
  if (!inspected || variants.length <= 1) {
    const quality = inspected
      ? variants[0]?.label || 'Qualidade única'
      : 'Qualidades disponíveis após verificar';
    row.append(node('span', 'quality-single', quality));
    return;
  }

  const label = node('label', 'quality');
  const labelText = node('span', 'quality__label', 'Qualidade');
  const select = node('select', 'quality__select');
  select.dataset.quality = item.id;
  select.setAttribute('aria-label', `Qualidade de ${item.filename}`);
  select.disabled = Boolean(item.active || ['permission', 'preparing', 'sent'].includes(item.phase));
  variants.forEach((variant, index) => {
    const option = node('option', '', variant.label || `Opção ${index + 1}`);
    option.value = String(index);
    option.selected = index === (item.selectedIndex ?? 0);
    select.append(option);
  });
  label.append(labelText, select);
  row.append(label);
}

function appendMediaItem(list, item, pendingPermission, hlsBusy) {
  const row = node('li', 'media-row');
  row.dataset.itemId = item.id;

  const heading = node('div', 'media-row__heading');
  const name = node('strong', 'media-row__name', item.filename);
  name.title = item.filename;
  const metadata = node(
    'span',
    'media-row__metadata',
    item.kind === 'youtube' || item.kind === 'remote-media'
      ? `${String(item.platform || 'youtube').toUpperCase()}  /  SAÍDA .${String(item.predictedFormat || item.variants?.[item.selectedIndex]?.container || 'mp4').toUpperCase()}`
      : item.kind === 'hls' ? 'HLS  /  SAÍDA .TS' : `${String(item.format || 'VÍDEO').toUpperCase()}  /  DIRETO`,
  );
  heading.append(name, metadata);
  row.append(heading);

  appendQualityControl(row, item);

  const needsInspection = item.kind === 'hls' && !item.inspected;
  const blockedByHls = item.kind === 'hls'
    && item.inspected
    && hlsBusy
    && item.phase !== 'preparing';
  const activeYoutube = ['youtube', 'remote-media'].includes(item.kind) && item.active;
  if (item.action === 'open-download-settings') {
    row.append(button('Configurar downloads', 'button button--download', 'settings'));
  } else if (activeYoutube) {
    const hasJobId = typeof item.jobId === 'string' && item.jobId.trim().length > 0;
    const cancel = button('Cancelar', 'button button--cancel', 'cancel', hasJobId ? item.id : '');
    cancel.disabled = !hasJobId;
    row.append(cancel);
  } else {
    const action = button(actionLabel(item, blockedByHls), 'button button--download');
    action.dataset[needsInspection ? 'inspect' : 'download'] = item.id;
    action.disabled = ['preparing', 'permission', 'sent'].includes(item.phase) || blockedByHls;
    row.append(action);
  }

  if (activeYoutube || item.phase === 'preparing') {
    const progress = node('progress', 'media-row__progress');
    progress.max = 100;
    if (activeYoutube) {
      if (Number.isFinite(item.progress)) progress.value = item.progress;
    } else {
      progress.value = Number.isFinite(item.progress) ? item.progress : 0;
    }
    progress.setAttribute('aria-label', `Progresso de ${item.filename}`);
    const stageLabel = item.statusLabel || 'Em andamento…';
    progress.setAttribute(
      'aria-valuetext',
      activeYoutube && Number.isFinite(item.progress)
        ? `${stageLabel} ${item.progress}%`
        : stageLabel,
    );
    row.append(progress);
  }

  if (activeYoutube) {
    row.append(node('p', 'media-row__stage', item.statusLabel || 'Em andamento…'));
  } else if (item.statusLabel) {
    row.append(node('p', `media-row__status media-row__status--${item.phase || 'ready'}`, item.statusLabel));
  }

  const visiblePath = item.finalPath ?? item.stagingPath ?? item.path;
  const path = typeof visiblePath === 'string' ? visiblePath.trim() : '';
  if (path) {
    const pathNode = node('p', 'media-row__path', path);
    pathNode.title = path;
    row.append(pathNode);
    if (item.phase === 'complete') {
      row.append(button('Mostrar no Explorer', 'button button--reveal', 'reveal', item.id));
    }
  }

  if (pendingPermission?.id === item.id) {
    const origins = (pendingPermission.origins ?? []).join(', ');
    if (origins) row.append(node('p', 'media-row__permission-origins', `Servidores solicitados: ${origins}`));
    const authorize = button(
      'Autorizar servidor de mídia',
      'button button--authorize',
      'authorize',
      item.id,
    );
    row.append(authorize);
  }

  list.append(row);
}

function appendResults(surface, state) {
  const downloads = state.downloads ?? [];
  const allItems = [...state.items, ...downloads];
  const hlsBusy = allItems.some((item) => item.kind === 'hls' && item.phase === 'preparing');

  if (state.items.length > 0) {
    const summary = node('div', 'results-heading');
    const summaryCopy = node('div');
    summaryCopy.append(
      node('span', 'state-kicker', state.target ? `ALVO  /  ${state.target}` : 'MÍDIAS DISPONÍVEIS'),
      node('h2', '', state.items.length === 1 ? '1 vídeo encontrado' : `${state.items.length} vídeos encontrados`),
    );
    summary.append(summaryCopy, button('Buscar novamente', 'button button--quiet', 'scan'));
    surface.append(summary);

    const list = node('ul', 'media-list');
    state.items.forEach((item) => appendMediaItem(list, item, state.pendingPermission, hlsBusy));
    surface.append(list);
  } else {
    const summary = node('div', 'results-heading');
    const summaryCopy = node('div');
    summaryCopy.append(
      node('span', 'state-kicker', 'BUSCA SOB DEMANDA'),
      node('h2', '', 'Nenhuma busca nesta página'),
    );
    summary.append(summaryCopy, button('Buscar vídeos', 'button button--quiet', 'scan'));
    surface.append(summary);
  }

  if (downloads.length > 0) {
    const heading = node('div', 'downloads-heading');
    heading.append(
      node('span', 'state-kicker', 'OPERAÇÕES RECENTES'),
      node('h2', '', downloads.length === 1 ? '1 download' : `${downloads.length} downloads`),
    );
    surface.append(heading);
    const list = node('ul', 'media-list media-list--downloads');
    downloads.forEach((item) => appendMediaItem(list, item, state.pendingPermission, hlsBusy));
    surface.append(list);
  }
}

export function renderPopup(root, state) {
  root.replaceChildren();
  root.setAttribute('aria-busy', String(state.status === 'scanning' || state.status === 'restoring'));
  appendHeader(root, state);

  const surface = node('main', 'surface');
  if (state.status === 'restoring') appendRestoring(surface);
  else if (state.status === 'idle') appendIdle(surface);
  else if (state.status === 'scanning') appendScanning(surface, state);
  else if (state.status === 'results') appendResults(surface, state);
  else appendNoResults(surface, state);

  const footer = node('footer', 'popup-footer');
  footer.append(
    button('Configurar downloads', 'button button--settings', 'settings'),
    node('p', 'privacy-note', 'Sem monitoramento contínuo · acesso somente quando necessário'),
  );
  surface.append(footer);
  root.append(surface);
}
