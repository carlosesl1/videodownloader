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

test('resolves relative media URLs without page mutation', () => {
  const originalDocument = globalThis.document;
  const originalPerformance = globalThis.performance;
  const originalLocation = globalThis.location;

  globalThis.document = {
    title: 'Curso',
    querySelectorAll() {
      return [{
        currentSrc: '/media/aula.mp4',
        src: '',
        videoWidth: 640,
        videoHeight: 360,
        getAttribute() { return null; },
        title: '',
        querySelectorAll() { return []; },
      }];
    },
  };
  globalThis.performance = { getEntriesByType() { return []; } };
  globalThis.location = { href: 'https://site.test/course/lesson' };

  try {
    assert.equal(scanPage().candidates[0].url, 'https://site.test/media/aula.mp4');
  } finally {
    globalThis.document = originalDocument;
    globalThis.performance = originalPerformance;
    globalThis.location = originalLocation;
  }
});
