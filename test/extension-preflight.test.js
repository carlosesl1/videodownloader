import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const fixture = (path) => new URL(`fixtures/${path}`, import.meta.url);

test('extension package passes the complete static preflight', () => {
  const result = spawnSync(process.execPath, ['scripts/validate-extension.mjs'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /production modules validated/);
});

test('package scripts exclude transport-stream fixtures from Node test discovery', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(packageJson.scripts.test, /test\/\*\.test\.js/);
  assert.match(packageJson.scripts.check, /test\/\*\.test\.js/);
});

test('browser fixtures expose deterministic direct and HLS inputs', async () => {
  assert.match(await readFile(fixture('pages/direct.html'), 'utf8'), /browser-master\.m3u8/);
  assert.match(await readFile(fixture('pages/empty.html'), 'utf8'), /Nenhuma mídia/);
  assert.equal(await readFile(fixture('media/demo-720.mp4'), 'utf8'), 'DIRECT-MP4-FIXTURE\n');
  assert.equal(await readFile(fixture('media/demo-480.webm'), 'utf8'), 'DIRECT-WEBM-FIXTURE\n');
  assert.equal(await readFile(fixture('media/clip.mov'), 'utf8'), 'DIRECT-MOV-FIXTURE\n');
  assert.equal(await readFile(fixture('hls/seg-1.ts'), 'utf8'), 'SEGMENT-ONE\n');
  assert.equal(await readFile(fixture('hls/seg-2.ts'), 'utf8'), 'SEGMENT-TWO\n');

  const master = await readFile(fixture('hls/browser-master.m3u8'), 'utf8');
  assert.match(master, /RESOLUTION=1920x1080/);
  assert.match(master, /RESOLUTION=1280x720/);
  assert.match(master, /RESOLUTION=854x480/);
});

test('fixture server returns correct media headers and rejects path traversal', async (context) => {
  const { createFixtureServer } = await import('../scripts/serve-fixtures.mjs');
  const server = createFixtureServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const playlist = await fetch(`${base}/hls/browser-master.m3u8`);
  assert.equal(playlist.status, 200);
  assert.match(playlist.headers.get('content-type'), /^application\/vnd\.apple\.mpegurl/);
  assert.equal(playlist.headers.get('access-control-allow-origin'), '*');

  const segment = await fetch(`${base}/hls/seg-1.ts`);
  assert.equal(segment.status, 200);
  assert.match(segment.headers.get('content-type'), /^video\/mp2t/);

  const traversal = await fetch(`${base}/%2e%2e%2fpackage.json`);
  assert.equal(traversal.status, 403);
});
