import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

test('production preflight contract has the exact Chrome and helper boundaries', async () => {
  const root = new URL('../', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  const expectedPermissions = [
    'activeTab', 'downloads', 'nativeMessaging', 'notifications', 'offscreen', 'scripting', 'storage',
  ];
  assert.deepEqual([...manifest.permissions].sort(), expectedPermissions);
  assert.ok(!manifest.host_permissions?.length);
  assert.deepEqual(manifest.optional_host_permissions, ['http://*/*', 'https://*/*']);
  await access(new URL(`../${manifest.icons['128']}`, import.meta.url));

  const key = Buffer.from(manifest.key, 'base64');
  assert.ok(key.length > 0);
  const id = [...createHash('sha256').update(key).digest().subarray(0, 16)]
    .flatMap((byte) => [(byte >> 4) & 0xf, byte & 0xf])
    .map((nibble) => String.fromCharCode('a'.charCodeAt(0) + nibble))
    .join('');
  assert.equal(id, 'cakpfifpfmbdcilimpedanglnopnmckg');

  const sourceRoot = resolve(fileURLToPath(root), 'src');
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    return (await Promise.all(entries.map((entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? walk(path) : path;
    }))).flat();
  }
  const sources = (await walk(sourceRoot)).filter((file) => extname(file) === '.js');
  const localImport = /(?:from\s*|import\s*)["'](\.{1,2}\/[^"]+?)["']/g;
  for (const file of sources) {
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(localImport)) await access(resolve(dirname(file), match[1]));
  }

  const forbidden = [
    'http://localhost', 'https://localhost', 'HttpListener', 'TcpListener',
    '--cookies', '--cookies-from-browser', '--username', '--password', '--netrc',
    '--user-data-dir', '--profile-directory', '--profile',
  ];
  const hostRoot = resolve(fileURLToPath(root), 'native-host/VideoRadar.NativeHost');
  const production = [
    ...sources,
    ...(await walk(hostRoot)).filter((file) => extname(file) === '.cs'),
  ];
  for (const file of production) {
    const text = await readFile(file, 'utf8');
    for (const pattern of forbidden) assert.equal(text.includes(pattern), false, `${file} contains ${pattern}`);
  }
});

test('helper lock, project, scripts, and README retain the offline installation contract', async () => {
  const root = new URL('../', import.meta.url);
  const lock = JSON.parse(await readFile(new URL('../native-host/tool-lock.json', import.meta.url), 'utf8'));
  assert.equal(lock.schemaVersion, 1);
  assert.deepEqual(lock.sources.map((source) => source.name), ['deno', 'ffmpeg', 'yt-dlp']);
  for (const source of lock.sources) {
    assert.match(source.url, /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/releases\/assets\/\d+$/);
    assert.match(source.sha256, /^[0-9a-f]{64}$/);
    assert.ok(source.outputs.length > 0);
    assert.match(source.license.url, /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[0-9a-f]{40}\//);
  }

  const csproj = await readFile(new URL('../native-host/VideoRadar.NativeHost/VideoRadar.NativeHost.csproj', import.meta.url), 'utf8');
  for (const property of ['<TargetFramework>net10.0</TargetFramework>', '<SelfContained>true</SelfContained>', '<PublishSingleFile>true</PublishSingleFile>']) {
    assert.match(csproj, new RegExp(property.replace(/[<>/]/g, '\\$&')));
  }
  for (const path of ['Instalar-Video-Radar.cmd', 'scripts/install-native-host.ps1', 'scripts/package-native-helper.ps1']) {
    await access(new URL(`../${path}`, import.meta.url));
  }

  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(packageJson['scripts']['test:native'], /scripts\/dotnet\.ps1 run --project native-host\/VideoRadar\.NativeHost\.Tests/);
  assert.match(packageJson.scripts['check:all'], /npm run check\s*&&\s*npm run test:native/);
  for (const name of ['test', 'check', 'check:all']) {
    assert.doesNotMatch(packageJson.scripts[name], /(?:fetch|package-native|lock-native|youtube|https?:\/\/)/i);
  }

  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  for (const text of [
    'Carregar sem compactação', 'YouTube', 'Configurar downloads',
    'Perguntar onde salvar cada download', 'Downloads\\Video Radar\\.staging',
    'Cancelar', 'Chrome', 'Edge', 'Brave', 'Vivaldi', '%LOCALAPPDATA%\\VideoRadar',
  ]) assert.match(readme, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
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
