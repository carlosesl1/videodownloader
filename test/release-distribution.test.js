import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const read = (relativePath) => readFileSync(path.join(root, relativePath), 'utf8');

test('release sources exist and versions agree', async () => {
  for (const relativePath of [
    'scripts/validate-release.mjs',
    'scripts/generate-sbom.mjs',
    'scripts/verify-release-artifacts.mjs',
    'scripts/bootstrap-inno-setup.ps1',
    'scripts/build-release.ps1',
    'scripts/smoke-release-windows.ps1',
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
  assert.equal(manifest.version, '1.2.0');
  assert.equal(packageJson.version, manifest.version);
  assert.match(packageJson.scripts['build:release'], /scripts\/build-release\.ps1/);
  assert.match(packageJson.scripts['release:sbom'], /scripts\/generate-sbom\.mjs/);
  assert.match(packageJson.scripts['verify:release'], /scripts\/verify-release-artifacts\.mjs/);
});

test('installer is per-user and registers only the four supported HKCU hosts', () => {
  const source = read('installer/video-radar.iss');
  assert.match(source, /DefaultDirName=\{localappdata\}\\VideoRadar/);
  assert.match(source, /PrivilegesRequired=lowest/);
  assert.match(source, /ArchitecturesAllowed=x64compatible and not arm64/);
  assert.match(source, /ArchitecturesAllowed=arm64/);
  assert.match(source, /TargetArchitecture/);
  assert.match(source, /SetupArchitecture=x64/);
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

test('Inno upgrade prevalidates, fails closed and restores only installer-owned components', () => {
  const source = read('installer/video-radar.iss');
  assert.match(source, /^CloseApplications=yes$/m);
  assert.match(source, /^RestartApplications=no$/m);
  assert.match(
    source,
    /^SetupMutex=Local\\VideoRadarInstall-7A5C59C3-0DCE-4D0C-9BE1-5621E2AA4EA4$/m,
  );
  assert.match(source, /Extension\\\*[^\r\n]+BeforeInstall: MarkPayloadInstallStarted/);
  assert.match(
    source,
    /Source: "\{tmp\}\\VideoRadar-install\\\{#NativeHostName\}\.json";[^\r\n]+Flags: external ignoreversion/,
  );
  assert.doesNotMatch(source, /AfterInstall:/);
  assert.doesNotMatch(source, /^\[Dirs\]$/m, 'manifesto criado em Code não deve escapar do rollback');

  const backupStart = source.indexOf('procedure PrepareBackup;');
  const backupEnd = source.indexOf('procedure CleanupBackupCopy', backupStart);
  assert.ok(backupStart >= 0 && backupEnd > backupStart);
  const backup = source.slice(backupStart, backupEnd);
  assert.match(backup, /ExpandConstant\('\{app\}\.runtime-backup'\)/);
  const copiedComponents = [...backup.matchAll(/CopyOwnedComponent\('([^']+)'\)/g)]
    .map((match) => match[1]);
  assert.deepEqual(copiedComponents, [
    'Extension',
    'host',
    'licenses',
    'legal',
    'onboarding',
    'native-host',
    'build-info.json',
  ]);
  for (const statePath of [
    'download-queue',
    'temp',
    'start-journal',
    'move-journal',
    'diagnostics',
  ]) assert.doesNotMatch(backup, new RegExp(`CopyOwnedComponent\\('${statePath}'\\)`));
  assert.match(source, /FILE_ATTRIBUTE_REPARSE_POINT/);
  assert.match(source, /CopyFile\(SourcePath, DestinationPath, True\)/);

  const prepareStart = source.indexOf('function PrepareToInstall');
  const prepareEnd = source.indexOf('procedure MarkPayloadInstallStarted', prepareStart);
  const prepare = source.slice(prepareStart, prepareEnd);
  assert.ok(source.includes("ExtractTemporaryFiles('{app}\\host\\video-radar-host.exe')"));
  assert.ok(source.includes("ExtractTemporaryFiles('{app}\\host\\tools\\*.exe')"));
  assert.match(prepare, /ExtractAndVerifyNativeHost;[\s\S]*WriteNativeManifest\(ManifestPath\);[\s\S]*PrepareBackup;/);
  assert.match(prepare, /Result := 'A instalação foi interrompida antes de alterar a versão atual\./);
  assert.match(prepare, /CleanupBackupCopy;/);

  const postInstallStart = source.indexOf('procedure CurStepChanged');
  const postInstallEnd = source.indexOf('procedure DeinitializeSetup', postInstallStart);
  const postInstall = source.slice(postInstallStart, postInstallEnd);
  assert.match(postInstall, /InstallSucceeded := True/);
  assert.doesNotMatch(postInstall, /WriteNativeManifest|VerifyNativeHost/);
  assert.match(source, /procedure DeinitializeSetup;[\s\S]*PayloadInstallStarted[\s\S]*not InstallSucceeded[\s\S]*RestoreBackup/);
  assert.match(source, /RestoreOwnedComponent\('Extension', RestoreFailed\)/);
  assert.match(source, /RenameFile\(SavedPath, ActivePath\)/);
});

test('release build has deterministic names, allowlist, SBOM and checksums', () => {
  const source = read('scripts/build-release.ps1');
  for (const fragment of [
    'VideoRadar-Setup-$Version-Windows-x64.exe',
    'VideoRadar-Setup-$Version-Windows-arm64.exe',
    'VideoRadar-$Version-Developer-Windows-x64.zip',
    'VideoRadar-$Version-Developer-Windows-arm64.zip',
    'SHA256SUMS.txt',
    'SBOM.spdx.json',
    'manifest.json',
    'popup.html',
    'options.html',
    'offscreen.html',
    'src',
    'styles',
    'assets',
    'Get-FileHash',
    'Compress-Archive',
    'generate-sbom.mjs',
    'verify-release-artifacts.mjs',
    "-RuntimeIdentifier 'win-arm64'",
    '-AllowCrossArchitecturePackage',
  ]) assert.ok(source.includes(fragment), `build sem ${fragment}`);
  for (const excluded of ['test', '.git', '.tools', 'dist']) {
    assert.match(source, new RegExp(`['"]${excluded.replace('.', '\\.')}['"]`));
  }
  assert.match(source, /Assert-DistributionTarget/);
  assert.match(source, /child of the project dist directory/);
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
  assert.match(bootstrap, /Assert-ReadyCompiler/);
  assert.match(bootstrap, /Get-AuthenticodeSignature/);
  assert.match(bootstrap, /ValidateCompilerPath/);
  assert.match(bootstrap, /\.installing-/);
  assert.match(bootstrap, /\.backup-/);
  const releaseBuild = read('scripts/build-release.ps1');
  assert.match(releaseBuild, /-ValidateCompilerPath\s+\$isccPath/);
  assert.ok(
    releaseBuild.indexOf('-ValidateCompilerPath $isccPath')
      < releaseBuild.indexOf("& $isccPath '/Qp'"),
    'o compilador deve ser autenticado antes de executar ISCC.exe',
  );
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
    'permissions: {}',
    'contents: write',
    'npm run check:all',
    'npm run check:release',
    'npm run build:release',
    'npm run verify:release',
    'RELEASE_REF_NAME: ${{ github.ref_name }}',
    'RELEASE_TAG: ${{ github.ref_name }}',
    'GH_TOKEN: ${{ github.token }}',
    'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
    'actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131',
    'release_artifact_id: ${{ steps.upload_release.outputs.artifact-id }}',
    'artifact-ids: ${{ needs.build.outputs.release_artifact_id }}',
    'actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6',
    'dist/release/SBOM.spdx.json',
    'sbom-path: dist/release/SBOM.spdx.json',
    "if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')",
    'gh release create',
    'gh release upload',
    '--clobber',
    'gh release edit',
    '--draft=false',
    '--json isDraft',
    'expected_assets_json',
    'verify_release_assets',
    'digest',
    '--verify-tag',
  ]) assert.ok(workflow.includes(fragment), `workflow sem ${fragment}`);
  assert.match(workflow, /build:[\s\S]*?permissions:\s*\n\s+contents: read/);
  assert.match(
    workflow,
    /attest:[\s\S]*?attestations: write[\s\S]*?artifact-metadata: write[\s\S]*?id-token: write/,
  );
  assert.doesNotMatch(workflow, /subject-checksums:/);
  assert.match(workflow, /publish:[\s\S]*?contents: write/);
  assert.equal(
    (workflow.match(/artifact-ids: \$\{\{ needs\.build\.outputs\.release_artifact_id \}\}/g) ?? []).length,
    4,
  );
  assert.match(workflow, /x64_smoke:\s*\n\s+needs: build/);
  assert.match(
    workflow,
    /x64_smoke:[\s\S]*?runs-on: windows-latest[\s\S]*?artifact-ids: \$\{\{ needs\.build\.outputs\.release_artifact_id \}\}[\s\S]*?npm run verify:release[\s\S]*?scripts\/smoke-release-windows\.ps1[\s\S]*?-Architecture x64/,
  );
  assert.match(workflow, /arm64_smoke:\s*\n\s+needs: build/);
  assert.match(
    workflow,
    /arm64_smoke:[\s\S]*?runs-on: windows-11-arm[\s\S]*?artifact-ids: \$\{\{ needs\.build\.outputs\.release_artifact_id \}\}[\s\S]*?npm run verify:release[\s\S]*?scripts\/smoke-release-windows\.ps1[\s\S]*?-Architecture arm64/,
  );
  assert.match(workflow, /attest:\s*\n\s+needs: \[build, x64_smoke, arm64_smoke\]/);
  assert.doesNotMatch(workflow, /GITHUB_TOKEN:/);
  assert.doesNotMatch(
    workflow,
    /arm64_smoke:[\s\S]*?scripts\/package-native-helper\.ps1[\s\S]*?\n\s{2}attest:/,
  );
  assert.match(workflow, /gh release create[\s\S]*?--draft/);
  assert.match(
    workflow,
    /gh release upload[\s\S]*?verify_release_assets[\s\S]*?gh release edit[^\r\n]+--draft=false/,
  );
  assert.doesNotMatch(workflow, /gh release create "\$RELEASE_TAG" "\$\{artifacts\[@\]\}"/);
  assert.doesNotMatch(workflow, /gh release create "\$\{\{ github\.ref_name \}\}"/);
  assert.doesNotMatch(workflow, /if \("\$\{\{ github\.ref_type \}\}"/);
});

test('x64 and ARM64 release smoke executes and installs each exact bounded artifact', () => {
  const smoke = read('scripts/smoke-release-windows.ps1');
  for (const fragment of [
    "[ValidateSet('x64', 'arm64')]",
    "'video-radar-host.exe'",
    "@('--ping')",
    "'deno.exe'",
    "@('--version')",
    "'ffmpeg.exe'",
    "'ffprobe.exe'",
    "@('-version')",
    "'yt-dlp.exe'",
    'WaitForExit($TimeoutSeconds * 1000)',
    'Kill($true)',
    'Assert-PeArchitecture',
    '0xaa64',
    '0x8664',
    '/VERYSILENT',
    '/SUPPRESSMSGBOXES',
    '/NORESTART',
    'build-info.json',
    'package-manifest.json',
    'Assert-InstalledRegistry',
    'Get-FileHash',
    'SHA256',
    '"win-$Architecture"',
    '"VideoRadar-$version-Developer-Windows-$Architecture.zip"',
    '"VideoRadar-Setup-$version-Windows-$Architecture.exe"',
    'finally',
    'Remove-OwnedRegistry',
  ]) assert.ok(smoke.includes(fragment), `smoke Windows sem ${fragment}`);
  assert.equal((smoke.match(/NativeMessagingHosts\\com\.videoradar\.helper/g) ?? []).length, 4);
  assert.match(smoke, /RUNNER_ENVIRONMENT -cne 'github-hosted'/);
  assert.doesNotMatch(smoke, /Invoke-WebRequest|GITHUB_TOKEN|gh\s+api/i);
});

test('all GitHub Actions references are pinned and CodeQL scans JavaScript and C#', () => {
  const workflows = ['.github/workflows/ci.yml', '.github/workflows/release.yml', '.github/workflows/codeql.yml']
    .map(read)
    .join('\n');
  const actionReferences = [...workflows.matchAll(/^\s*uses:\s*[^@\s]+@([^\s#]+)/gm)].map((match) => match[1]);
  assert.ok(actionReferences.length >= 10);
  for (const reference of actionReferences) assert.match(reference, /^[0-9a-f]{40}$/);

  const codeql = read('.github/workflows/codeql.yml');
  assert.match(codeql, /language: javascript-typescript/);
  assert.match(codeql, /language: csharp/);
  assert.match(codeql, /languages: \$\{\{ matrix\.language \}\}/);
  assert.match(codeql, /build-mode: \$\{\{ matrix\.build-mode \}\}/);
  assert.match(codeql, /security-events: write/);
  assert.match(codeql, /github\/codeql-action\/init@5595ccaf912efad79be6eef63a5619ff05969be3/);
  assert.match(codeql, /github\/codeql-action\/analyze@5595ccaf912efad79be6eef63a5619ff05969be3/);
});

test('release guide distinguishes unsigned builds from optional signing', () => {
  const guide = read('docs/RELEASING.md');
  for (const fragment of [
    'npm run check:all',
    'npm run check:release',
    'scripts/build-release.ps1',
    'SHA256SUMS.txt',
    'SBOM.spdx.json',
    'gh attestation verify',
    'SmartScreen',
    'SignPath Foundation',
    'Get-AuthenticodeSignature',
    'não estão assinados',
    'windows-11-arm',
    'proíbe fallback x64 silencioso',
    'invólucro do instalador ARM64 é a exceção explícita',
    'Desktop Edition',
    'Store Edition',
  ]) assert.ok(guide.includes(fragment), `guia sem ${fragment}`);
});
