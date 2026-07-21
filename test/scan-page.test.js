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
