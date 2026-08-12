# Video Radar V1 Distribution Implementation Plan

> **For agentic workers:** Execute directly by default. Use subagents only for independent bounded lanes that satisfy the global harness policy. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a reproducible, per-user Windows V1 installer, developer fallback ZIP, checksums, onboarding, release automation and recipient documentation for Video Radar 1.0.0.

**Architecture:** Keep the existing extension and native-helper build as the product source of truth, then stage an allowlisted release payload under `.tools`. A project-local, hash-pinned Inno Setup compiler turns that payload into one offline installer which writes the native manifest and HKCU registrations itself. A Node release-contract validator and the existing JavaScript/.NET suites guard version agreement, extension identity, installer boundaries and artifact naming.

**Tech Stack:** Manifest V3, Node.js 22 test runner, PowerShell 5.1+, .NET 10, Inno Setup 7.0.2, GitHub Actions and GitHub CLI.

---

## File structure

- `test/release-distribution.test.js`: offline contract tests for the release builder, installer, onboarding and workflow.
- `scripts/validate-release.mjs`: validates tag/package/manifest agreement, extension identity and release source boundaries.
- `scripts/bootstrap-inno-setup.ps1`: obtains the official pinned compiler into `.tools` without a machine-global installation.
- `installer/inno-tool-lock.json`: immutable Inno Setup URL, size, SHA-256 and expected publisher.
- `scripts/build-v1-release.ps1`: stages the allowlisted payload, invokes existing helper packaging, compiles the installer, creates the developer ZIP and writes checksums.
- `installer/video-radar.iss`: per-user installer, native manifest, four HKCU registrations, post-copy ping, onboarding shortcuts and uninstall cleanup.
- `installer/onboarding/index.html`: offline Portuguese browser-installation guide.
- `installer/onboarding/styles.css`: self-contained responsive styling and numbered browser visuals.
- `installer/README-INSTALL.txt`: plain-text developer ZIP instructions.
- `.github/workflows/release.yml`: tests and builds every manual run; publishes only a stable `v*` tag.
- `docs/RELEASING.md`: maintainer release, signing and manual smoke-test procedure.
- `README.md`, `docs/README.pt-BR.md`, `PRIVACY.md`, `CHANGELOG.md`: V1 recipient and maintainer documentation.
- `native-host/VideoRadar.NativeHost/Tools/UpdatePolicy.cs`: converts the legacy self-updater into a no-mutation release policy.
- `native-host/VideoRadar.NativeHost.Tests/TestSuite.Server.cs`: verifies pinned tools are never updated in place.
- `package.json`: adds offline release validation and explicit release-build commands.
- `.gitignore`: excludes release staging and generated artifacts.

### Task 1: Establish the failing V1 release contract

**Files:**
- Create: `test/release-distribution.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write the failing Node contract test**

Create a test that reads the future release files and asserts the exact contract:

```js
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
```

- [ ] **Step 2: Add release commands to `package.json`**

Add these entries without changing the existing test commands:

```json
"check:release": "node scripts/validate-release.mjs",
"build:release": "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-v1-release.ps1"
```

- [ ] **Step 3: Run the focused test and confirm the red state**

Run:

```powershell
node --test test/release-distribution.test.js
```

Expected: FAIL because the release scripts, installer and onboarding files do not exist.

### Task 2: Stop bundled-tool mutation

**Files:**
- Modify: `native-host/VideoRadar.NativeHost/Tools/UpdatePolicy.cs`
- Modify: `native-host/VideoRadar.NativeHost.Tests/TestSuite.Server.cs`

- [ ] **Step 1: Replace the updater assertion with a pinned-tool test**

Register and implement this test:

```csharp
private static async Task UpdatePolicyNeverMutatesPinnedTools()
{
    var runner = new UpdateProcessRunner(
        _ => throw new InvalidOperationException("The pinned-tool policy invoked a process."));
    var policy = new UpdatePolicy(@"C:\VideoRadar\host\tools", runner);

    await policy.CheckAsync(CancellationToken.None);

    Equal(0, runner.Calls.Count);
}
```

- [ ] **Step 2: Run the native suite and confirm the red state**

Run:

```powershell
npm run test:native
```

Expected: FAIL because the existing policy invokes `yt-dlp --ignore-config -U`.

- [ ] **Step 3: Make the production policy a cancellation-aware no-op**

Replace the mutable policy implementation with:

```csharp
using VideoRadar.NativeHost.Processes;

namespace VideoRadar.NativeHost.Tools;

public interface IUpdatePolicy
{
    Task CheckAsync(CancellationToken cancellationToken);
}

public sealed class UpdatePolicy : IUpdatePolicy
{
    public UpdatePolicy(string toolsDirectory, IProcessRunner processRunner)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(toolsDirectory);
        ArgumentNullException.ThrowIfNull(processRunner);
    }

    public Task CheckAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.CompletedTask;
    }
}
```

- [ ] **Step 4: Run the native suite**

Run:

```powershell
npm run test:native
```

Expected: PASS, with no production `-U` invocation.

### Task 3: Pin and bootstrap the installer compiler locally

**Files:**
- Create: `installer/inno-tool-lock.json`
- Create: `scripts/bootstrap-inno-setup.ps1`
- Modify: `.gitignore`

- [ ] **Step 1: Add the verified compiler lock**

```json
{
  "schemaVersion": 1,
  "version": "7.0.2",
  "fileName": "innosetup-7.0.2-x64.exe",
  "url": "https://github.com/jrsoftware/issrc/releases/download/is-7_0_2/innosetup-7.0.2-x64.exe",
  "size": 17020192,
  "sha256": "5ad54ca3def786f8f4212552e54cc6d8d61329e2d24a1cfee0571d42c2684ff1",
  "publisher": "CN=Pyrsys B.V., O=Pyrsys B.V., S=Noord-Holland, C=NL"
}
```

- [ ] **Step 2: Implement a project-local bootstrap**

The script must resolve all paths, reject broad targets, download only the locked URL, validate exact size and SHA-256, require a valid Authenticode signature from the locked publisher, and invoke:

```powershell
& $installerPath '/PORTABLE=1' '/VERYSILENT' '/SUPPRESSMSGBOXES' '/NORESTART' "/DIR=$readyRoot"
if ($LASTEXITCODE -ne 0) {
  throw "Inno Setup portátil falhou com código $LASTEXITCODE."
}
$isccPath = Join-Path $readyRoot 'ISCC.exe'
if (-not (Test-Path -LiteralPath $isccPath -PathType Leaf)) {
  throw 'ISCC.exe não foi produzido pelo bootstrap.'
}
Write-Output $isccPath
```

The script may reuse a valid cached installer but must never call `winget`, Chocolatey, `Program Files` installation or an unverified mirror.

- [ ] **Step 3: Exclude generated release tooling**

Append:

```gitignore
.tools/inno-*/
.tools/v1-release/
dist/release/
```

- [ ] **Step 4: Run the focused compiler-lock tests**

Run:

```powershell
node --test test/release-distribution.test.js
```

Expected: remaining failures concern the release validator, installer, onboarding, workflow and docs; compiler-lock assertions pass.

### Task 4: Build the release validator and staged payload

**Files:**
- Create: `scripts/validate-release.mjs`
- Create: `scripts/build-v1-release.ps1`
- Create: `installer/README-INSTALL.txt`

- [ ] **Step 1: Implement version and identity validation**

`validate-release.mjs` must:

```js
const expectedId = 'cakpfifpfmbdcilimpedanglnopnmckg';
const packageJson = JSON.parse(await readFile(fromRoot('package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(fromRoot('manifest.json'), 'utf8'));
assert(packageJson.version === manifest.version, 'package.json and manifest.json versions differ');
const tag = process.argv.find((value) => value.startsWith('--tag='))?.slice(6);
if (tag) assert(tag === `v${packageJson.version}`, `tag must be v${packageJson.version}`);
assert(extensionIdFromKey(manifest.key) === expectedId, 'stable extension ID changed');
console.log(`Release contract passed for Video Radar ${packageJson.version} (${expectedId})`);
```

It must also reject prerelease/build metadata, missing production entry points, remote scripts and an extension file outside these release roots:

```js
const topLevel = ['manifest.json', 'popup.html', 'options.html', 'offscreen.html'];
const allowedTrees = new Map([
  ['assets', new Set(['.png'])],
  ['styles', new Set(['.css'])],
  ['src', new Set(['.js'])],
]);
```

- [ ] **Step 2: Implement atomic release staging**

`build-v1-release.ps1` must:

1. derive version from `package.json`;
2. run `node scripts/validate-release.mjs --tag=v<version>`;
3. call `scripts/package-native-helper.ps1` into `.tools\v1-release\helper`;
4. create a GUID-suffixed staging directory;
5. copy only the four top-level extension files plus `.png`, `.css` and `.js` files from the three approved trees;
6. copy helper `host` and `licenses`;
7. copy `LICENSE`, `PRIVACY.md`, `SECURITY.md`, onboarding and ZIP instructions;
8. write `build-info.json` with version, extension ID and the SHA-256 of `native-host/tool-lock.json`;
9. bootstrap or accept an explicit `ISCC.exe`;
10. compile `installer/video-radar.iss`;
11. create `VideoRadar-<version>-Developer.zip`;
12. write sorted lowercase SHA-256 lines to `SHA256SUMS.txt`;
13. atomically replace `dist\release`.

The compilation call is:

```powershell
& $isccPath '/Qp' "/DReleaseVersion=$Version" "/DPayloadRoot=$payloadRoot" `
  "/O$artifactStaging" "/FVideoRadar-Setup-$Version-Windows-x64" `
  (Join-Path $projectRoot 'installer\video-radar.iss')
if ($LASTEXITCODE -ne 0) {
  throw "ISCC falhou com código $LASTEXITCODE."
}
```

The developer archive root must contain `Extension`, `Helper`, `LICENSE`,
`PRIVACY.md`, `SECURITY.md` and `README-INSTALL.txt`.

- [ ] **Step 3: Add plain-text fallback instructions**

`README-INSTALL.txt` must tell the developer recipient to run
`Helper\Instalar-Video-Radar.cmd`, then load `Extension`, and must state the
stable ID and the authorized-use boundary.

- [ ] **Step 4: Run the offline release validator**

Run:

```powershell
npm run check:release
```

Expected: PASS with version `1.0.0` and extension ID `cakpfifpfmbdcilimpedanglnopnmckg`.

### Task 5: Implement the offline per-user installer and onboarding

**Files:**
- Create: `installer/video-radar.iss`
- Create: `installer/onboarding/index.html`
- Create: `installer/onboarding/styles.css`

- [ ] **Step 1: Define the Inno Setup contract**

Use this setup identity and boundary:

```ini
[Setup]
AppId={{7A5C59C3-0DCE-4D0C-9BE1-5621E2AA4EA4}
AppName=Video Radar
AppVersion={#ReleaseVersion}
AppPublisher=Carlos
AppPublisherURL=https://github.com/carlosesl1/videodownloader
DefaultDirName={localappdata}\VideoRadar
DefaultGroupName=Video Radar
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\Extension\assets\icon-128.png
```

Copy extension, helper, licenses, legal files and onboarding from
`{#PayloadRoot}`. Add a Start Menu shortcut called **Como instalar no navegador**
and a completion task that opens the offline guide and the installed
`Extension` folder.

- [ ] **Step 2: Register and clean up the four native hosts**

Use four `[Registry]` records with `Root: HKCU`, default value
`{app}\native-host\com.videoradar.helper.json`, and
`uninsdeletekey`. Do not add browser extension policy keys.

- [ ] **Step 3: Generate and validate the native manifest**

In `[Code]`, write UTF-8 JSON containing:

```json
{
  "name": "com.videoradar.helper",
  "description": "Auxiliar local do Vídeo Radar",
  "path": "<absolute installed host path>",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://cakpfifpfmbdcilimpedanglnopnmckg/"
  ]
}
```

Then execute `{app}\host\video-radar-host.exe --ping` hidden and raise a setup
exception when the executable cannot start or returns a non-zero exit code.

- [ ] **Step 4: Build the local onboarding**

The HTML must have five numbered, visual cards:

1. open the correct browser extensions URL;
2. enable **Modo do desenvolvedor**;
3. choose **Carregar sem compactação**;
4. select the already-open `Extension` folder;
5. pin Video Radar and use **Buscar vídeos**.

It must also cover the Developer mode warning, supported browsers, stable ID,
authorized use, helper diagnosis, upgrades, Apps & Features uninstall and
manual removal of the browser extension. CSS must be responsive, high-contrast,
offline and use no remote fonts/scripts/images.

- [ ] **Step 5: Run the focused contract**

Run:

```powershell
node --test test/release-distribution.test.js
```

Expected: installer and onboarding assertions pass; workflow/docs assertions may still fail.

### Task 6: Automate GitHub artifacts and optional signing

**Files:**
- Create: `.github/workflows/release.yml`
- Create: `docs/RELEASING.md`

- [ ] **Step 1: Add a stable-tag release workflow**

Trigger on `workflow_dispatch` and tags `v*`. Use `windows-latest`,
`actions/checkout@v7`, `actions/setup-node@v7`, `actions/setup-dotnet@v6`, run
`npm run check:all`, bootstrap the pinned project-local Inno Setup, run
`npm run build:release`, upload `dist/release/*`, and publish only when:

```yaml
if: startsWith(github.ref, 'refs/tags/v')
env:
  GH_TOKEN: ${{ github.token }}
run: gh release create "${{ github.ref_name }}" dist/release/* --verify-tag --generate-notes
```

Set `permissions.contents: write`, a 45-minute timeout and release-tag
concurrency. A manual branch run produces artifacts but never a public release.

- [ ] **Step 2: Document maintainer release and signing**

`docs/RELEASING.md` must provide exact commands:

```powershell
npm run check:all
npm run check:release
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-v1-release.ps1
Get-Content dist\release\SHA256SUMS.txt
```

Document the stable-tag sequence, unsigned SmartScreen warning, SignPath
Foundation application path, and an optional post-build Authenticode signing
step that signs only the final setup EXE and regenerates `SHA256SUMS.txt`.
It must not claim the current artifact is signed.

- [ ] **Step 3: Run workflow and documentation contract tests**

Run:

```powershell
node --test test/release-distribution.test.js
```

Expected: PASS.

### Task 7: Rewrite recipient documentation for V1

**Files:**
- Modify: `README.md`
- Modify: `docs/README.pt-BR.md`
- Modify: `PRIVACY.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Make the installer the primary route**

README files must lead with:

```text
Baixe VideoRadar-Setup-1.0.0-Windows-x64.exe na página Releases, execute o
instalador e siga o guia local aberto ao final. Não é necessário PowerShell,
.NET, npm ou acesso de administrador.
```

Keep “install from source” as a maintainer/developer section, not the normal
recipient path. Explain that browser Developer mode and **Load unpacked** remain
manual because the project does not use a browser store or enterprise policy.

- [ ] **Step 2: Align privacy and update language**

Remove the daily `yt-dlp` update claim. State that pinned tools contact their
public media sources only for user-requested discovery/downloads and are
replaced solely by a new Video Radar installer.

- [ ] **Step 3: Finalize the V1 changelog**

Move the completed distribution work under `1.0.0` and include the offline
installer, local onboarding, per-user uninstall, stable extension ID,
reproducible tool lock, developer ZIP and SHA-256 file.

- [ ] **Step 4: Run text/preflight checks**

Run:

```powershell
npm run check
```

Expected: extension preflight and all JavaScript tests pass with no mojibake.

### Task 8: Build and verify the real V1 artifacts

**Files:**
- Generated: `dist/release/VideoRadar-Setup-1.0.0-Windows-x64.exe`
- Generated: `dist/release/VideoRadar-1.0.0-Developer.zip`
- Generated: `dist/release/SHA256SUMS.txt`

- [ ] **Step 1: Run the complete offline proof after the final source edit**

Run:

```powershell
npm run check:all
```

Expected: extension preflight, all JavaScript tests and all native-host tests pass.

- [ ] **Step 2: Build the complete release**

Run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-v1-release.ps1
```

Expected: the pinned helper tools are validated, the host ping passes, Inno
Setup compiles the installer and all three release files appear in
`dist\release`.

- [ ] **Step 3: Verify artifact hashes and payload**

For each line in `SHA256SUMS.txt`, recompute `Get-FileHash -Algorithm SHA256`
and require an exact lowercase match. Expand the developer ZIP into a
GUID-named `.tools\v1-release\verify-*` directory and confirm its root contains
exactly the documented files. Run the staged `Helper\host\video-radar-host.exe
--ping` and require JSON `ok: true`.

- [ ] **Step 4: Perform a reversible isolated installer smoke test**

Run the setup silently with a GUID-named directory under `.tools`:

```powershell
dist\release\VideoRadar-Setup-1.0.0-Windows-x64.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /NOICONS "/DIR=<verified isolated path>"
```

Confirm installed payload and `--ping`. Because Native Messaging registration
uses the real current-user HKCU paths, snapshot the four exact keys before the
test, then run the generated uninstaller and restore only those four snapshots.
Do not delete browser data or download folders. If the installer contract does
not allow a safe registry override, record interactive installation as the
remaining manual gate instead of mutating a working browser configuration.

- [ ] **Step 5: Inspect the final diff and preserve unrelated work**

Run:

```powershell
git diff --check
git status --short
```

Review only the V1 distribution hunks. Do not stage, revert or rewrite the
existing social/download work owned by the user.

## Execution selection

The user authorized continuation after approving the design. Use **current
session execution**, the recommended option, and keep all work in the existing
`codex/video-radar` worktree so the active product changes are included in the
V1 build without being reverted.
