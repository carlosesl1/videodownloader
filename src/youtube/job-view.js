const INVALID = 'Mensagem inválida';
const STAGES = new Set(['queued', 'running', 'paused', 'preparing', 'video', 'audio', 'merge', 'finalize', 'complete', 'cancelled', 'failed', 'interrupted']);
const LABELS = Object.freeze({
  queued: 'Na fila…', running: 'Em andamento…', paused: 'Pausado',
  preparing: 'Preparando…', video: 'Baixando vídeo…', audio: 'Baixando áudio…', merge: 'Combinando…',
  finalize: 'Finalizando…', complete: 'Concluído', cancelled: 'Cancelado', failed: 'Falhou', interrupted: 'Interrompido',
});
const ACTIVE = new Set(['queued', 'running', 'preparing', 'video', 'audio', 'merge', 'finalize']);
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MEDIA_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function invalid() { throw new Error(INVALID); }
function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function boundedString(value, maximum, allowEmpty = false) {
  return typeof value === 'string' && value.length <= maximum && (allowEmpty || value.length > 0);
}
function nullableString(value, maximum) { return value === null || boundedString(value, maximum); }

/** Validates the public job snapshot and maps the host-only `download` stage at the boundary. */
export function assertJobSnapshot(snapshot) {
  if (!plainObject(snapshot)) invalid();
  const {
    jobId, operationId = null, videoId, title, height, percent, path, errorCode,
  } = snapshot;
  const stage = snapshot.stage === 'download' ? 'video' : snapshot.stage;
  if (typeof jobId !== 'string' || !SAFE_ID.test(jobId)
    || !(operationId === null || (typeof operationId === 'string' && SAFE_ID.test(operationId)))
    || !boundedString(videoId, 128, true) || (videoId && !MEDIA_ID.test(videoId))
    || !boundedString(title, 512, true) || !Number.isSafeInteger(height) || height < 0 || height > 4320
    || (height === 0 && !['queued', 'running', 'paused', 'preparing', 'audio', 'finalize', 'complete', 'cancelled', 'failed', 'interrupted'].includes(stage))
    || !STAGES.has(stage) || !(percent === null || (Number.isFinite(percent) && typeof percent === 'number'))
    || !nullableString(path, 1024) || !nullableString(errorCode, 64)) invalid();
  if ((videoId === '' || title === '') && stage !== 'preparing') invalid();
  return {
    jobId,
    ...(operationId === null ? {} : { operationId }),
    videoId,
    title,
    height,
    stage,
    percent,
    path,
    errorCode,
  };
}

export const JOB_STAGE_LABELS = LABELS;

/** Produces popup-ready status without fabricating an unknown percentage or total. */
export function normalizeJobView(snapshot) {
  const job = assertJobSnapshot(snapshot);
  return {
    ...job,
    percent: job.percent === null ? null : Math.max(0, Math.min(100, job.percent)),
    statusLabel: LABELS[job.stage],
    active: ACTIVE.has(job.stage),
  };
}
