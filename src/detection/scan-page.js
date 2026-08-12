export function scanPage() {
  // Keep every limit inside this function: Chromium serializes it for executeScript.
  const MAX_URL_LENGTH = 8_192;
  const MAX_PAGE_TITLE_LENGTH = 1_000;
  const MAX_LABEL_LENGTH = 500;
  const MAX_TYPE_LENGTH = 200;
  const MAX_CANDIDATES = 200;
  const MAX_VIDEO_ELEMENTS = 200;
  const MAX_SOURCE_ELEMENTS_PER_VIDEO = 50;
  const MAX_SOURCE_ELEMENTS_TOTAL = 1_000;
  const MAX_PERFORMANCE_ENTRIES = 1_000;
  const MAX_TIKTOK_ANCESTORS = 12;
  const MAX_TIKTOK_ANCHORS_PER_ANCESTOR = 100;
  const MAX_TIKTOK_ANCHORS_TOTAL = 1_200;
  const MAX_HIT_TEST_ELEMENTS = 20;

  const boundedText = (value, maximum) => String(value ?? '').slice(0, maximum);
  const resolveUrl = (value) => {
    if (typeof value !== 'string') return null;
    const input = value.trim();
    if (!input || input.length > MAX_URL_LENGTH) return null;
    try {
      const resolved = new URL(input, location.href).href;
      return resolved.length <= MAX_URL_LENGTH ? resolved : null;
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

    const mime = boundedText(type, MAX_TYPE_LENGTH).split(';', 1)[0].trim().toLowerCase();
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
  const addCandidate = (candidate) => {
    if (candidates.length >= MAX_CANDIDATES) return false;
    candidates.push(candidate);
    return true;
  };

  const videoNodes = document.querySelectorAll('video');
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
    if (typeof video?.getBoundingClientRect !== 'function' || viewportWidth <= 0 || viewportHeight <= 0) {
      return 0;
    }
    try {
      const rect = video.getBoundingClientRect();
      const left = Math.max(0, Number(rect.left) || 0);
      const top = Math.max(0, Number(rect.top) || 0);
      const right = Math.min(viewportWidth, Number(rect.right) || 0);
      const bottom = Math.min(viewportHeight, Number(rect.bottom) || 0);
      return Math.max(0, right - left) * Math.max(0, bottom - top);
    } catch {
      return 0;
    }
  };

  const videos = [];
  const videoCount = Math.min(Number(videoNodes?.length) || 0, MAX_VIDEO_ELEMENTS);
  if (focusedFeed) {
    let focusedVideo = null;
    let focusedArea = 0;

    if (typeof document.elementsFromPoint === 'function' && viewportWidth > 0 && viewportHeight > 0) {
      let hitElements = [];
      try {
        hitElements = document.elementsFromPoint(viewportWidth / 2, viewportHeight / 2);
      } catch {
        hitElements = [];
      }
      const hitCount = Math.min(Number(hitElements?.length) || 0, MAX_HIT_TEST_ELEMENTS);
      for (let index = 0; index < hitCount; index += 1) {
        const element = hitElements[index];
        const video = element?.matches?.('video')
          ? element
          : element?.closest?.('video');
        const area = visibleArea(video);
        if (area > focusedArea) {
          focusedVideo = video;
          focusedArea = area;
        }
      }
    }

    for (let index = 0; index < videoCount; index += 1) {
      const video = videoNodes[index];
      const area = visibleArea(video);
      if (area > focusedArea) {
        focusedVideo = video;
        focusedArea = area;
      }
    }
    if (focusedVideo) videos.push(focusedVideo);
  } else {
    for (let index = 0; index < videoCount; index += 1) videos.push(videoNodes[index]);
  }

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
    let remainingAnchors = MAX_TIKTOK_ANCHORS_TOTAL;
    for (
      let depth = 0;
      node && depth < MAX_TIKTOK_ANCESTORS && node !== document.body && remainingAnchors > 0;
      depth += 1
    ) {
      let anchors = [];
      try {
        anchors = typeof node.querySelectorAll === 'function'
          ? node.querySelectorAll('a[href]')
          : [];
      } catch {
        anchors = [];
      }
      const anchorCount = Math.min(
        Number(anchors?.length) || 0,
        MAX_TIKTOK_ANCHORS_PER_ANCESTOR,
        remainingAnchors,
      );
      for (let index = 0; index < anchorCount; index += 1) {
        const anchor = anchors[index];
        const postUrl = canonicalTikTokPostUrl(
          anchor?.href || anchor?.getAttribute?.('href'),
        );
        if (postUrl) return { postUrl, container: node };
      }
      remainingAnchors -= anchorCount;
      node = node.parentElement;
    }
    return { postUrl: null, container: null };
  };

  let remainingSources = MAX_SOURCE_ELEMENTS_TOTAL;
  for (let index = 0; index < videos.length && candidates.length < MAX_CANDIDATES; index += 1) {
    const video = videos[index];
    const groupKey = `video-${index}`;
    const article = instagramFeed && typeof video?.closest === 'function'
      ? video.closest('article')
      : null;
    const tiktokPost = tiktokFeed
      ? findTikTokPost(video)
      : { postUrl: null, container: null };
    const context = article || tiktokPost.container;
    const contextLabel = boundedText(context?.innerText, 1_000)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)
      ?.slice(0, 200) || '';
    const label = boundedText(
      video?.getAttribute?.('aria-label') || video?.title || contextLabel,
      MAX_LABEL_LENGTH,
    );
    if (instagramFeed && !focusedPageUrl) {
      const postLink = article?.querySelector?.(
        'a[href*="/reel/"], a[href*="/reels/"], a[href*="/p/"], a[href*="/tv/"]',
      ) ?? video?.closest?.('a[href]');
      focusedPageUrl = resolveUrl(postLink?.href || postLink?.getAttribute?.('href'));
    } else if (tiktokFeed && !focusedPageUrl) {
      focusedPageUrl = tiktokPost.postUrl;
    }
    if (tiktokFeed) continue;

    const currentRawUrl = video?.currentSrc || video?.src;
    const currentUrl = resolveUrl(currentRawUrl);
    const currentType = boundedText(
      video?.getAttribute?.('type') || video?.type,
      MAX_TYPE_LENGTH,
    );
    let sourceNodes = [];
    try {
      sourceNodes = typeof video?.querySelectorAll === 'function'
        ? video.querySelectorAll('source')
        : [];
    } catch {
      sourceNodes = [];
    }
    const sourceCount = Math.min(
      Number(sourceNodes?.length) || 0,
      MAX_SOURCE_ELEMENTS_PER_VIDEO,
      remainingSources,
    );
    const sources = [];
    for (let sourceIndex = 0; sourceIndex < sourceCount; sourceIndex += 1) {
      const source = sourceNodes[sourceIndex];
      sources.push({
        url: resolveUrl(source?.src || source?.getAttribute?.('src')),
        type: boundedText(source?.type || source?.getAttribute?.('type'), MAX_TYPE_LENGTH),
      });
    }
    remainingSources -= sourceCount;

    const selectedSource = currentUrl && sources.find((source) => source.url === currentUrl);
    let selectedType = currentType;
    let currentKind = currentUrl && classify(currentUrl, selectedType);
    if (!currentKind && selectedSource) {
      selectedType = selectedSource.type;
      currentKind = classify(currentUrl, selectedType);
    }

    if (currentUrl && currentKind) {
      addCandidate({
        url: currentUrl,
        type: selectedType,
        label,
        width: video?.videoWidth || undefined,
        height: video?.videoHeight || undefined,
        kind: currentKind,
        source: 'dom-current',
        groupKey,
      });
    }

    for (const source of sources) {
      if (candidates.length >= MAX_CANDIDATES) break;
      if (!source.url) continue;
      const kind = classify(source.url, source.type);
      if (!kind) continue;
      addCandidate({
        url: source.url,
        type: source.type,
        label,
        kind,
        source: 'dom-source',
        groupKey,
      });
    }
  }

  let entries = [];
  if (!focusedFeed && candidates.length < MAX_CANDIDATES
    && typeof globalThis.performance?.getEntriesByType === 'function') {
    try {
      entries = globalThis.performance.getEntriesByType('resource') || [];
    } catch {
      entries = [];
    }
  }
  const entryCount = Number(entries?.length) || 0;
  const firstEntry = Math.max(0, entryCount - MAX_PERFORMANCE_ENTRIES);
  for (
    let index = entryCount - 1;
    index >= firstEntry && candidates.length < MAX_CANDIDATES;
    index -= 1
  ) {
    const entry = entries[index];
    const url = resolveUrl(entry?.name);
    if (!url) continue;
    const kind = classify(url, entry?.initiatorType || '');
    if (!kind) continue;
    addCandidate({
      url,
      type: '',
      label: '',
      kind,
      source: 'performance',
      startTime: Number.isFinite(entry?.startTime) ? entry.startTime : undefined,
    });
  }

  return {
    pageTitle: boundedText(document.title, MAX_PAGE_TITLE_LENGTH),
    candidates,
    ...(focusedPageUrl ? { focusedPageUrl } : {}),
  };
}
