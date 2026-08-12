import assert from 'node:assert/strict';
import test from 'node:test';
import { scanPage } from '../src/detection/scan-page.js';

test('scans current video, source variants, and HLS network resources', () => {
  const originalDocument = globalThis.document;
  const originalPerformance = globalThis.performance;
  const originalLocation = globalThis.location;

  const source = {
    src: 'https://site.test/video-1080.mp4',
    type: 'video/mp4',
  };
  const video = {
    currentSrc: 'https://site.test/video-720.mp4?sig=1#time',
    src: '',
    videoWidth: 1280,
    videoHeight: 720,
    getAttribute(name) {
      return name === 'aria-label' ? 'Aula' : null;
    },
    title: '',
    querySelectorAll(selector) {
      return selector === 'source' ? [source] : [];
    },
  };

  globalThis.document = {
    title: 'Curso',
    querySelectorAll(selector) {
      return selector === 'video' ? [video] : [];
    },
  };
  globalThis.performance = {
    getEntriesByType(type) {
      return type === 'resource' ? [{ name: 'https://cdn.test/master.m3u8?token=x' }] : [];
    },
  };
  globalThis.location = { href: 'https://site.test/lesson' };

  try {
    const result = scanPage();

    assert.equal(result.pageTitle, 'Curso');
    assert.equal(result.candidates.length, 3);
    assert.deepEqual(result.candidates[0], {
      url: 'https://site.test/video-720.mp4?sig=1#time',
      type: '',
      label: 'Aula',
      width: 1280,
      height: 720,
      kind: 'direct',
      source: 'dom-current',
      groupKey: 'video-0',
    });
    assert.equal(result.candidates[2].kind, 'hls');
  } finally {
    globalThis.document = originalDocument;
    globalThis.performance = originalPerformance;
    globalThis.location = originalLocation;
  }
});

test('resolves relative media URLs without mutating the page or registering listeners', () => {
  const originalDocument = globalThis.document;
  const originalPerformance = globalThis.performance;
  const originalLocation = globalThis.location;
  let mutationOrListenerCalls = 0;
  const video = {
    currentSrc: '/media/aula.mp4',
    src: '',
    videoWidth: 640,
    videoHeight: 360,
    getAttribute() { return null; },
    title: '',
    querySelectorAll() { return []; },
    addEventListener() { mutationOrListenerCalls += 1; },
    removeEventListener() { mutationOrListenerCalls += 1; },
  };

  globalThis.document = {
    title: 'Curso',
    querySelectorAll() {
      return [video];
    },
    addEventListener() { mutationOrListenerCalls += 1; },
    removeEventListener() { mutationOrListenerCalls += 1; },
    createElement() { mutationOrListenerCalls += 1; },
  };
  globalThis.performance = { getEntriesByType() { return []; } };
  globalThis.location = { href: 'https://site.test/course/lesson' };

  try {
    assert.equal(scanPage().candidates[0].url, 'https://site.test/media/aula.mp4');
    assert.equal(mutationOrListenerCalls, 0);
  } finally {
    globalThis.document = originalDocument;
    globalThis.performance = originalPerformance;
    globalThis.location = originalLocation;
  }
});

test('classifies extensionless current video URLs from parameterized MIME types', () => {
  const originalDocument = globalThis.document;
  const originalPerformance = globalThis.performance;
  const originalLocation = globalThis.location;

  globalThis.document = {
    title: 'Curso',
    querySelectorAll() {
      return [{
        currentSrc: 'https://site.test/playback',
        src: '',
        type: 'video/mp4; codecs=avc1.42E01E',
        videoWidth: 1280,
        videoHeight: 720,
        getAttribute() { return null; },
        title: '',
        querySelectorAll() { return []; },
      }];
    },
  };
  globalThis.performance = { getEntriesByType() { return []; } };
  globalThis.location = { href: 'https://site.test/lesson' };

  try {
    const [candidate] = scanPage().candidates;
    assert.equal(candidate.kind, 'direct');
    assert.equal(candidate.width, 1280);
    assert.equal(candidate.height, 720);
  } finally {
    globalThis.document = originalDocument;
    globalThis.performance = originalPerformance;
    globalThis.location = originalLocation;
  }
});

test('uses a matching source MIME for extensionless current video without sizing inactive sources', () => {
  const originalDocument = globalThis.document;
  const originalPerformance = globalThis.performance;
  const originalLocation = globalThis.location;
  const selectedSource = { src: 'https://site.test/stream', type: 'application/vnd.apple.mpegurl' };
  const inactiveSource = { src: 'https://site.test/backup', type: 'video/mp4; codecs=avc1' };

  globalThis.document = {
    title: 'Curso',
    querySelectorAll() {
      return [{
        currentSrc: 'https://site.test/stream',
        src: '',
        videoWidth: 1920,
        videoHeight: 1080,
        getAttribute() { return null; },
        title: '',
        querySelectorAll() { return [selectedSource, inactiveSource]; },
      }];
    },
  };
  globalThis.performance = { getEntriesByType() { return []; } };
  globalThis.location = { href: 'https://site.test/lesson' };

  try {
    const candidates = scanPage().candidates;
    const selected = candidates.find((candidate) => candidate.source === 'dom-current');
    const inactive = candidates.find((candidate) => candidate.url === inactiveSource.src);

    assert.equal(selected.kind, 'hls');
    assert.equal(selected.type, 'application/vnd.apple.mpegurl');
    assert.equal(selected.width, 1920);
    assert.equal(selected.height, 1080);
    assert.equal(inactive.width, undefined);
    assert.equal(inactive.height, undefined);
  } finally {
    globalThis.document = originalDocument;
    globalThis.performance = originalPerformance;
    globalThis.location = originalLocation;
  }
});

test('on an Instagram feed keeps only the most visible video and identifies its post', () => {
  const originalDocument = globalThis.document;
  const originalPerformance = globalThis.performance;
  const originalLocation = globalThis.location;
  const originalInnerWidth = globalThis.innerWidth;
  const originalInnerHeight = globalThis.innerHeight;

  function instagramVideo(url, rect, postUrl, label) {
    const article = {
      innerText: `${label}\nCurtidas e comentários`,
      querySelector(selector) {
        return selector.includes('a[href') ? { href: postUrl } : null;
      },
    };
    return {
      currentSrc: url,
      src: '',
      videoWidth: 1080,
      videoHeight: 1920,
      title: '',
      getAttribute() { return null; },
      querySelectorAll() { return []; },
      getBoundingClientRect() { return rect; },
      closest(selector) {
        if (selector === 'article') return article;
        if (selector === 'a[href]') return null;
        return null;
      },
    };
  }

  const focused = instagramVideo(
    'https://scontent.cdninstagram.com/focused.mp4?token=1',
    { left: 200, top: 100, right: 800, bottom: 800, width: 600, height: 700 },
    'https://www.instagram.com/reel/C8x_example/?igsh=feed',
    'Vídeo em destaque',
  );
  const partial = instagramVideo(
    'https://scontent.cdninstagram.com/partial.mp4?token=2',
    { left: 200, top: 850, right: 800, bottom: 1200, width: 600, height: 350 },
    'https://www.instagram.com/reel/C8x_partial/',
    'Próximo vídeo',
  );
  const hidden = instagramVideo(
    'https://scontent.cdninstagram.com/hidden.mp4?token=3',
    { left: 200, top: 1300, right: 800, bottom: 1800, width: 600, height: 500 },
    'https://www.instagram.com/reel/C8x_hidden/',
    'Vídeo fora da tela',
  );

  globalThis.document = {
    title: 'Instagram',
    documentElement: { clientWidth: 1000, clientHeight: 900 },
    querySelectorAll(selector) {
      return selector === 'video' ? [partial, hidden, focused] : [];
    },
  };
  globalThis.performance = {
    getEntriesByType() {
      return Array.from({ length: 200 }, (_, index) => ({
        name: `https://scontent.cdninstagram.com/history-${index}.mp4`,
        initiatorType: 'video',
      }));
    },
  };
  globalThis.location = { href: 'https://www.instagram.com/' };
  globalThis.innerWidth = 1000;
  globalThis.innerHeight = 900;

  try {
    const result = scanPage();

    assert.equal(result.focusedPageUrl, 'https://www.instagram.com/reel/C8x_example/?igsh=feed');
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].url, 'https://scontent.cdninstagram.com/focused.mp4?token=1');
    assert.equal(result.candidates[0].label, 'Vídeo em destaque');
    assert.equal(result.candidates[0].source, 'dom-current');
  } finally {
    globalThis.document = originalDocument;
    globalThis.performance = originalPerformance;
    globalThis.location = originalLocation;
    globalThis.innerWidth = originalInnerWidth;
    globalThis.innerHeight = originalInnerHeight;
  }
});

test('on a TikTok feed resolves the visible card instead of a stale playback URL', () => {
  const originalDocument = globalThis.document;
  const originalPerformance = globalThis.performance;
  const originalLocation = globalThis.location;
  const originalInnerWidth = globalThis.innerWidth;
  const originalInnerHeight = globalThis.innerHeight;

  function tiktokVideo(url, rect, postUrl, label, paused = true) {
    const anchor = {
      href: postUrl,
      getAttribute(name) {
        return name === 'href' ? postUrl : null;
      },
    };
    const card = {
      innerText: `${label}\nCurtidas e comentários`,
      parentElement: null,
      querySelectorAll(selector) {
        return selector === 'a[href]' ? [anchor] : [];
      },
      querySelector() {
        return null;
      },
    };
    return {
      currentSrc: url,
      src: '',
      type: 'video/mp4',
      paused,
      ended: false,
      videoWidth: 1080,
      videoHeight: 1920,
      title: '',
      parentElement: card,
      getAttribute(name) {
        return name === 'type' ? 'video/mp4' : null;
      },
      querySelectorAll() { return []; },
      getBoundingClientRect() { return rect; },
      closest() { return null; },
    };
  }

  const stale = tiktokVideo(
    'https://v16-webapp-prime.tiktok.com/playback?video_id=1111111111111111111',
    { left: 240, top: -780, right: 760, bottom: -80 },
    'https://www.tiktok.com/@stale/video/1111111111111111111',
    'Vídeo anterior',
  );
  const focused = tiktokVideo(
    'https://v16-webapp-prime.tiktok.com/playback?video_id=7488298911734435077',
    { left: 240, top: 80, right: 760, bottom: 820 },
    '/@video.radar/video/7488298911734435077?is_from_webapp=1',
    'Vídeo atual',
    false,
  );
  const next = tiktokVideo(
    'https://v16-webapp-prime.tiktok.com/playback?video_id=2222222222222222222',
    { left: 240, top: 920, right: 760, bottom: 1660 },
    'https://www.tiktok.com/@next/video/2222222222222222222',
    'Próximo vídeo',
  );

  globalThis.document = {
    title: 'TikTok - Make Your Day',
    body: {},
    documentElement: { clientWidth: 1000, clientHeight: 900 },
    querySelectorAll(selector) {
      return selector === 'video' ? [stale, next, focused] : [];
    },
  };
  globalThis.performance = {
    getEntriesByType() {
      return Array.from({ length: 50 }, (_, index) => ({
        name: `https://v16-webapp-prime.tiktok.com/playback?history=${index}`,
        initiatorType: 'video/mp4',
      }));
    },
  };
  globalThis.location = {
    href: 'https://www.tiktok.com/foryou?lang=pt-BR',
    hostname: 'www.tiktok.com',
  };
  globalThis.innerWidth = 1000;
  globalThis.innerHeight = 900;

  try {
    const result = scanPage();

    assert.equal(
      result.focusedPageUrl,
      'https://www.tiktok.com/@video.radar/video/7488298911734435077',
    );
    assert.deepEqual(result.candidates, []);
  } finally {
    globalThis.document = originalDocument;
    globalThis.performance = originalPerformance;
    globalThis.location = originalLocation;
    globalThis.innerWidth = originalInnerWidth;
    globalThis.innerHeight = originalInnerHeight;
  }
});

test('bounds videos and the structured-clone payload before returning scan results', () => {
  const originalDocument = globalThis.document;
  const originalPerformance = globalThis.performance;
  const originalLocation = globalThis.location;
  let currentSourceReads = 0;
  let performanceReads = 0;
  const videos = Array.from({ length: 500 }, (_, index) => ({
    get currentSrc() {
      currentSourceReads += 1;
      return `https://cdn.test/video-${index}.mp4`;
    },
    src: '',
    videoWidth: 1280,
    videoHeight: 720,
    getAttribute() { return null; },
    title: '',
    querySelectorAll() { return []; },
  }));

  globalThis.document = {
    title: 'A'.repeat(5_000),
    querySelectorAll(selector) {
      return selector === 'video' ? videos : [];
    },
  };
  globalThis.performance = {
    getEntriesByType() {
      performanceReads += 1;
      return [];
    },
  };
  globalThis.location = { href: 'https://site.test/lesson' };

  try {
    const result = scanPage();

    assert.equal(result.pageTitle.length, 1_000);
    assert.equal(result.candidates.length, 200);
    assert.equal(currentSourceReads, 200);
    assert.equal(performanceReads, 0);
  } finally {
    globalThis.document = originalDocument;
    globalThis.performance = originalPerformance;
    globalThis.location = originalLocation;
  }
});

test('caps source work and prioritizes recent bounded performance entries', () => {
  const originalDocument = globalThis.document;
  const originalPerformance = globalThis.performance;
  const originalLocation = globalThis.location;
  let sourceReads = 0;
  const sourceNodes = new Proxy({ length: 10_000 }, {
    get(target, property) {
      if (typeof property === 'string' && /^\d+$/.test(property)) {
        sourceReads += 1;
        return { src: `https://cdn.test/poster-${property}.jpg`, type: 'image/jpeg' };
      }
      return target[property];
    },
  });
  const video = {
    currentSrc: '',
    src: '',
    videoWidth: 0,
    videoHeight: 0,
    getAttribute() { return null; },
    title: '',
    querySelectorAll(selector) {
      return selector === 'source' ? sourceNodes : [];
    },
  };

  globalThis.document = {
    title: 'Curso',
    querySelectorAll(selector) {
      return selector === 'video' ? [video] : [];
    },
  };
  globalThis.performance = {
    getEntriesByType() {
      return Array.from({ length: 2_000 }, (_, index) => ({
        name: `https://cdn.test/recent-${index}.mp4`,
        startTime: index,
      }));
    },
  };
  globalThis.location = { href: 'https://site.test/lesson' };

  try {
    const result = scanPage();

    assert.equal(sourceReads, 50);
    assert.equal(result.candidates.length, 200);
    assert.equal(result.candidates[0].url, 'https://cdn.test/recent-1999.mp4');
    assert.equal(result.candidates.at(-1).url, 'https://cdn.test/recent-1800.mp4');
  } finally {
    globalThis.document = originalDocument;
    globalThis.performance = originalPerformance;
    globalThis.location = originalLocation;
  }
});
