import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = {
  lock: 'native-host/tool-lock.json',
  lockScript: 'scripts/lock-native-tools.ps1',
  fetchScript: 'scripts/fetch-native-tools.ps1',
  packageScript: 'scripts/package-native-helper.ps1',
  installScript: 'scripts/install-native-host.ps1',
  launcher: 'Instalar-Video-Radar.cmd',
};

function fullPath(relativePath) {
  return path.join(root, relativePath);
}

function readRequired(relativePath) {
  assert.ok(existsSync(fullPath(relativePath)), `${relativePath} deve existir`);
  return readFileSync(fullPath(relativePath), 'utf8');
}

function indexOfOrFail(source, needle, label) {
  const index = source.indexOf(needle);
  assert.notEqual(index, -1, `${label}: esperado ${JSON.stringify(needle)}`);
  return index;
}

function extensionIdFromKey(key) {
  const publicKey = Buffer.from(key, 'base64');
  const prefix = createHash('sha256').update(publicKey).digest().subarray(0, 16);
  return [...prefix]
    .flatMap((byte) => [byte >> 4, byte & 0x0f])
    .map((nibble) => String.fromCharCode('a'.charCodeAt(0) + nibble))
    .join('');
}

test('todos os artefatos de lock, pacote e instalação existem', () => {
  for (const relativePath of Object.values(files)) {
    assert.ok(existsSync(fullPath(relativePath)), `${relativePath} deve existir`);
  }
});

test('scripts PowerShell preservam texto UTF-8 no Windows PowerShell 5.1', () => {
  for (const relativePath of [
    files.lockScript,
    files.fetchScript,
    files.packageScript,
    files.installScript,
  ]) {
    const bytes = readFileSync(fullPath(relativePath));
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${relativePath} deve ter BOM UTF-8`);
  }
});

test('lock contém somente os três assets oficiais, imutáveis e verificáveis', () => {
  const lock = JSON.parse(readRequired(files.lock));
  assert.equal(lock.schemaVersion, 1);
  assert.match(lock.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
  assert.equal(lock.sources.length, 3);

  const expected = new Map([
    ['yt-dlp', {
      repository: 'yt-dlp/yt-dlp',
      assetName: 'yt-dlp.exe',
      archive: 'file',
      outputs: ['yt-dlp.exe'],
    }],
    ['deno', {
      repository: 'denoland/deno',
      assetName: 'deno-x86_64-pc-windows-msvc.zip',
      archive: 'zip',
      outputs: ['deno.exe'],
    }],
    ['ffmpeg', {
      repository: 'yt-dlp/FFmpeg-Builds',
      assetName: 'ffmpeg-master-latest-win64-gpl.zip',
      archive: 'zip',
      outputs: ['ffmpeg.exe', 'ffprobe.exe'],
    }],
  ]);

  assert.deepEqual(lock.sources.map(({ name }) => name), ['deno', 'ffmpeg', 'yt-dlp']);
  for (const source of lock.sources) {
    const wanted = expected.get(source.name);
    assert.ok(wanted, `fonte inesperada: ${source.name}`);
    assert.equal(source.repository, wanted.repository);
    assert.equal(source.assetName, wanted.assetName);
    assert.equal(source.archive, wanted.archive);
    assert.deepEqual(source.outputs, wanted.outputs);
    assert.match(source.version, /^\S+$/);
    assert.ok(Number.isSafeInteger(source.assetId) && source.assetId > 0);
    assert.equal(
      source.url,
      `https://api.github.com/repos/${source.repository}/releases/assets/${source.assetId}`,
    );
    assert.doesNotMatch(source.url, /latest\/download/i);
    assert.match(source.sha256, /^[0-9a-f]{64}$/);
    assert.ok(Number.isSafeInteger(source.size) && source.size > 0);
    assert.ok(source.license && typeof source.license === 'object');
    assert.match(source.license.fileName, /^[A-Za-z0-9._-]+$/);
    assert.match(source.license.sha256, /^[0-9a-f]{64}$/);
    assert.match(source.license.url, /^https:\/\/raw\.githubusercontent\.com\//);
    assert.match(source.license.url, new RegExp(`^https://raw\\.githubusercontent\\.com/${source.repository.replace('/', '\\/')}/[0-9a-f]{40}/`));
    assert.ok(Array.isArray(source.archiveLicenses));
  }

  assert.deepEqual(lock.sources.find(({ name }) => name === 'ffmpeg').archiveLicenses, [{
    archivePath: 'ffmpeg-master-latest-win64-gpl/LICENSE.txt',
    fileName: 'ffmpeg-GPL-LICENSE.txt',
  }]);
  assert.deepEqual(lock.sources.find(({ name }) => name === 'deno').archiveLicenses, []);
  assert.deepEqual(lock.sources.find(({ name }) => name === 'yt-dlp').archiveLicenses, []);
});

test('gerador do lock consulta apenas releases oficiais e exige digest confiável', () => {
  const script = readRequired(files.lockScript);
  assert.match(script, /\$ErrorActionPreference\s*=\s*'Stop'/);
  assert.match(script, /SecurityProtocol.*Tls12/);
  assert.match(script, /User-Agent/);
  assert.match(script, /application\/vnd\.github\+json/);
  assert.match(script, /GITHUB_TOKEN/);
  for (const repository of ['yt-dlp/yt-dlp', 'denoland/deno', 'yt-dlp/FFmpeg-Builds']) {
    assert.match(script, new RegExp(repository.replace('/', '\\/')));
  }
  for (const asset of ['yt-dlp.exe', 'deno-x86_64-pc-windows-msvc.zip', 'ffmpeg-master-latest-win64-gpl.zip']) {
    assert.match(script, new RegExp(asset.replaceAll('.', '\\.')));
  }
  assert.match(script, /releases\/latest/);
  assert.match(script, /draft|prerelease/);
  assert.match(script, /asset\.id/);
  assert.match(script, /asset\.digest/i);
  assert.match(script, /sha256[^'\r\n]*\[0-9a-fA-F\]\{64\}/);
  assert.match(script, /checksum|SHA2-256SUMS/i);
  assert.match(script, /WriteAllText/);
  assert.match(script, /UTF8Encoding\]\s*::new\(\$false\)/);
  assert.doesNotMatch(script, /latest\/download/i);
});

test('fetch valida lock e hash antes de extrair ou copiar para ready', () => {
  const script = readRequired(files.fetchScript);
  assert.match(script, /param\s*\(/);
  assert.match(script, /native-cache/);
  assert.match(script, /native-ready/);
  assert.match(script, /ConvertFrom-Json/);
  assert.match(script, /schemaVersion/);
  assert.ok(script.includes('api\\.github\\.com'), 'fetch deve restringir o host api.github.com');
  assert.match(script, /releases\/assets\/\(\?<assetId>\\d\+\)/);
  assert.match(script, /yt-dlp\/yt-dlp|denoland\/deno|yt-dlp\/FFmpeg-Builds/);
  assert.match(script, /application\/octet-stream/);
  assert.match(script, /Invoke-WebRequest/);
  assert.match(script, /Get-FileHash[^\r\n]+SHA256/);
  assert.match(script, /CryptographicOperations\]::FixedTimeEquals/);
  assert.match(script, /Expand-Archive/);
  assert.match(script, /Get-Random|Guid/);
  assert.match(script, /yt-dlp\.exe/);
  assert.match(script, /deno\.exe/);
  assert.match(script, /ffmpeg\.exe/);
  assert.match(script, /ffprobe\.exe/);
  assert.match(script, /licenses/);
  assert.match(script, /archiveLicenses/);
  assert.match(script, /ffmpeg-GPL-LICENSE\.txt/);
  assert.match(script, /\.installing-/);

  const firstHash = indexOfOrFail(script, 'Get-FileHash', 'fetch calcula hash');
  const firstExpand = indexOfOrFail(script, 'Expand-Archive', 'fetch extrai zip');
  const firstReadyCopy = indexOfOrFail(script, 'readyStaging', 'fetch monta ready por staging');
  assert.ok(firstHash < firstExpand, 'o primeiro hash deve ocorrer antes da primeira extração');
  assert.ok(firstHash < firstReadyCopy, 'o primeiro hash deve ocorrer antes da montagem do ready');
  assert.doesNotMatch(script, /latest\/download/i);
  assert.doesNotMatch(script, /HttpListener|TcpListener|localhost/i);
});

test('pacote deriva o ID, publica single-file e inclui só payload permitido', () => {
  const script = readRequired(files.packageScript);
  const manifest = JSON.parse(readRequired('manifest.json'));
  const expectedId = extensionIdFromKey(manifest.key);
  assert.match(expectedId, /^[a-p]{32}$/);

  assert.match(script, /scripts[\\/]dotnet\.ps1/);
  assert.match(script, /publish/);
  assert.match(script, /Release/);
  assert.match(script, /win-x64/);
  assert.match(script, /--self-contained/);
  assert.match(script, /PublishSingleFile=true/);
  assert.match(script, /FromBase64String/);
  assert.match(script, /SHA256\]::HashData/);
  assert.match(script, /0\.\.15/);
  assert.match(script, /\[char\]\(\[int\]\[char\]'a'/);
  assert.match(script, /extension-id\.txt/);
  assert.match(script, /video-radar-host\.exe/);
  assert.match(script, /yt-dlp\.exe/);
  assert.match(script, /deno\.exe/);
  assert.match(script, /ffmpeg\.exe/);
  assert.match(script, /ffprobe\.exe/);
  assert.match(script, /package-manifest\.json/);
  assert.match(script, /archiveLicenses/);
  assert.match(script, /ffmpeg-GPL-LICENSE\.txt/);
  assert.match(script, /Get-FileHash[^\r\n]+SHA256/);
  assert.match(script, /\.Length/);
  assert.match(script, /--ping/);
  assert.match(script, /ConvertFrom-Json/);
  assert.match(script, /\.ok/);
  assert.match(script, /\.installing-/);
  assert.match(script, /scripts[\\/]install-native-host\.ps1/);
  assert.match(script, /Instalar-Video-Radar\.cmd/);
  assert.doesNotMatch(script, /Copy-Item[^\r\n]+\*(?!\.exe)/);
  assert.doesNotMatch(script, /\.pdb|\.deps\.json|\.runtimeconfig\.json/i);
});

test('instalador valida todo o pacote e o manifest antes de tocar no registro HKCU', () => {
  const script = readRequired(files.installScript);
  assert.match(script, /\$ErrorActionPreference\s*=\s*'Stop'/);
  assert.match(script, /\$env:LOCALAPPDATA/);
  assert.match(script, /Join-Path\s+\$env:LOCALAPPDATA\s+'VideoRadar'/);
  assert.match(script, /Path\]::IsPathRooted/);
  assert.match(script, /package-manifest\.json/);
  assert.match(script, /licenses\/ffmpeg-GPL-LICENSE\.txt/);
  assert.match(script, /\.\.\\|\.\.\//);
  assert.match(script, /Get-FileHash[^\r\n]+SHA256/);
  assert.match(script, /CryptographicOperations\]::FixedTimeEquals/);
  assert.match(script, /\.size/);
  assert.match(script, /VideoRadar\.installing-/);
  assert.match(script, /VideoRadar\.backup-/);
  assert.match(script, /Move-Item/);
  assert.match(script, /extension-id\.txt/);
  assert.match(script, /\^\[a-p\]\{32\}\$/);

  assert.match(script, /name\s*=\s*'com\.videoradar\.helper'/);
  assert.match(script, /description\s*=\s*'Auxiliar local do Vídeo Radar'/);
  assert.match(script, /path\s*=\s*\(Join-Path\s+\$installRoot\s+'host\\video-radar-host\.exe'\)/);
  assert.match(script, /type\s*=\s*'stdio'/);
  assert.match(script, /allowed_origins\s*=\s*@\("chrome-extension:\/\/\$extensionId\/"\)/);
  assert.match(script, /native-host\\com\.videoradar\.helper\.json/);
  assert.match(script, /UTF8Encoding\]::new\(\$false\)/);
  assert.match(script, /ReadAllText\(\$manifestPath/);
  assert.match(script, /ConvertFrom-Json/);
  assert.match(script, /allowed_origins(?:\)|)\.Count/);

  const registryKeys = [
    'HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.videoradar.helper',
    'HKCU:\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.videoradar.helper',
    'HKCU:\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\com.videoradar.helper',
    'HKCU:\\Software\\Vivaldi\\NativeMessagingHosts\\com.videoradar.helper',
  ];
  for (const key of registryKeys) assert.ok(script.includes(key), `registro ausente: ${key}`);
  assert.equal((script.match(/HKCU:\\Software\\/g) ?? []).length, 4);

  const packageValidation = indexOfOrFail(script, 'Assert-PackagePayload', 'validação do pacote');
  const stagingCopy = indexOfOrFail(script, 'Copy-PackagePayload', 'cópia para staging');
  const manifestReadBack = indexOfOrFail(script, 'ReadAllText($manifestPath', 'reabertura do manifest');
  const ping = indexOfOrFail(script, '--ping', 'diagnóstico do host');
  const firstRegistryWrite = indexOfOrFail(script, 'New-Item -Path $key', 'registro HKCU');
  assert.ok(packageValidation < stagingCopy, 'todos os hashes devem ser validados antes da primeira cópia');
  assert.ok(manifestReadBack < firstRegistryWrite, 'manifest deve ser reaberto e validado antes do registro');
  assert.ok(ping < firstRegistryWrite, 'ping deve passar antes do registro');

  assert.doesNotMatch(script, /HKLM|RunAs|Verb\s+RunAs|requireAdministrator|elevat|administrador/i);
  assert.doesNotMatch(script, /chrome-extension:\/\/\*/i);
  assert.doesNotMatch(script, /HttpListener|TcpListener|https?:\/\/localhost/i);
});

test('launcher usa caminho relativo e pausa somente no branch de erro', () => {
  const launcher = readRequired(files.launcher).replaceAll('\r\n', '\n');
  const expected = [
    '@echo off',
    'setlocal',
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\install-native-host.ps1"',
    'if errorlevel 1 (',
    '  echo.',
    '  echo A instalacao nao foi concluida.',
    '  pause',
    '  exit /b 1',
    ')',
    'exit /b 0',
    '',
  ].join('\n');
  assert.equal(launcher, expected);
});
