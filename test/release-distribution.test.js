import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const read = (relativePath) => readFileSync(path.join(root, relativePath), 'utf8');

test('V1 release sources exist and versions agree', async () => {
  for (const relativePath of [
    'scripts/validate-release.mjs',
    'scripts/bootstrap-inno-setup.ps1',
    'scripts/build-v1-release.ps1',
    'installer/inno-tool-lock.json',
    'installer/video-radar.iss',
    'installer/onboarding/index.html',
    'installer/onboarding/styles.css',
    'installer/README-INSTALL.txt',
    '.github/workflows/release.yml',
    'docs/RELEASING.md',
  ]) assert.ok(existsSync(path.join(root, relativePath)), `${relativePath} deve existir`);

  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.version, '1.0.0');
  assert.equal(packageJson.version, manifest.version);
});

test('installer is per-user and registers only the four supported HKCU hosts', () => {
  const source = read('installer/video-radar.iss');
  assert.match(source, /DefaultDirName=\{localappdata\}\\VideoRadar/);
  assert.match(source, /PrivilegesRequired=lowest/);
  assert.doesNotMatch(source, /PrivilegesRequiredOverridesAllowed|HKLM|runascurrentuser/i);
  for (const key of [
    'Software\\Google\\Chrome\\NativeMessagingHosts\\com.videoradar.helper',
    'Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.videoradar.helper',
    'Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\com.videoradar.helper',
    'Software\\Vivaldi\\NativeMessagingHosts\\com.videoradar.helper',
  ]) assert.ok(source.includes(key), `registro ausente: ${key}`);
  assert.equal((source.match(/Root: HKCU;/g) ?? []).length, 4);
  assert.match(source, /video-radar-host\.exe/);
  assert.match(source, /--ping/);
  assert.match(source, /chrome-extension:\/\/cakpfifpfmbdcilimpedanglnopnmckg\//);
});

test('release build has deterministic names, allowlist and checksums', () => {
  const source = read('scripts/build-v1-release.ps1');
  for (const fragment of [
    'VideoRadar-Setup-$Version-Windows-x64.exe',
    'VideoRadar-$Version-Developer.zip',
    'SHA256SUMS.txt',
    'manifest.json',
    'popup.html',
    'options.html',
    'offscreen.html',
    'src',
    'styles',
    'assets',
    'Get-FileHash',
    'Compress-Archive',
  ]) assert.ok(source.includes(fragment), `build sem ${fragment}`);
  for (const excluded of ['test', '.git', '.tools', 'dist']) {
    assert.match(source, new RegExp(`['"]${excluded.replace('.', '\\.')}['"]`));
  }
  assert.doesNotMatch(source, /Path\]::GetRelativePath/, 'build deve funcionar no Windows PowerShell 5.1');
});

test('onboarding contains every unavoidable browser step', () => {
  const html = read('installer/onboarding/index.html');
  for (const instruction of [
    'Modo do desenvolvedor',
    'Carregar sem compactação',
    'Extension',
    'Buscar vídeos',
    'Chrome',
    'Edge',
    'Brave',
    'Vivaldi',
    'cakpfifpfmbdcilimpedanglnopnmckg',
  ]) assert.ok(html.includes(instruction), `onboarding sem ${instruction}`);
  assert.doesNotMatch(html, /https?:\/\/[^"' ]+\.(?:js|css)/i);
});

test('Inno Setup compiler is immutable and authenticated', () => {
  const lock = JSON.parse(read('installer/inno-tool-lock.json'));
  assert.deepEqual(lock, {
    schemaVersion: 1,
    version: '7.0.2',
    fileName: 'innosetup-7.0.2-x64.exe',
    url: 'https://github.com/jrsoftware/issrc/releases/download/is-7_0_2/innosetup-7.0.2-x64.exe',
    size: 17020192,
    sha256: '5ad54ca3def786f8f4212552e54cc6d8d61329e2d24a1cfee0571d42c2684ff1',
    publisher: 'CN=Pyrsys B.V., O=Pyrsys B.V., S=Noord-Holland, C=NL',
  });
  const bootstrap = read('scripts/bootstrap-inno-setup.ps1');
  assert.match(bootstrap, /Start-Process/);
  assert.match(bootstrap, /-Wait/);
  assert.match(bootstrap, /-WindowStyle\s+Hidden/);
});

test('stable extension key keeps the native origin unchanged', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  const digest = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16);
  const extensionId = [...digest]
    .flatMap((byte) => [byte >> 4, byte & 15])
    .map((nibble) => String.fromCharCode(97 + nibble))
    .join('');
  assert.equal(extensionId, 'cakpfifpfmbdcilimpedanglnopnmckg');
});

test('release workflow tests every build and publishes stable tags only', () => {
  const workflow = read('.github/workflows/release.yml');
  for (const fragment of [
    'workflow_dispatch:',
    "tags: ['v*']",
    'contents: write',
    'npm run check:all',
    'npm run build:release',
    'actions/upload-artifact@v4',
    "startsWith(github.ref, 'refs/tags/v')",
    'gh release create',
    '--verify-tag',
  ]) assert.ok(workflow.includes(fragment), `workflow sem ${fragment}`);
});

test('release guide distinguishes unsigned builds from optional signing', () => {
  const guide = read('docs/RELEASING.md');
  for (const fragment of [
    'npm run check:all',
    'npm run check:release',
    'scripts/build-v1-release.ps1',
    'SHA256SUMS.txt',
    'SmartScreen',
    'SignPath Foundation',
    'Get-AuthenticodeSignature',
    'não está assinado',
  ]) assert.ok(guide.includes(fragment), `guia sem ${fragment}`);
});
