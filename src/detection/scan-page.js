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
  };

  const candidates = [];
  const videos = document.querySelectorAll('video');

  videos.forEach((video, index) => {
    const groupKey = `video-${index}`;
    const label = video.getAttribute('aria-label') || video.title || '';
    const currentRawUrl = video.currentSrc || video.src;
    const currentUrl = resolveUrl(currentRawUrl);
    const currentType = video.getAttribute?.('type') || video.type || '';
    const sources = Array.from(video.querySelectorAll('source')).map((source) => ({
      url: resolveUrl(source.src || source.getAttribute?.('src')),
      type: source.type || source.getAttribute?.('type') || '',
    }));
    const selectedSource = currentUrl && sources.find((source) => source.url === currentUrl);
    let selectedType = currentType;
    let currentKind = currentUrl && classify(currentUrl, selectedType);
    if (!currentKind && selectedSource) {
      selectedType = selectedSource.type;
      currentKind = classify(currentUrl, selectedType);
    }

    if (currentUrl) {
      if (currentKind) {
        candidates.push({
          url: currentUrl,
          type: selectedType,
          label,
          width: video.videoWidth || undefined,
          height: video.videoHeight || undefined,
          kind: currentKind,
          source: 'dom-current',
          groupKey,
        });
      }
    }

    sources.forEach((source) => {
      if (!source.url) return;
      const kind = classify(source.url, source.type);
      if (!kind) return;
      candidates.push({
        url: source.url,
        type: source.type,
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
    candidates.push({
      url,
      type: '',
      label: '',
      kind,
      source: 'performance',
      startTime: Number.isFinite(entry.startTime) ? entry.startTime : undefined,
    });
  });

  return { pageTitle: document.title, candidates };
}
