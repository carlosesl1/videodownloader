import test from 'node:test';
import assert from 'node:assert/strict';

import {
  initialState,
  reduceState,
  userMessageForError,
} from '../src/popup/state.js';

const directItem = {
  id: 'direct-video-0',
  kind: 'direct',
  filename: 'aula.mp4',
  inspected: true,
  selectedIndex: 0,
  variants: [{ url: 'https://cdn.test/aula.mp4', label: '1080p' }],
};

const hlsItem = {
  id: 'hls-master',
  kind: 'hls',
  filename: 'master.ts',
  inspected: false,
  selectedIndex: 0,
  variants: [{ url: 'https://cdn.test/master.m3u8', label: 'Qualidade a verificar' }],
};

const youtubeSnapshot = {
  jobId: 'youtube-job-1',
  videoId: 'jNQXAC9IVRw',
  title: 'Me at the zoo',
  url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
  height: 720,
  format: { height: 720, label: '720p', container: 'mp4', combined: true },
  stage: 'video',
  percent: null,
  downloadedBytes: null,
  totalBytes: null,
  speedBytesPerSecond: null,
  etaSeconds: null,
  path: null,
  error: null,
  updatedAt: 1,
};

test('moves from idle through scanning to results and empty', () => {
  const scanning = reduceState(initialState, { type: 'SCAN_STARTED' });
  assert.equal(scanning.status, 'scanning');
  assert.match(scanning.message, /Analisando/);

  const youtubeLookup = reduceState(scanning, { type: 'YOUTUBE_LOOKUP_STARTED' });
  assert.equal(youtubeLookup.status, 'scanning');
  assert.equal(youtubeLookup.target, 'youtube.com');
  assert.match(youtubeLookup.message, /qualidades/i);

  const results = reduceState(scanning, {
    type: 'SCAN_SUCCEEDED',
    items: [directItem],
    target: 'example.test',
  });
  assert.equal(results.status, 'results');
  assert.equal(results.items.length, 1);
  assert.equal(results.target, 'example.test');

  const empty = reduceState(results, { type: 'SCAN_SUCCEEDED', items: [], target: 'example.test' });
  assert.equal(empty.status, 'empty');
  assert.match(empty.message, /Nenhum vídeo/);
});

test('starts HLS preparation with a visible zero progress value', () => {
  const state = reduceState(
    { ...initialState, status: 'results', items: [hlsItem] },
    { type: 'DOWNLOAD_STARTED', id: hlsItem.id, selectedIndex: 0 },
  );

  assert.equal(state.busyId, hlsItem.id);
  assert.equal(state.items[0].phase, 'preparing');
  assert.equal(state.items[0].selectedIndex, 0);
  assert.equal(state.items[0].progress, 0);
});

test('maps supported failures to actionable Portuguese copy', () => {
  assert.match(userMessageForError('HLS_FMP4'), /segmentos fMP4/);
  assert.match(userMessageForError('PERMISSION_DENIED'), /Autorize/);
  assert.match(userMessageForError('SCAN_FAILED'), /Recarregue a página/);
  assert.match(userMessageForError('LOGIN_REQUIRED'), /login/i);
  assert.match(userMessageForError('RATE_LIMITED'), /temporariamente/i);
  assert.match(userMessageForError('FORMAT_UNAVAILABLE'), /qualidade/i);
  assert.match(userMessageForError('MEDIA_ACCESS_DENIED'), /servidor|plataforma/i);
  assert.match(userMessageForError('MEDIA_DOWNLOAD_FAILED'), /vídeo/i);
  assert.match(userMessageForError('DESTINATION_HELPER_UNAVAILABLE'), /auxiliar/i);
  assert.match(userMessageForError('REVEAL_FAILED'), /Explorer/i);
  assert.doesNotMatch(userMessageForError('YOUTUBE_DOWNLOAD'), /YouTube/i);
});

test('stores inspected HLS variants and a permission retry', () => {
  const base = { ...initialState, status: 'results', items: [hlsItem] };
  const inspected = reduceState(base, {
    type: 'HLS_INSPECTED',
    id: hlsItem.id,
    variants: [{ url: 'https://cdn.test/720.m3u8', label: '720p' }],
    allowedOrigins: ['https://cdn.test'],
  });
  assert.equal(inspected.items[0].inspected, true);
  assert.equal(inspected.items[0].phase, 'ready');

  const waiting = reduceState(inspected, {
    type: 'PERMISSION_REQUIRED',
    id: hlsItem.id,
    selectedIndex: 0,
    origins: ['https://media.test'],
  });
  assert.deepEqual(waiting.pendingPermission.origins, ['https://media.test']);
  assert.equal(waiting.items[0].phase, 'permission');
});

test('moves an asynchronous HLS operation from queued to downloading and complete', () => {
  const base = { ...initialState, status: 'results', items: [{ ...hlsItem, inspected: true }] };
  const queued = reduceState(base, {
    type: 'HLS_QUEUED',
    id: hlsItem.id,
    operationId: 'op-42',
    selectedIndex: 0,
  });
  assert.equal(queued.items[0].operationId, 'op-42');
  assert.equal(queued.items[0].phase, 'preparing');
  assert.equal(queued.items[0].statusLabel, 'Preparando a playlist…');

  const progressing = reduceState(queued, {
    type: 'HLS_OPERATION_UPDATED',
    operationId: 'op-42',
    record: {
      state: 'assembling',
      progress: {
        completedSegments: 12,
        totalSegments: 30,
        bytesReceived: 4096,
        estimatedTotalBytes: 10_240,
        percent: 40,
      },
    },
  });
  assert.equal(progressing.items[0].progress, 40);
  assert.equal(progressing.items[0].completedSegments, 12);
  assert.equal(progressing.items[0].totalSegments, 30);
  assert.equal(
    progressing.items[0].statusLabel,
    'Baixando segmentos… 40% · 12/30 · 4 KB de ~10 KB',
  );

  const downloading = reduceState(progressing, {
    type: 'HLS_OPERATION_UPDATED',
    operationId: 'op-42',
    record: { state: 'downloading' },
  });
  assert.equal(downloading.busyId, null);
  assert.equal(downloading.items[0].phase, 'sent');
  assert.equal(downloading.items[0].statusLabel, 'Download em andamento');

  const complete = reduceState(downloading, {
    type: 'HLS_OPERATION_UPDATED',
    operationId: 'op-42',
    record: { state: 'complete' },
  });
  assert.equal(complete.items[0].phase, 'complete');
  assert.equal(complete.items[0].statusLabel, 'Download concluído');
});

test('keeps HLS failure details on the affected item', () => {
  const queued = reduceState(
    { ...initialState, status: 'results', items: [{ ...hlsItem, operationId: 'op-fail' }] },
    {
      type: 'HLS_OPERATION_UPDATED',
      operationId: 'op-fail',
      record: {
        state: 'failed',
        error: { code: 'HLS_LIVE', details: {} },
      },
    },
  );

  assert.equal(queued.items[0].phase, 'error');
  assert.match(queued.items[0].statusLabel, /ao vivo/);
  assert.equal(queued.status, 'results');
});

test('reconciles a persisted HLS operation by canonical media URL', () => {
  const state = reduceState(
    { ...initialState, status: 'results', items: [{ ...hlsItem, inspected: true }] },
    {
      type: 'HLS_OPERATION_RECONCILED',
      id: hlsItem.id,
      selectedIndex: 0,
      record: { operationId: 'op-reopen', state: 'assembling' },
    },
  );

  assert.equal(state.items[0].operationId, 'op-reopen');
  assert.equal(state.items[0].phase, 'preparing');
  assert.equal(state.busyId, hlsItem.id);
});

test('restores a persisted HLS operation without requiring a new page scan', () => {
  const restored = reduceState(initialState, {
    type: 'HLS_OPERATION_RESTORED',
    record: {
      operationId: 'op-reopen',
      url: 'https://cdn.test/720.m3u8',
      filename: 'aula.ts',
      state: 'assembling',
      progress: {
        completedSegments: 15,
        totalSegments: 60,
        bytesReceived: 5_242_880,
        estimatedTotalBytes: 20_971_520,
        percent: 25,
      },
    },
  });
  const state = reduceState(restored, { type: 'RESTORE_COMPLETED' });

  assert.equal(state.status, 'results');
  assert.equal(state.target, 'downloads');
  assert.equal(state.items.length, 0);
  assert.equal(state.downloads.length, 1);
  assert.equal(state.downloads[0].operationId, 'op-reopen');
  assert.equal(state.downloads[0].phase, 'preparing');
  assert.equal(state.downloads[0].progress, 25);
  assert.equal(
    state.downloads[0].statusLabel,
    'Baixando segmentos… 25% · 15/60 · 5 MB de ~20 MB',
  );
});

test('reconciliation replaces the temporary restored HLS card instead of duplicating it', () => {
  const scanned = reduceState(initialState, {
    type: 'SCAN_SUCCEEDED',
    target: 'escola.test',
    items: [
      { ...hlsItem, id: 'hls-scanned', inspected: true },
      { ...hlsItem, id: 'hls-other', filename: 'master_1.ts' },
    ],
  });
  const raced = reduceState(scanned, {
    type: 'HLS_OPERATION_RESTORED',
    record: {
      operationId: 'op-race',
      url: 'https://cdn.test/master.m3u8',
      filename: 'master.ts',
      state: 'assembling',
      progress: { percent: 5, completedSegments: 5, totalSegments: 100 },
    },
  });
  assert.equal(raced.items.length, 2);
  assert.equal(raced.downloads.length, 1);

  const reconciled = reduceState(raced, {
    type: 'HLS_OPERATION_RECONCILED',
    id: 'hls-scanned',
    selectedIndex: 0,
    record: {
      operationId: 'op-race',
      url: 'https://cdn.test/master.m3u8',
      filename: 'master.ts',
      state: 'assembling',
      progress: { percent: 5, completedSegments: 5, totalSegments: 100 },
    },
  });

  assert.equal(reconciled.items.length, 2);
  assert.equal(reconciled.downloads.length, 0);
  assert.equal(reconciled.items.filter((item) => item.operationId === 'op-race').length, 1);
  assert.equal(reconciled.items.find((item) => item.operationId === 'op-race').id, 'hls-scanned');
});

test('direct download confirmation is stored on only the selected item', () => {
  const base = { ...initialState, status: 'results', items: [directItem, hlsItem] };
  const sent = reduceState(base, { type: 'DIRECT_SENT', id: directItem.id, selectedIndex: 0 });
  assert.equal(sent.items[0].phase, 'sent');
  assert.equal(sent.items[0].statusLabel, 'Download iniciado');
  assert.equal(sent.items[1].phase, undefined);
});

test('quality selection updates the visible filename and a denied retry clears permission state', () => {
  const withVariants = {
    ...directItem,
    variants: [
      { url: 'https://cdn.test/aula.mp4', label: '1080p', filename: 'aula.mp4' },
      { url: 'https://cdn.test/aula.webm', label: '720p', filename: 'aula.webm' },
    ],
  };
  const selected = reduceState(
    { ...initialState, status: 'results', items: [withVariants] },
    { type: 'QUALITY_SELECTED', id: directItem.id, selectedIndex: 1 },
  );
  assert.equal(selected.items[0].filename, 'aula.webm');

  const waiting = { ...selected, pendingPermission: { id: directItem.id, selectedIndex: 1, origins: ['https://cdn.test'] } };
  const denied = reduceState(waiting, { type: 'FAILED', id: directItem.id, code: 'PERMISSION_DENIED' });
  assert.equal(denied.pendingPermission, null);
});

test('stores a YouTube catalog with descending variants and keeps its selected format coherent', () => {
  const loaded = reduceState(initialState, {
    type: 'YOUTUBE_FORMATS_LOADED',
    target: 'youtube.com',
    item: {
      id: 'youtube:jNQXAC9IVRw', kind: 'youtube', url: youtubeSnapshot.url, title: youtubeSnapshot.title,
      filename: 'Me at the zoo-1080p.mp4', selectedIndex: 0, predictedFormat: 'mp4', phase: 'ready',
      variants: [
        { height: 1080, label: '1080p', container: 'mp4', combined: false, filename: 'Me at the zoo-1080p.mp4' },
        { height: 720, label: '720p', container: 'webm', combined: true, filename: 'Me at the zoo-720p.webm' },
      ],
    },
  });
  assert.equal(loaded.status, 'results');
  assert.equal(loaded.items[0].variants[0].height, 1080);

  const selected = reduceState(loaded, { type: 'QUALITY_SELECTED', id: loaded.items[0].id, selectedIndex: 1 });
  assert.equal(selected.items[0].filename, 'Me at the zoo-720p.webm');
  assert.equal(selected.items[0].predictedFormat, 'webm');
});

test('restores and updates persisted YouTube jobs without inventing unknown progress', () => {
  const restoring = reduceState(initialState, { type: 'YOUTUBE_JOB_RESTORED', snapshot: youtubeSnapshot });
  const restored = reduceState(restoring, { type: 'RESTORE_COMPLETED' });
  assert.equal(restored.status, 'results');
  assert.equal(restored.items.length, 0);
  assert.equal(restored.downloads[0].progress, null);
  assert.equal(restored.downloads[0].active, true);

  const completed = reduceState(restored, {
    type: 'YOUTUBE_JOB_UPDATED',
    snapshot: { ...youtubeSnapshot, stage: 'complete', percent: 100, path: 'C:/Downloads/zoo.mp4', updatedAt: 2 },
  });
  assert.equal(completed.downloads[0].active, false);
  assert.equal(completed.downloads[0].path, 'C:/Downloads/zoo.mp4');
  assert.equal(completed.downloads[0].statusLabel, 'Concluído');
});

test('reconciles a completed relocation with its existing download card without duplication', () => {
  const started = reduceState(
    { ...initialState, status: 'results', items: [directItem] },
    { type: 'DIRECT_SENT', id: directItem.id, selectedIndex: 0, downloadId: 42 },
  );
  const complete = reduceState(started, {
    type: 'DOWNLOAD_RELOCATION_UPDATED',
    record: {
      downloadId: 42,
      operationId: 'direct-42',
      mediaKind: 'direct',
      mediaUrl: directItem.url,
      displayName: directItem.filename,
      status: 'complete',
      stagingPath: 'C:\\Temp\\aula.mp4',
      finalPath: 'D:\\Vídeos\\aula.mp4',
      errorCode: null,
      updatedAt: 2,
    },
  });

  assert.equal(complete.items.length, 1);
  assert.equal(complete.items[0].phase, 'complete');
  assert.equal(complete.items[0].finalPath, 'D:\\Vídeos\\aula.mp4');
  assert.equal(complete.items[0].statusLabel, 'Salvo em D:\\Vídeos\\aula.mp4');
});

test('restores a failed relocation with its preserved path and settings action', () => {
  const state = reduceState(initialState, {
    type: 'DOWNLOAD_RELOCATION_UPDATED',
    record: {
      downloadId: 9,
      operationId: 'hls-9',
      mediaKind: 'hls',
      mediaUrl: 'https://cdn.test/master.m3u8',
      displayName: 'aula.ts',
      status: 'moveFailed',
      stagingPath: 'C:\\Downloads\\Video Radar\\aula.ts',
      finalPath: null,
      errorCode: 'DESTINATION_MOVE_FAILED',
      updatedAt: 3,
    },
  });

  assert.equal(state.items.length, 0);
  assert.equal(state.downloads.length, 1);
  assert.equal(state.downloads[0].phase, 'error');
  assert.equal(state.downloads[0].stagingPath, 'C:\\Downloads\\Video Radar\\aula.ts');
  assert.equal(state.downloads[0].action, 'open-download-settings');
  assert.match(state.downloads[0].statusLabel, /Arquivo preservado/);
});

test('a cancelled YouTube folder prompt returns the ready card without an error', () => {
  const item = {
    id: 'youtube:jNQXAC9IVRw',
    kind: 'youtube',
    phase: 'preparing',
    active: false,
    statusLabel: 'Preparando…',
  };
  const state = reduceState(
    { ...initialState, status: 'results', items: [item], busyId: item.id },
    { type: 'YOUTUBE_START_CANCELLED', id: item.id },
  );

  assert.equal(state.items[0].phase, 'ready');
  assert.equal(state.items[0].statusLabel, '');
  assert.equal(state.busyId, null);
  assert.equal(state.message, 'Download cancelado');
});

test('marks a social download pending immediately and blocks quality changes', () => {
  const item = {
    id: 'tiktok:42', kind: 'remote-media', phase: 'ready', active: false,
    filename: 'video-720p.mp4', selectedIndex: 0,
    variants: [
      { height: 720, label: '720p', container: 'mp4', filename: 'video-720p.mp4' },
      { height: 480, label: '480p', container: 'mp4', filename: 'video-480p.mp4' },
    ],
  };
  const pending = reduceState(
    { ...initialState, status: 'results', items: [item] },
    { type: 'MEDIA_DOWNLOAD_STARTED', id: item.id, selectedIndex: 0, kind: item.kind },
  );
  const unchanged = reduceState(pending, {
    type: 'QUALITY_SELECTED', id: item.id, selectedIndex: 1,
  });

  assert.equal(pending.items[0].phase, 'preparing');
  assert.equal(pending.items[0].statusLabel, 'Iniciando download…');
  assert.equal(unchanged.items[0].selectedIndex, 0);
});

test('keeps a completed download revealable when Explorer fails', () => {
  const item = {
    ...directItem,
    phase: 'complete',
    finalPath: 'D:\\Vídeos\\aula.mp4',
    statusLabel: 'Download concluído',
  };
  const failed = reduceState(
    { ...initialState, status: 'results', items: [item] },
    { type: 'REVEAL_FAILED', id: item.id },
  );

  assert.equal(failed.items[0].phase, 'complete');
  assert.equal(failed.items[0].finalPath, item.finalPath);
  assert.match(failed.items[0].statusLabel, /Explorer/);
});
