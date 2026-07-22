import assert from 'node:assert/strict';
import test from 'node:test';

import { assertJobSnapshot, normalizeJobView } from '../src/youtube/job-view.js';

const job = { jobId: 'j1', videoId: 'jNQXAC9IVRw', title: 'Me at the zoo', height: 720, stage: 'video', percent: 50, path: null, errorCode: null };

test('valida snapshots e expõe a visão PT para cada estado público', () => {
  assert.deepEqual(assertJobSnapshot(job), job);
  assert.deepEqual(normalizeJobView(job), { ...job, statusLabel: 'Baixando vídeo…', active: true });
  const labels = {
    preparing: 'Preparando…', video: 'Baixando vídeo…', audio: 'Baixando áudio…', merge: 'Combinando…',
    finalize: 'Finalizando…', complete: 'Concluído', cancelled: 'Cancelado', failed: 'Falhou', interrupted: 'Interrompido',
  };
  for (const [stage, statusLabel] of Object.entries(labels)) {
    const view = normalizeJobView({ ...job, stage });
    assert.equal(view.statusLabel, statusLabel);
    assert.equal(view.active, ['preparing', 'video', 'audio', 'merge', 'finalize'].includes(stage));
  }
});

test('preserva desconhecidos, limita percent confiável e nunca publica download', () => {
  assert.equal(normalizeJobView({ ...job, percent: null }).percent, null);
  assert.equal(normalizeJobView({ ...job, percent: 200 }).percent, 100);
  assert.deepEqual(assertJobSnapshot({ ...job, stage: 'download' }), { ...job, stage: 'video' });
  assert.throws(() => assertJobSnapshot({ ...job, stage: 'unknown' }), /Mensagem inválida/);
  assert.throws(() => assertJobSnapshot({ ...job, videoId: '' }), /Mensagem inválida/);
  assert.deepEqual(assertJobSnapshot({ ...job, videoId: '', title: '', stage: 'preparing', percent: null }), { ...job, videoId: '', title: '', stage: 'preparing', percent: null });
});
