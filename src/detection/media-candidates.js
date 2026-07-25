function inferKind(url, type) {
  const pathname = url.pathname.toLowerCase();
  const mime = String(type || '').split(';', 1)[0].trim().toLowerCase();
  if (
    pathname.endsWith('.m3u8') ||
    [
      'application/vnd.apple.mpegurl',
      'application/x-mpegurl',
      'audio/mpegurl',
      'audio/x-mpegurl',
    ].includes(mime)
  ) {
    return 'hls';
  }
  if (
    /\.(mp4|webm|mov)$/.test(pathname) ||
    ['video/mp4', 'video/webm', 'video/quicktime'].includes(mime)
  ) {
    return 'direct';
  }
  return null;
}

function sourceRank(source) {
  if (typeof source !== 'string') return 0;
  if (source.startsWith('dom')) return 2;
  if (source === 'performance') return 1;
  return 0;
}

function mergeCandidate(first, second) {
  const firstRank = sourceRank(first.source);
  const secondRank = sourceRank(second.source);
  const secondIsNewer = Number.isFinite(second.startTime)
    && (!Number.isFinite(first.startTime) || second.startTime > first.startTime);
  const preferred = secondRank > firstRank || (secondRank === firstRank && secondIsNewer)
    ? second
    : first;
  const other = preferred === first ? second : first;
  const merged = { ...other, ...preferred };

  for (const field of ['width', 'height', 'label', 'type', 'groupKey']) {
    if (merged[field] === undefined || merged[field] === null || merged[field] === '') {
      merged[field] = other[field];
    }
  }
  return merged;
}

export function normalizeCandidates(candidates) {
  const byIdentity = new Map();

  for (const candidate of candidates || []) {
    if (!candidate || typeof candidate.url !== 'string') continue;
    let parsed;
    try {
      parsed = new URL(candidate.url);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    parsed.hash = '';
    const kind = candidate.kind || inferKind(parsed, candidate.type);
    if (kind !== 'direct' && kind !== 'hls') continue;

    const normalized = { ...candidate, url: parsed.href, kind };
    const identity = kind === 'hls' ? `${parsed.origin}${parsed.pathname}` : parsed.href;
    const existing = byIdentity.get(identity);
    byIdentity.set(identity, existing ? mergeCandidate(existing, normalized) : normalized);
  }

  return [...byIdentity.values()];
}

export function groupDirectVariants(items) {
  const groups = [];
  const directGroups = new Map();

  for (const item of items || []) {
    if (item?.kind === 'direct' && item.groupKey) {
      let group = directGroups.get(item.groupKey);
      if (!group) {
        group = { id: `direct-${item.groupKey}`, kind: 'direct', variants: [] };
        directGroups.set(item.groupKey, group);
        groups.push(group);
      }
      group.variants.push(item);
      continue;
    }

    if (item) groups.push({ id: `${item.kind || 'unknown'}-${item.url}`, kind: item.kind, variants: [item] });
  }

  for (const group of groups) {
    group.variants.sort((left, right) => {
      const leftHeight = Number.isFinite(left.height) ? left.height : -1;
      const rightHeight = Number.isFinite(right.height) ? right.height : -1;
      if (rightHeight !== leftHeight) return rightHeight - leftHeight;
      const leftWidth = Number.isFinite(left.width) ? left.width : -1;
      const rightWidth = Number.isFinite(right.width) ? right.width : -1;
      return rightWidth - leftWidth;
    });
  }

  return groups;
}
