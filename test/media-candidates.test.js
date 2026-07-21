import assert from 'node:assert/strict';
import test from 'node:test';
import { groupDirectVariants, normalizeCandidates } from '../src/detection/media-candidates.js';

test('normalizes URLs, dedupes fragments, and preserves distinct signed URLs', () => {
  const candidates = normalizeCandidates([
    { url: 'https://cdn.test/a.mp4?sig=one#time', source: 'performance' },
    { url: 'https://cdn.test/a.mp4?sig=one', source: 'dom-current', width: 1280, height: 720 },
    { url: 'https://cdn.test/a.mp4?sig=two' },
    { url: 'blob:https://site.test/id', kind: 'direct' },
    { url: 'https://cdn.test/poster.jpg' },
  ]);

  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map((candidate) => candidate.url), [
    'https://cdn.test/a.mp4?sig=one',
    'https://cdn.test/a.mp4?sig=two',
  ]);
  assert.equal(candidates[0].width, 1280);
  assert.equal(candidates[0].height, 720);
  assert.equal(candidates[0].source, 'dom-current');
});

test('groups direct variants by group key and sorts known resolutions first', () => {
  const groups = groupDirectVariants([
    { url: 'https://cdn.test/lesson-720.mp4', kind: 'direct', groupKey: 'video-0', width: 1280, height: 720 },
    { url: 'https://cdn.test/lesson-1080.mp4', kind: 'direct', groupKey: 'video-0', width: 1920, height: 1080 },
    { url: 'https://cdn.test/standalone.mp4', kind: 'direct' },
    { url: 'https://cdn.test/master.m3u8', kind: 'hls', groupKey: 'video-0' },
  ]);

  assert.equal(groups.length, 3);
  assert.deepEqual(groups[0].variants.map((variant) => variant.url), [
    'https://cdn.test/lesson-1080.mp4',
    'https://cdn.test/lesson-720.mp4',
  ]);
  assert.equal(groups[1].variants.length, 1);
  assert.equal(groups[2].kind, 'hls');
  assert.equal(groups[2].variants.length, 1);
});

test('infers extensionless media kinds from parameterized MIME types', () => {
  const candidates = normalizeCandidates([
    { url: 'https://cdn.test/playback', type: 'video/webm; codecs=vp9' },
    { url: 'https://cdn.test/stream', type: 'application/x-mpegurl; charset=utf-8' },
  ]);

  assert.deepEqual(candidates.map((candidate) => candidate.kind), ['direct', 'hls']);
});
