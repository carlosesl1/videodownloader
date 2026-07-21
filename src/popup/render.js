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

  const signature = node('div', 'target-signature');
  const count = node('strong', 'target-signature__count', String(state.items.length).padStart(2, '0'));
  const label = node('span', 'target-signature__label', state.items.length === 1 ? 'vídeo' : 'vídeos');
  signature.setAttribute(
    'aria-label',
    `${state.items.length} ${state.items.length === 1 ? 'vídeo encontrado' : 'vídeos encontrados'}`,
  );
  signature.append(count, label);
  header.append(identity, signature);
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

function appendScanning(surface) {
  const panel = node('section', 'state-panel state-panel--scanning');
  panel.setAttribute('role', 'status');
  panel.append(
    node('span', 'state-kicker', 'VARREDURA HÍBRIDA'),
    node('h2', '', 'Analisando a página…'),
    node('p', '', 'Verificando players e recursos já carregados.'),
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

function actionLabel(item) {
  if (item.phase === 'preparing') return 'Preparando…';
  if (item.phase === 'permission') return 'Aguardando autorização';
  if (item.kind === 'hls' && !item.inspected) return 'Ver qualidades';
  if (item.phase === 'sent' || item.phase === 'complete' || item.phase === 'error') return 'Baixar novamente';
  return 'Baixar';
}

function appendQualityControl(row, item) {
  if (!item.inspected || item.variants.length <= 1) {
    const quality = item.inspected
      ? item.variants[0]?.label || 'Qualidade única'
      : 'Qualidades disponíveis após verificar';
    row.append(node('span', 'quality-single', quality));
    return;
  }

  const label = node('label', 'quality');
  const labelText = node('span', 'quality__label', 'Qualidade');
  const select = node('select', 'quality__select');
  select.dataset.quality = item.id;
  select.setAttribute('aria-label', `Qualidade de ${item.filename}`);
  item.variants.forEach((variant, index) => {
    const option = node('option', '', variant.label || `Opção ${index + 1}`);
    option.value = String(index);
    option.selected = index === (item.selectedIndex ?? 0);
    select.append(option);
  });
  label.append(labelText, select);
  row.append(label);
}

function appendMediaItem(list, item, pendingPermission) {
  const row = node('li', 'media-row');
  row.dataset.itemId = item.id;

  const heading = node('div', 'media-row__heading');
  const name = node('strong', 'media-row__name', item.filename);
  name.title = item.filename;
  const metadata = node(
    'span',
    'media-row__metadata',
    item.kind === 'hls' ? 'HLS  /  SAÍDA .TS' : `${String(item.format || 'VÍDEO').toUpperCase()}  /  DIRETO`,
  );
  heading.append(name, metadata);
  row.append(heading);

  appendQualityControl(row, item);

  const needsInspection = item.kind === 'hls' && !item.inspected;
  const action = button(actionLabel(item), 'button button--download');
  action.dataset[needsInspection ? 'inspect' : 'download'] = item.id;
  action.disabled = item.phase === 'preparing' || item.phase === 'permission';
  row.append(action);

  if (item.statusLabel) {
    const status = node('p', `media-row__status media-row__status--${item.phase || 'ready'}`, item.statusLabel);
    status.setAttribute('role', 'status');
    row.append(status);
  }

  if (pendingPermission?.id === item.id) {
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
  const summary = node('div', 'results-heading');
  const summaryCopy = node('div');
  summaryCopy.append(
    node('span', 'state-kicker', state.target ? `ALVO  /  ${state.target}` : 'MÍDIAS DISPONÍVEIS'),
    node('h2', '', state.items.length === 1 ? '1 vídeo encontrado' : `${state.items.length} vídeos encontrados`),
  );
  summary.append(summaryCopy, button('Buscar novamente', 'button button--quiet', 'scan'));
  surface.append(summary);

  const list = node('ul', 'media-list');
  state.items.forEach((item) => appendMediaItem(list, item, state.pendingPermission));
  surface.append(list);
}

export function renderPopup(root, state) {
  root.replaceChildren();
  root.setAttribute('aria-busy', String(state.status === 'scanning'));
  appendHeader(root, state);

  const surface = node('main', 'surface');
  if (state.status === 'idle') appendIdle(surface);
  else if (state.status === 'scanning') appendScanning(surface);
  else if (state.status === 'results') appendResults(surface, state);
  else appendNoResults(surface, state);

  const privacy = node('p', 'privacy-note', 'Sem monitoramento contínuo · acesso somente quando necessário');
  surface.append(privacy);
  root.append(surface);
}
