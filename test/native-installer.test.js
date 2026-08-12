import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = {
  globalJson: 'global.json',
  bootstrapDotnet: 'scripts/bootstrap-dotnet.ps1',
  dotnetWrapper: 'scripts/dotnet.ps1',
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

test('SDK .NET usa versão exata e valida SHA-512 oficial antes de extrair', () => {
  const sdk = JSON.parse(readRequired(files.globalJson));
  assert.deepEqual(sdk, {
    sdk: {
      version: '10.0.400',
      rollForward: 'disable',
      allowPrerelease: false,
    },
  });

  const script = readRequired(files.bootstrapDotnet);
  const sdkArtifacts = [
    ['https://builds.dotnet.microsoft.com/dotnet/Sdk/10.0.400/dotnet-sdk-10.0.400-win-x64.zip', '9b8b88590e4da131bfd0da7aa089d0fc04d5418d5f8607ec13d55dc5a17b4399afd54d496c12657fa05c6c6546dc5eab930f26ac6c50f2d3a7712c0fb378c366'],
    ['https://builds.dotnet.microsoft.com/dotnet/Sdk/10.0.400/dotnet-sdk-10.0.400-win-arm64.zip', '9d4ecd7439f15c7797d6f46d368cb7aa6513755c5fc3d6de7621bc4878a1805f6b8ffb60ffb9d3e72a049cca87edb252f7c8c03023b643e333544c4606509d7f'],
  ];
  assert.ok(script.includes("$sdkVersion = '10.0.400'"));
  for (const [url, sha512] of sdkArtifacts) {
    assert.ok(script.includes(`url = '${url}'`));
    assert.ok(script.includes(`sha512 = '${sha512}'`));
  }
  assert.match(script, /PROCESSOR_ARCHITEW6432/);
  assert.match(script, /Get-FileHash[^\r\n]+-Algorithm SHA512/);
  assert.match(script, /Expand-Archive/);
  assert.match(script, /dotnet-\$sdkVersion-\$nativeArchitecture-staging-/);
  assert.match(script, /dotnet-\$nativeArchitecture-backup-/);
  assert.match(script, /Get-InstalledVersion/);
  assert.match(script, /Split-Path -Parent \$installDir/);
  assert.doesNotMatch(script, /dot\.net\/v1\/dotnet-install|dotnet-install\.ps1/i);

  const hash = indexOfOrFail(script, 'Get-FileHash', 'bootstrap calcula SHA-512');
  const extract = indexOfOrFail(script, 'Expand-Archive', 'bootstrap extrai o SDK');
  assert.ok(hash < extract, 'o SDK deve ser autenticado antes da extração');

  for (const workflowPath of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
    const workflow = readRequired(workflowPath);
    assert.match(workflow, /global-json-file:\s*global\.json/);
    assert.doesNotMatch(workflow, /dotnet-version:\s*["']?10\.0\.x/i);
  }

  const wrapper = readRequired(files.dotnetWrapper);
  assert.match(wrapper, /Get-Content[^\r\n]+globalJsonPath[^\r\n]+ConvertFrom-Json/);
  assert.match(wrapper, /Get-SdkVersion/);
  assert.match(wrapper, /Get-Command\s+dotnet[^\r\n]+SilentlyContinue/);
  assert.match(wrapper, /& \$bootstrapPath/);
  assert.match(wrapper, /& \$dotnet @args/);
  assert.ok(
    indexOfOrFail(wrapper, '& $bootstrapPath', 'wrapper executa bootstrap')
      < indexOfOrFail(wrapper, '& $dotnet @args', 'wrapper executa comando'),
    'o bootstrap deve preceder o comando .NET solicitado',
  );
});

test('lock contém três assets nativos por arquitetura, imutáveis e verificáveis', () => {
  const lock = JSON.parse(readRequired(files.lock));
  assert.equal(lock.schemaVersion, 2);
  assert.match(lock.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
  assert.deepEqual(lock.targets.map(({ rid, architecture }) => [rid, architecture]), [
    ['win-x64', 'x64'],
    ['win-arm64', 'arm64'],
  ]);
  const expectedAssets = {
    'win-x64': ['deno-x86_64-pc-windows-msvc.zip', 'ffmpeg-N-125875-g5d4d3bdc61-win64-gpl.zip', 'yt-dlp.exe'],
    'win-arm64': ['deno-aarch64-pc-windows-msvc.zip', 'ffmpeg-N-125875-g5d4d3bdc61-winarm64-gpl.zip', 'yt-dlp_arm64.exe'],
  };
  const repositories = new Map([
    ['deno', 'denoland/deno'], ['ffmpeg', 'yt-dlp/FFmpeg-Builds'], ['yt-dlp', 'yt-dlp/yt-dlp'],
  ]);
  for (const target of lock.targets) {
    assert.deepEqual(target.sources.map(({ name }) => name), ['deno', 'ffmpeg', 'yt-dlp']);
    assert.deepEqual(target.sources.map(({ assetName }) => assetName), expectedAssets[target.rid]);
    for (const source of target.sources) {
    assert.equal(source.repository, repositories.get(source.name));
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
  }
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
  for (const asset of [
    'yt-dlp.exe', 'yt-dlp_arm64.exe',
    'deno-x86_64-pc-windows-msvc.zip', 'deno-aarch64-pc-windows-msvc.zip',
    'ffmpeg-N-125875-g5d4d3bdc61-win64-gpl.zip',
    'ffmpeg-N-125875-g5d4d3bdc61-winarm64-gpl.zip',
  ]) {
    assert.match(script, new RegExp(asset.replaceAll('.', '\\.')));
  }
  assert.match(script, /releases\/latest/);
  assert.match(script, /releases\/tags/);
  assert.match(script, /autobuild-2026-07-31-16-16/);
  assert.doesNotMatch(script, /assetName\s*=\s*'ffmpeg-master-latest/i);
  assert.match(script, /draft|prerelease/);
  assert.match(script, /asset\.id/);
  assert.match(script, /asset\.digest/i);
  assert.match(script, /sha256[^'\r\n]*\[0-9a-fA-F\]\{64\}/);
  assert.match(script, /checksum|SHA2-256SUMS/i);
  assert.match(script, /WriteAllText/);
  assert.match(script, /schemaVersion\s*=\s*2/);
  assert.match(script, /UTF8Encoding\]\s*::new\(\$false\)/);
  assert.doesNotMatch(script, /latest\/download/i);
});

test('fetch de assets públicos não encaminha credencial do repositório a upstreams', () => {
  const script = readRequired(files.fetchScript);
  assert.match(script, /application\/octet-stream/);
  assert.match(script, /X-GitHub-Api-Version/);
  assert.doesNotMatch(script, /\['Authorization'\]|Bearer\s*['"+]/i);
  assert.match(script, /Invoke-WebRequest[^\r\n]+-Headers\s+\$downloadHeaders/);
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
  assert.match(script, /win-arm64/);
  assert.match(script, /--self-contained/);
  assert.match(script, /PublishSingleFile=true/);
  assert.match(script, /Assert-PeArchitecture/);
  assert.match(script, /0xaa64/);
  assert.match(script, /AllowCrossArchitecturePackage/);
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
  assert.match(script, /schemaVersion[^\r\n]+2/);
  assert.match(script, /targetRid/);
  assert.match(script, /Get-NativeWindowsArchitecture/);
  assert.match(script, /Assert-PeArchitecture/);
  assert.match(script, /0xaa64/);
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
  assert.match(script, /schemaVersion[^\r\n]+2/);
  assert.match(script, /targetRid/);
  assert.match(script, /Get-NativeWindowsArchitecture/);
  assert.match(script, /Assert-PeArchitecture/);
  assert.match(script, /licenses\/ffmpeg-GPL-LICENSE\.txt/);
  assert.match(script, /\.\.\\|\.\.\//);
  assert.match(script, /Get-FileHash[^\r\n]+SHA256/);
  assert.match(script, /CryptographicOperations\]::FixedTimeEquals/);
  assert.match(script, /\.size/);
  assert.match(script, /VideoRadar\.runtime-installing-/);
  assert.match(script, /VideoRadar\.runtime-backup-/);
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
  assert.match(script, /\$pingTimeoutMilliseconds\s*=\s*30000/);
  assert.match(script, /WaitForExit\(\$pingTimeoutMilliseconds\)/);
  assert.match(script, /\$process\.Kill\(\)/);
  assert.match(script, /WaitForExit\(5000\)/);
  assert.doesNotMatch(script, /WaitForExitAsync|\.Kill\(\$true\)/);

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
  const pingTimeout = indexOfOrFail(script, 'WaitForExit($pingTimeoutMilliseconds)', 'timeout do diagnóstico');
  const pingKill = indexOfOrFail(script, '$process.Kill()', 'encerramento do diagnóstico travado');
  const firstRegistryWrite = indexOfOrFail(script, 'New-Item -Path $key', 'registro HKCU');
  assert.ok(packageValidation < stagingCopy, 'todos os hashes devem ser validados antes da primeira cópia');
  assert.ok(manifestReadBack < firstRegistryWrite, 'manifest deve ser reaberto e validado antes do registro');
  assert.ok(ping < firstRegistryWrite, 'ping deve passar antes do registro');
  assert.ok(pingTimeout < pingKill, 'o timeout deve ser detectado antes de encerrar o processo travado');
  assert.ok(pingKill < firstRegistryWrite, 'um ping travado deve ser encerrado antes do registro');

  assert.doesNotMatch(script, /HKLM|RunAs|Verb\s+RunAs|requireAdministrator|elevat|administrador/i);
  assert.doesNotMatch(script, /chrome-extension:\/\/\*/i);
  assert.doesNotMatch(script, /HttpListener|TcpListener|https?:\/\/localhost/i);
});

test('upgrade troca apenas runtime e preserva fila pausada, .part e estado do produto', () => {
  const script = readRequired(files.installScript);
  const inno = readRequired('installer/video-radar.iss');
  const setupMutexName = 'Local\\VideoRadarInstall-7A5C59C3-0DCE-4D0C-9BE1-5621E2AA4EA4';
  const assignment = script.match(/\$runtimeComponents\s*=\s*@\(([^)]+)\)/);
  assert.ok(assignment, 'a lista fechada de componentes imutáveis deve existir');
  const runtimeComponents = [...assignment[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(runtimeComponents, ['host', 'licenses', 'extension-id.txt', 'native-host']);

  assert.match(script, /Enter-InstallationLock/);
  assert.match(script, /\[IO\.FileShare\]::None/);
  assert.match(script, /function Enter-SetupMutex/);
  assert.match(script, /\[Threading\.Mutex\]::new\(\$false, \$Name, \[ref\]\$createdNew\)/);
  assert.ok(script.includes(`$setupMutexName = '${setupMutexName}'`));
  assert.ok(inno.includes(`SetupMutex=${setupMutexName}`));
  assert.match(script, /finally\s*\{[\s\S]*\$setupMutex\.Dispose\(\)/);
  assert.match(script, /\$pendingSetupBackup\s*=\s*"\$installRoot\.runtime-backup"/);
  assert.match(script, /finally\s*\{[\s\S]*\$installLock\.Dispose\(\)/);
  assert.doesNotMatch(
    script,
    /Move-Item\s+-LiteralPath\s+\$installRoot(?:\s|$)/m,
    'a raiz compartilhada com o estado nunca pode ser renomeada',
  );
  assert.doesNotMatch(
    script,
    /Remove-Item[^\r\n]*\$installRoot/i,
    'a raiz compartilhada com o estado nunca pode ser removida',
  );

  const setupMutex = indexOfOrFail(script, '$setupMutex = Enter-SetupMutex', 'aquisição do mutex compartilhado');
  const lock = indexOfOrFail(script, '$installLock = Enter-InstallationLock', 'aquisição do lock');
  const staging = indexOfOrFail(script, 'Copy-PackagePayload -Payload $payload', 'montagem do staging');
  const moveOld = indexOfOrFail(script, '-Moved $movedOldRuntime', 'backup do runtime anterior');
  const moveNew = indexOfOrFail(script, '-Moved $movedNewRuntime', 'ativação do runtime novo');
  const rollbackNew = indexOfOrFail(script, 'foreach ($relativePath in $movedNewRuntime)', 'isolamento do runtime que falhou');
  const rollbackOld = indexOfOrFail(script, 'foreach ($relativePath in $movedOldRuntime)', 'restauração do runtime anterior');
  assert.ok(setupMutex < lock, 'o mutex compartilhado deve anteceder o lock de arquivo');
  assert.ok(lock < staging, 'o staging e a troca devem ocorrer sob lock exclusivo');
  assert.ok(moveOld < moveNew, 'o runtime anterior deve ser preservado antes da ativação');
  assert.ok(rollbackNew < rollbackOld, 'o runtime novo deve sair antes da restauração do anterior');

  const installedPing = script.lastIndexOf('Invoke-InstalledPing -HostPath $expectedHostPath');
  const registryWrite = script.lastIndexOf('Set-Item -Path $key -Value $manifestPath');
  const commit = indexOfOrFail(script, '$transactionCommitted = $true', 'commit do runtime validado');
  const cleanup = indexOfOrFail(
    script,
    'Remove-TransactionBackup -Path $installBackup -ExpectedParent $localAppData',
    'remoção do backup confirmado',
  );
  assert.ok(installedPing >= 0 && installedPing < registryWrite);
  assert.ok(registryWrite < commit && commit < cleanup);
  assert.match(script, /function Remove-TransactionBackup/);
  assert.match(script, /\^VideoRadar\\\.runtime-backup-\[0-9a-f\]\{32\}\$/);
  assert.match(script, /function Remove-DirectoryWithoutFollowingReparsePoints/);
  assert.match(script, /\[IO\.FileAttributes\]::ReparsePoint/);
  assert.match(script, /\[IO\.Directory\]::Delete\(\$entryPath, \$false\)/);
  assert.match(script, /\$movedOldRuntime\.Clear\(\)/);
  assert.doesNotMatch(script, /Runtime anterior preservado em:/);

  const pausedJob = JSON.stringify({
    schemaVersion: 1,
    jobId: 'job-paused',
    state: 'paused',
    resumePartial: true,
  });
  const existing = new Map([
    ['host/video-radar-host.exe', 'runtime-antigo'],
    ['licenses/yt-dlp-LICENSE.txt', 'licença-antiga'],
    ['extension-id.txt', 'id-antigo'],
    ['native-host/com.videoradar.helper.json', 'manifest-antigo'],
    ['download-queue/job-paused.json', pausedJob],
    ['temp/job-paused/video.f137.mp4.part', 'bytes-parciais'],
    ['start-journal/start-001.json', 'journal-start'],
    ['move-journal/move-001.json', 'journal-move'],
    ['diagnostics/events-20260812.jsonl', 'diagnóstico'],
    ['Extension/manifest.json', 'extensão-instalada'],
    ['legal/LICENSE', 'texto-legal'],
    ['onboarding/index.html', 'guia'],
    ['unins000.exe', 'desinstalador'],
    ['unins000.dat', 'estado-desinstalador'],
  ]);
  const replacement = new Map([
    ['host/video-radar-host.exe', 'runtime-novo'],
    ['licenses/yt-dlp-LICENSE.txt', 'licença-nova'],
    ['extension-id.txt', 'id-novo'],
    ['native-host/com.videoradar.helper.json', 'manifest-novo'],
  ]);
  const active = new Map(existing);
  const backup = new Map();
  for (const component of runtimeComponents) {
    for (const [entryPath, value] of [...active]) {
      if (entryPath === component || entryPath.startsWith(`${component}/`)) {
        backup.set(entryPath, value);
        active.delete(entryPath);
      }
    }
    for (const [entryPath, value] of replacement) {
      if (entryPath === component || entryPath.startsWith(`${component}/`)) {
        active.set(entryPath, value);
      }
    }
  }

  for (const statePath of [
    'download-queue/job-paused.json',
    'temp/job-paused/video.f137.mp4.part',
    'start-journal/start-001.json',
    'move-journal/move-001.json',
    'diagnostics/events-20260812.jsonl',
    'Extension/manifest.json',
    'legal/LICENSE',
    'onboarding/index.html',
    'unins000.exe',
    'unins000.dat',
  ]) {
    assert.equal(active.get(statePath), existing.get(statePath), `${statePath} deve sobreviver ao upgrade`);
  }
  assert.equal(JSON.parse(active.get('download-queue/job-paused.json')).state, 'paused');
  assert.equal(active.get('temp/job-paused/video.f137.mp4.part'), 'bytes-parciais');

  // Modela a ordem de rollback codificada no script: remove o novo e restaura o backup.
  for (const component of runtimeComponents) {
    for (const entryPath of [...active.keys()]) {
      if (entryPath === component || entryPath.startsWith(`${component}/`)) active.delete(entryPath);
    }
  }
  for (const [entryPath, value] of backup) active.set(entryPath, value);
  assert.deepEqual([...active].sort(), [...existing].sort());
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
