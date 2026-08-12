import assert from 'node:assert/strict';
import test from 'node:test';

import { renderPopup } from '../src/popup/render.js';

const originalDocument = globalThis.document;

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toLowerCase();
    this.children = [];
    this.attributes = new Map();
    this._text = '';
    this.className = '';
    this.disabled = false;
    this.type = '';
    this.title = '';
    this.selected = false;
    this._value = undefined;
    this._max = undefined;
    this.dataset = new Proxy({}, {
      set: (target, key, value) => {
        target[key] = String(value);
        this.setAttribute(`data-${String(key).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, value);
        return true;
      },
    });
  }

  set value(value) {
    this._value = value;
    this.setAttribute('value', value);
  }

  get value() {
    return this._value;
  }

  set max(value) {
    this._max = value;
    this.setAttribute('max', value);
  }

  get max() {
    return this._max;
  }

  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }

  get textContent() {
    return `${this._text}${this.children.map((child) => child.textContent).join('')}`;
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this._text = '';
    this.children = [...children];
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  querySelectorAll(selector) {
    const matches = [];
    const check = (element) => {
      if (matchesSelector(element, selector)) matches.push(element);
      element.children.forEach(check);
    };
    this.children.forEach(check);
    return matches;
  }
}

function matchesSelector(element, selector) {
  if (selector.startsWith('.')) return element.className.split(/\s+/).includes(selector.slice(1));
  if (selector.startsWith('[')) return element.hasAttribute(selector.slice(1, -1));
  return element.tagName === selector;
}

function installDocument() {
  const previous = globalThis.document;
  globalThis.document = { createElement: (tagName) => new FakeElement(tagName) };
  return () => { globalThis.document = previous; };
}

function renderItem(item) {
  const root = new FakeElement('div');
  renderPopup(root, { status: 'results', target: 'youtube.com', items: [item], pendingPermission: null });
  return root;
}

function one(root, selector) {
  const matches = root.querySelectorAll(selector);
  assert.equal(matches.length, 1, `expected one ${selector}, found ${matches.length}`);
  return matches[0];
}

function youtubeItem(overrides = {}) {
  return {
    id: 'youtube:jNQXAC9IVRw',
    kind: 'youtube',
    url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    title: 'Me at the zoo',
    filename: 'Me at the zoo-1080p.mp4',
    variants: [
      { height: 1080, label: '1080p', container: 'mp4', combined: false, filename: 'Me at the zoo-1080p.mp4' },
      { height: 720, label: '720p', container: 'webm', combined: true, filename: 'Me at the zoo-720p.webm' },
    ],
    selectedIndex: 0,
    predictedFormat: 'mp4',
    phase: 'ready',
    jobId: null,
    active: false,
    progress: null,
    statusLabel: '',
    path: null,
    error: null,
    ...overrides,
  };
}

function socialItem(overrides = {}) {
  return youtubeItem({
    id: 'tiktok:7488298911734435077',
    kind: 'remote-media',
    platform: 'tiktok',
    url: 'https://www.tiktok.com/@video.radar/video/7488298911734435077',
    title: 'Public TikTok',
    filename: 'Public TikTok-720p.mp4',
    variants: [
      { height: 720, label: '720p', container: 'mp4', combined: true, filename: 'Public TikTok-720p.mp4' },
    ],
    ...overrides,
  });
}

test.beforeEach(() => installDocument());
test.afterEach(() => { globalThis.document = originalDocument; });

test('shows immediately that YouTube was detected while qualities load', () => {
  const root = new FakeElement('div');
  renderPopup(root, {
    status: 'scanning',
    target: 'youtube.com',
    items: [],
    message: 'Carregando qualidades do YouTube…',
  });

  assert.equal(one(root, 'h2').textContent, 'Consultando vídeo do YouTube');
  assert.match(one(root, '.state-panel--scanning').textContent, /Carregando qualidades/);
});

test('renders ready YouTube variants with selected output format and download action', () => {
  const root = renderItem(youtubeItem());

  assert.equal(one(root, '[data-settings]').textContent, 'Configurar downloads');
  assert.equal(one(root, '.media-row__metadata').textContent, 'YOUTUBE  /  SAÍDA .MP4');
  const select = one(root, 'select');
  assert.equal(select.children.length, 2);
  assert.deepEqual(select.children.map((option) => option.textContent), ['1080p', '720p']);
  assert.equal(select.children.filter((option) => option.selected).length, 1);
  assert.equal(select.children[0].selected, true);
  assert.equal(one(root, '[data-download]').getAttribute('data-download'), 'youtube:jNQXAC9IVRw');

  const webmRoot = renderItem(youtubeItem({ selectedIndex: 1, predictedFormat: 'webm' }));
  assert.equal(one(webmRoot, '.media-row__metadata').textContent, 'YOUTUBE  /  SAÍDA .WEBM');
});

test('renders TikTok as a native remote-media card with a single quality', () => {
  const root = renderItem(socialItem());

  assert.equal(one(root, '.media-row__metadata').textContent, 'TIKTOK  /  SAÍDA .MP4');
  assert.equal(one(root, '.quality-single').textContent, '720p');
  assert.equal(one(root, '[data-download]').getAttribute('data-download'), 'tiktok:7488298911734435077');
});

test('shows platform-aware scanning copy for Instagram and X', () => {
  for (const [target, name] of [['instagram.com', 'Instagram'], ['x.com', 'X']]) {
    const root = new FakeElement('div');
    renderPopup(root, {
      status: 'scanning',
      target,
      items: [],
      message: `Carregando qualidades do ${name}â€¦`,
    });
    assert.match(one(root, 'h2').textContent, new RegExp(name));
    assert.match(one(root, '.state-panel--scanning').textContent, /Carregando qualidades/);
  }
});

test('distinguishes a previous download from the current page search', () => {
  const root = new FakeElement('div');
  renderPopup(root, {
    status: 'results',
    target: 'downloads',
    items: [],
    downloads: [socialItem({
      id: 'x:1907123456789012345',
      platform: 'x',
      phase: 'complete',
      statusLabel: 'Concluído',
    })],
    pendingPermission: null,
  });

  assert.match(root.textContent, /Nenhuma busca feita nesta página/);
  assert.match(one(root, '.downloads-heading').textContent, /HISTÓRICO RECENTE · TODOS OS SITES/);
  assert.match(one(root, '.downloads-heading').textContent, /1 download anterior/);
});

test('renders a known active YouTube job as one announced stage with cancellable native progress', () => {
  const root = renderItem(youtubeItem({
    phase: 'video', active: true, jobId: 'job-42', progress: 62, statusLabel: 'Baixando vídeo…',
  }));

  const cancel = one(root, '[data-cancel]');
  assert.equal(cancel.getAttribute('data-cancel'), 'youtube:jNQXAC9IVRw');
  assert.equal(cancel.type, 'button');
  assert.equal(cancel.disabled, false);
  assert.equal(root.querySelectorAll('[data-download]').length, 0);
  assert.equal(root.querySelectorAll('[data-inspect]').length, 0);
  const progress = one(root, 'progress');
  assert.equal(progress.max, 100);
  assert.equal(progress.value, 62);
  assert.equal(progress.getAttribute('value'), '62');
  assert.match(progress.getAttribute('aria-valuetext'), /Baixando vídeo.*62%/);
  const stage = one(root, '.media-row__stage');
  assert.equal(stage.getAttribute('role'), null);
  assert.equal(stage.textContent, 'Baixando vídeo…');
  assert.equal(root.querySelectorAll('[role]').filter((element) => element.getAttribute('role') === 'status').length, 0);
  assert.equal(one(root, 'select').disabled, true);

  const missingJob = renderItem(youtubeItem({ phase: 'video', active: true, jobId: '', statusLabel: 'Baixando vídeo…' }));
  assert.equal(one(missingJob, '[data-cancel]').disabled, true);
});

test('renderiza controles de pausar e retomar para jobs duráveis', () => {
  const running = renderItem(youtubeItem({
    id: 'media-job:job-queue', isQueueJob: true, queueState: 'running',
    phase: 'video', active: true, jobId: 'job-queue', progress: 12,
    statusLabel: 'Baixando vídeo…',
  }));
  assert.equal(one(running, '[data-pause]').getAttribute('data-pause'), 'media-job:job-queue');
  assert.equal(one(running, '[data-cancel]').getAttribute('data-cancel'), 'media-job:job-queue');
  assert.equal(running.querySelectorAll('[data-resume]').length, 0);

  const paused = renderItem(youtubeItem({
    id: 'media-job:job-queue', isQueueJob: true, queueState: 'paused',
    phase: 'paused', active: true, jobId: 'job-queue', progress: 12,
    statusLabel: 'Pausado · progresso preservado',
  }));
  assert.equal(one(paused, '[data-resume]').textContent, 'Retomar');
  assert.equal(paused.querySelectorAll('[data-pause]').length, 0);
});

test('keeps active YouTube progress indeterminate when its percentage is unknown', () => {
  const root = renderItem(youtubeItem({
    phase: 'merge', active: true, jobId: 'job-43', progress: null, statusLabel: 'Combinando…',
  }));

  const progress = one(root, 'progress');
  assert.equal(progress.max, 100);
  assert.equal(progress.value, undefined);
  assert.equal(progress.hasAttribute('value'), false);
  assert.equal(progress.getAttribute('aria-valuetext'), 'Combinando…');
  assert.equal(one(root, '.media-row__stage').textContent, 'Combinando…');
});

test('renders YouTube completion path and terminal states without cancel or progress', () => {
  const complete = renderItem(youtubeItem({
    phase: 'complete', statusLabel: 'Concluído', path: 'C:/Downloads/Me at the zoo-1080p.mp4',
  }));
  assert.equal(one(complete, '.media-row__path').textContent, 'C:/Downloads/Me at the zoo-1080p.mp4');
  assert.equal(one(complete, '.media-row__path').title, 'C:/Downloads/Me at the zoo-1080p.mp4');
  assert.equal(one(complete, '[data-reveal]').getAttribute('data-reveal'), 'youtube:jNQXAC9IVRw');
  assert.equal(one(complete, '[data-reveal]').textContent, 'Mostrar no Explorer');
  assert.equal(one(complete, '.media-row__status').textContent, 'Concluído');
  assert.equal(complete.querySelectorAll('[data-cancel]').length, 0);
  assert.equal(complete.querySelectorAll('progress').length, 0);
  assert.equal(complete.querySelectorAll('[data-download]').length, 1);

  for (const phase of ['failed', 'interrupted', 'cancelled']) {
    const root = renderItem(youtubeItem({ phase, statusLabel: 'Tente novamente.', error: { code: 'INTERNAL' } }));
    assert.equal(root.querySelectorAll('[data-cancel]').length, 0, phase);
    assert.equal(root.querySelectorAll('progress').length, 0, phase);
    assert.equal(one(root, '.media-row__status').textContent, 'Tente novamente.', phase);
    assert.equal(root.querySelectorAll('[data-download]').length, 1, phase);
    assert.equal(root.querySelectorAll('[data-reveal]').length, 0, phase);
  }
});

test('renders a preserved relocation failure with a row-level settings action', () => {
  const root = renderItem({
    id: 'download:9',
    kind: 'hls',
    filename: 'aula.ts',
    format: 'ts',
    inspected: true,
    variants: [{ label: 'Qualidade escolhida' }],
    selectedIndex: 0,
    phase: 'error',
    statusLabel: 'Não foi possível mover. Arquivo preservado em C:\\Downloads\\Video Radar\\aula.ts',
    stagingPath: 'C:\\Downloads\\Video Radar\\aula.ts',
    action: 'open-download-settings',
  });

  assert.equal(root.querySelectorAll('[data-settings]').length, 2);
  assert.equal(root.querySelectorAll('[data-settings]')[0].textContent, 'Configurar downloads');
  assert.equal(one(root, '.media-row__path').textContent, 'C:\\Downloads\\Video Radar\\aula.ts');
  assert.equal(root.querySelectorAll('[data-download]').length, 0);
});

test('keeps HLS preparation determinate and direct downloads unchanged', () => {
  const hls = renderItem({
    id: 'hls-1', kind: 'hls', filename: 'master.ts', format: 'ts', inspected: true,
    variants: [{ label: '720p' }, { label: '480p' }], selectedIndex: 0, phase: 'preparing', progress: 0,
    statusLabel: 'Preparando a playlist…',
  });
  assert.equal(one(hls, 'progress').value, 0);
  assert.equal(one(hls, '.media-row__status').textContent, 'Preparando a playlist…');
  assert.equal(one(hls, 'select').disabled, true);

  const hlsProgress = renderItem({
    id: 'hls-2', kind: 'hls', filename: 'master.ts', format: 'ts', inspected: true,
    variants: [{ label: '720p' }], selectedIndex: 0, phase: 'preparing', progress: 40,
    statusLabel: 'Baixando segmentos… 40% · 12/30 · 4 KB de ~10 KB',
  });
  assert.equal(
    one(hlsProgress, 'progress').getAttribute('aria-valuetext'),
    'Baixando segmentos… 40% · 12/30 · 4 KB de ~10 KB',
  );

  const direct = renderItem({
    id: 'direct-1', kind: 'direct', filename: 'clip.mp4', format: 'mp4', inspected: true,
    variants: [{ label: 'Original' }], selectedIndex: 0, phase: 'ready', statusLabel: '',
  });
  assert.equal(one(direct, '[data-download]').getAttribute('data-download'), 'direct-1');
  assert.equal(direct.querySelectorAll('[data-cancel]').length, 0);
});

test('shows requested HLS origins while permission is pending', () => {
  const root = new FakeElement('div');
  renderPopup(root, {
    status: 'results', target: 'example.test',
    items: [{
      id: 'hls-permission', kind: 'hls', filename: 'master.ts', format: 'ts', inspected: true,
      variants: [{ label: '720p' }, { label: '480p' }], selectedIndex: 0,
      phase: 'permission', statusLabel: 'Autorize o servidor de mídia para continuar.',
    }],
    pendingPermission: { id: 'hls-permission', selectedIndex: 0, origins: ['https://cdn.test', 'https://segments.test'] },
  });

  assert.equal(one(root, 'select').disabled, true);
  assert.match(one(root, '.media-row__permission-origins').textContent, /cdn\.test.*segments\.test/);
});
