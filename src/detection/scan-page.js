export function scanPage() {
  const resolveUrl = (value) => {
    if (typeof value !== 'string' || value.trim() === '') return null;
    try {
      return new URL(value, location.href).href;
    } catch {
      return null;
    }
  };

  const classify = (url, type) => {
    let pathname = '';
    try {
      pathname = new URL(url).pathname.toLowerCase();
    } catch {
      return null;
    }

    const mime = typeof type === 'string' ? type.toLowerCase() : '';
    if (pathname.endsWith('.m3u8') || mime.includes('mpegurl')) return 'hls';
    if (
      /\.(mp4|webm|mov)$/.test(pathname) ||
      ['video/mp4', 'video/webm', 'video/quicktime'].includes(mime)
    ) {
      return 'direct';
    }
    return null;
  };

  const candidates = [];
  const videos = document.querySelectorAll('video');

  videos.forEach((video, index) => {
    const groupKey = `video-${index}`;
    const label = video.getAttribute('aria-label') || video.title || '';
    const currentRawUrl = video.currentSrc || video.src;
    const currentUrl = resolveUrl(currentRawUrl);
    const currentType = video.getAttribute?.('type') || video.type || '';

    if (currentUrl) {
      const kind = classify(currentUrl, currentType);
      if (kind) {
        candidates.push({
          url: currentUrl,
          type: currentType,
          label,
          width: video.videoWidth || undefined,
          height: video.videoHeight || undefined,
          kind,
          source: 'dom-current',
          groupKey,
        });
      }
    }

    video.querySelectorAll('source').forEach((source) => {
      const sourceRawUrl = source.src || source.getAttribute?.('src');
      const sourceUrl = resolveUrl(sourceRawUrl);
      const type = source.type || source.getAttribute?.('type') || '';
      if (!sourceUrl) return;
      const kind = classify(sourceUrl, type);
      if (!kind) return;
      candidates.push({
        url: sourceUrl,
        type,
        label,
        kind,
        source: 'dom-source',
        groupKey,
      });
    });
  });

  const entries = typeof performance?.getEntriesByType === 'function'
    ? performance.getEntriesByType('resource')
    : [];
  entries.forEach((entry) => {
    const url = resolveUrl(entry.name);
    if (!url) return;
    const kind = classify(url, entry.initiatorType || '');
    if (!kind) return;
    candidates.push({ url, type: '', label: '', kind, source: 'performance' });
  });

  return { pageTitle: document.title, candidates };
}
