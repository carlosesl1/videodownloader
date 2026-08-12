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
  const allVideos = Array.from(document.querySelectorAll('video'));
  let pageHostname = String(location.hostname || '');
  if (!pageHostname) {
    try {
      pageHostname = new URL(location.href).hostname;
    } catch {
      pageHostname = '';
    }
  }
  const instagramFeed = /(^|\.)instagram\.com$/i.test(pageHostname);
  const tiktokFeed = /(^|\.)tiktok\.com$/i.test(pageHostname);
  const focusedFeed = instagramFeed || tiktokFeed;
  const viewportWidth = Number(globalThis.innerWidth) || document.documentElement?.clientWidth || 0;
  const viewportHeight = Number(globalThis.innerHeight) || document.documentElement?.clientHeight || 0;

  const visibleArea = (video) => {
    if (typeof video.getBoundingClientRect !== 'function' || viewportWidth <= 0 || viewportHeight <= 0) {
      return 0;
    }
    const rect = video.getBoundingClientRect();
    const left = Math.max(0, Number(rect.left) || 0);
    const top = Math.max(0, Number(rect.top) || 0);
    const right = Math.min(viewportWidth, Number(rect.right) || 0);
    const bottom = Math.min(viewportHeight, Number(rect.bottom) || 0);
    return Math.max(0, right - left) * Math.max(0, bottom - top);
  };

  const videos = focusedFeed
    ? allVideos
      .map((video) => ({ video, area: visibleArea(video) }))
      .filter(({ area }) => area > 0)
      .sort((left, right) => right.area - left.area)
      .slice(0, 1)
      .map(({ video }) => video)
    : allVideos;
  let focusedPageUrl = null;

  const canonicalTikTokPostUrl = (value) => {
    const resolved = resolveUrl(value);
    if (!resolved) return null;
    try {
      const parsed = new URL(resolved);
      if (!/(^|\.)tiktok\.com$/i.test(parsed.hostname)) return null;
      const match = /^\/@([A-Za-z0-9._-]{1,64})\/video\/(\d{10,30})\/?$/.exec(parsed.pathname);
      return match
        ? `https://www.tiktok.com/@${match[1]}/video/${match[2]}`
        : null;
    } catch {
      return null;
    }
  };

  const findTikTokPost = (video) => {
    let node = video;
    for (let depth = 0; node && depth < 12 && node !== document.body; depth += 1) {
      const anchors = typeof node.querySelectorAll === 'function'
        ? Array.from(node.querySelectorAll('a[href]')).slice(0, 100)
        : [];
      for (const anchor of anchors) {
        const postUrl = canonicalTikTokPostUrl(
          anchor.href || anchor.getAttribute?.('href'),
        );
        if (postUrl) return { postUrl, container: node };
      }
      node = node.parentElement;
    }
    return { postUrl: null, container: null };
  };

  videos.forEach((video, index) => {
    const groupKey = `video-${index}`;
    const article = instagramFeed && typeof video.closest === 'function'
      ? video.closest('article')
      : null;
    const tiktokPost = tiktokFeed
      ? findTikTokPost(video)
      : { postUrl: null, container: null };
    const context = article || tiktokPost.container;
    const contextLabel = String(context?.innerText || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)
      ?.slice(0, 200) || '';
    const label = video.getAttribute('aria-label') || video.title || contextLabel;
    if (instagramFeed && !focusedPageUrl) {
      const postLink = article?.querySelector?.(
        'a[href*="/reel/"], a[href*="/reels/"], a[href*="/p/"], a[href*="/tv/"]',
      ) ?? video.closest?.('a[href]');
      focusedPageUrl = resolveUrl(postLink?.href || postLink?.getAttribute?.('href'));
    } else if (tiktokFeed && !focusedPageUrl) {
      focusedPageUrl = tiktokPost.postUrl;
    }
    if (tiktokFeed) return;

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

  const entries = !focusedFeed && typeof performance?.getEntriesByType === 'function'
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

  return {
    pageTitle: document.title,
    candidates,
    ...(focusedPageUrl ? { focusedPageUrl } : {}),
  };
}
