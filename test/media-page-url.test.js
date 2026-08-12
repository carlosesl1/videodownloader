import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalMediaPage } from '../src/media/page-url.js';

const YOUTUBE_ID = 'jNQXAC9IVRw';
const TIKTOK_ID = '7488298911734435077';
const INSTAGRAM_ID = 'C8x_example';
const X_ID = '1907123456789012345';

test('canonicaliza páginas públicas de vídeo nas quatro plataformas', () => {
  const cases = [
    [
      `https://m.youtube.com/shorts/${YOUTUBE_ID}?feature=share`,
      { platform: 'youtube', canonicalUrl: `https://www.youtube.com/watch?v=${YOUTUBE_ID}`, mediaId: YOUTUBE_ID },
    ],
    [
      `https://www.tiktok.com/@video.radar/video/${TIKTOK_ID}?is_from_webapp=1`,
      {
        platform: 'tiktok',
        canonicalUrl: `https://www.tiktok.com/@video.radar/video/${TIKTOK_ID}`,
        mediaId: TIKTOK_ID,
      },
    ],
    [
      `https://www.instagram.com/reels/${INSTAGRAM_ID}/?igsh=abc`,
      {
        platform: 'instagram',
        canonicalUrl: `https://www.instagram.com/reel/${INSTAGRAM_ID}/`,
        mediaId: INSTAGRAM_ID,
      },
    ],
    [
      `https://twitter.com/VideoRadar/status/${X_ID}/video/1?s=20`,
      {
        platform: 'x',
        canonicalUrl: `https://x.com/VideoRadar/status/${X_ID}`,
        mediaId: X_ID,
      },
    ],
  ];

  for (const [input, expected] of cases) {
    assert.deepEqual(canonicalMediaPage(input), expected, input);
    assert.equal(Object.isFrozen(canonicalMediaPage(input)), true);
  }
});
test('aceita variantes canônicas e links curtos do TikTok', () => {
  for (const [input, expected] of [
    [
      `https://tiktok.com/@video_radar/video/${TIKTOK_ID}`,
      {
        platform: 'tiktok',
        canonicalUrl: `https://www.tiktok.com/@video_radar/video/${TIKTOK_ID}`,
        mediaId: TIKTOK_ID,
      },
    ],
    [
      'https://vm.tiktok.com/ZM123abcD/',
      {
        platform: 'tiktok',
        canonicalUrl: 'https://vm.tiktok.com/ZM123abcD/',
        mediaId: 'short:ZM123abcD',
      },
    ],
    [
      'https://vt.tiktok.com/ZSabc_123/',
      {
        platform: 'tiktok',
        canonicalUrl: 'https://vt.tiktok.com/ZSabc_123/',
        mediaId: 'short:ZSabc_123',
      },
    ],
  ]) assert.deepEqual(canonicalMediaPage(input), expected);
});

test('aceita post, Reel e IGTV do Instagram', () => {
  for (const segment of ['p', 'reel', 'reels', 'tv']) {
    const page = canonicalMediaPage(`https://instagram.com/${segment}/${INSTAGRAM_ID}/`);
    assert.deepEqual(page, {
      platform: 'instagram',
      canonicalUrl: `https://www.instagram.com/${segment === 'reels' ? 'reel' : segment}/${INSTAGRAM_ID}/`,
      mediaId: INSTAGRAM_ID,
    });
  }
});

test('aceita x.com, twitter.com e páginas móveis de status', () => {
  for (const host of ['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com']) {
    assert.deepEqual(canonicalMediaPage(`https://${host}/Video_Radar/status/${X_ID}`), {
      platform: 'x',
      canonicalUrl: `https://x.com/Video_Radar/status/${X_ID}`,
      mediaId: X_ID,
    });
  }
});

test('rejeita autoridades, caminhos e conteúdos fora do escopo', () => {
  for (const input of [
    `http://x.com/user/status/${X_ID}`,
    `https://user@x.com/user/status/${X_ID}`,
    `https://x.com:444/user/status/${X_ID}`,
    `https://x.com.evil.test/user/status/${X_ID}`,
    `https://tiktok.com.evil.test/@user/video/${TIKTOK_ID}`,
    `https://instagram.com.evil.test/reel/${INSTAGRAM_ID}/`,
    `https://x.com/extra/../user/status/${X_ID}`,
    `https://instagram.com/%2e/reel/${INSTAGRAM_ID}/`,
    `https://www.tiktok.com/@user/video/${TIKTOK_ID}/extra`,
    'https://www.tiktok.com/@video.radar',
    'https://www.tiktok.com/live',
    'https://www.instagram.com/video.radar/',
    'https://www.instagram.com/stories/video.radar/123/',
    'https://x.com/VideoRadar',
    'https://x.com/i/spaces/abc',
    'https://example.com/video/123',
    '',
    null,
  ]) assert.equal(canonicalMediaPage(input), null, String(input));
});
