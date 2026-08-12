export const HLS_OPERATION_PREFIX = 'hlsOperation:';
export const HLS_OPERATION_INDEX = 'hlsOperationIndex';
export const HLS_INSPECTION_PREFIX = 'hlsInspection:';
export const HLS_INSPECTION_INDEX = 'hlsInspectionIndex';
export const HLS_INDEX_MIGRATION = 'hlsIndexMigration';

export const RELOCATION_PREFIX = 'downloadRelocation:';
export const RELOCATION_INDEX = 'downloadRelocationIndex';
export const RELOCATION_INTENT_INDEX = 'downloadRelocationIntentIndex';
export const DELIVERY_RESULT_PREFIX = 'downloadDeliveryResult:';
export const DELIVERY_RESULT_INDEX = 'downloadDeliveryResultIndex';
export const RELOCATION_INDEX_MIGRATION = 'downloadRelocationIndexMigration';
export const OWNED_HOST_PERMISSION_PATTERNS = 'ownedHostPermissionPatterns';
export const HOST_PERMISSION_CLAIMS = 'hostPermissionClaims';
export const DOWNLOAD_QUEUE_JOBS = 'downloadQueueJobs';

export function stringIndex(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry) => typeof entry === 'string' && entry.length > 0))];
}

export function downloadIdIndex(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry) => Number.isSafeInteger(entry) && entry >= 0))];
}
