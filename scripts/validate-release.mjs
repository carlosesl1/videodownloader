import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const fromRoot = (...parts) => resolve(root, ...parts);
const expectedExtensionId = 'cakpfifpfmbdcilimpedanglnopnmckg';
const topLevel = ['manifest.json', 'popup.html', 'options.html', 'offscreen.html'];
const allowedTrees = new Map([
  ['assets', new Set(['.png'])],
  ['styles', new Set(['.css'])],
  ['src', new Set(['.js'])],
]);

function extensionIdFromKey(key) {
  assert.equal(typeof key, 'string', 'manifest.key must be a string');
  const publicKey = Buffer.from(key, 'base64');
  assert.ok(publicKey.length > 0, 'manifest.key must contain a public key');
  assert.equal(publicKey.toString('base64'), key, 'manifest.key must use canonical base64');
  const digest = createHash('sha256').update(publicKey).digest().subarray(0, 16);
  return [...digest]
    .flatMap((byte) => [byte >> 4, byte & 15])
    .map((nibble) => String.fromCharCode(97 + nibble))
    .join('');
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  }));
  return files.flat();
}

const packageJson = JSON.parse(await readFile(fromRoot('package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(fromRoot('manifest.json'), 'utf8'));
assert.match(packageJson.version, /^\d+\.\d+\.\d+$/, 'package version must be stable semver');
assert.equal(packageJson.version, manifest.version, 'package.json and manifest.json versions differ');
assert.equal(manifest.incognito, 'not_allowed', 'incognito must be explicitly disabled');
assert.equal(
  manifest.content_security_policy?.extension_pages,
  "script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none';",
  'extension CSP differs from the approved policy',
);

const tagArgument = process.argv.find((value) => value.startsWith('--tag='));
if (tagArgument) {
  const tag = tagArgument.slice('--tag='.length);
  assert.equal(tag, `v${packageJson.version}`, `tag must be v${packageJson.version}`);
}
assert.equal(extensionIdFromKey(manifest.key), expectedExtensionId, 'stable extension ID changed');

for (const [script, expectedFile] of [
  ['build:release', 'scripts/build-release.ps1'],
  ['release:sbom', 'scripts/generate-sbom.mjs'],
  ['verify:release', 'scripts/verify-release-artifacts.mjs'],
]) {
  assert.equal(typeof packageJson.scripts?.[script], 'string', `${script} is missing from package.json`);
  assert.ok(packageJson.scripts[script].includes(expectedFile), `${script} must invoke ${expectedFile}`);
  await access(fromRoot(expectedFile));
}

const releaseLabel = `Video Radar ${packageJson.version}`;
const setupName = `VideoRadar-Setup-${packageJson.version}-Windows-x64.exe`;
const armSetupName = `VideoRadar-Setup-${packageJson.version}-Windows-arm64.exe`;
const developerZipName = `VideoRadar-${packageJson.version}-Developer-Windows-x64.zip`;
const armDeveloperZipName = `VideoRadar-${packageJson.version}-Developer-Windows-arm64.zip`;
const versionedDocuments = [
  ['README.md', setupName],
  ['README.md', armSetupName],
  ['docs/README.pt-BR.md', setupName],
  ['docs/README.pt-BR.md', armSetupName],
  ['docs/RELEASING.md', setupName],
  ['docs/RELEASING.md', armSetupName],
  ['docs/RELEASING.md', developerZipName],
  ['docs/RELEASING.md', armDeveloperZipName],
  ['installer/README-INSTALL.txt', setupName],
  ['installer/README-INSTALL.txt', releaseLabel.toUpperCase()],
  ['CHANGELOG.md', `## ${packageJson.version} —`],
];
for (const [file, fragment] of versionedDocuments) {
  assert.ok((await readFile(fromRoot(file), 'utf8')).includes(fragment), `${file} is not aligned with version ${packageJson.version}`);
}

const workflowFiles = ['.github/workflows/ci.yml', '.github/workflows/codeql.yml', '.github/workflows/release.yml'];
const workflowSource = (await Promise.all(workflowFiles.map((file) => readFile(fromRoot(file), 'utf8')))).join('\n');
const actionReferences = [...workflowSource.matchAll(/^\s*uses:\s*[^@\s]+@([^\s#]+)/gm)].map((match) => match[1]);
assert.ok(actionReferences.length > 0, 'workflows must invoke pinned actions');
for (const reference of actionReferences) assert.match(reference, /^[0-9a-f]{40}$/, `action ref must be an immutable SHA: ${reference}`);
for (const fragment of [
  'javascript-typescript', 'csharp', 'security-events: write',
  'attestations: write', 'artifact-metadata: write', 'id-token: write',
  'dist/release/VideoRadar-Setup-*-Windows-*.exe',
  'dist/release/VideoRadar-*-Developer-Windows-*.zip',
  'windows-11-arm',
  'sbom-path: dist/release/SBOM.spdx.json', 'npm run verify:release',
]) assert.ok(workflowSource.includes(fragment), `release automation is missing ${fragment}`);
assert.doesNotMatch(workflowSource, /subject-checksums:/, 'release provenance must resolve explicit subjects');

await Promise.all(topLevel.map((file) => access(fromRoot(file))));
const approvedFiles = new Set(topLevel);
for (const [directory, extensions] of allowedTrees) {
  const files = await walk(fromRoot(directory));
  assert.ok(files.length > 0, `${directory} must contain release files`);
  for (const file of files) {
    assert.ok(extensions.has(extname(file)), `${relative(root, file)} is outside the release allowlist`);
    approvedFiles.add(relative(root, file).replaceAll('\\', '/'));
  }
}

for (const [label, entry] of [
  ['action popup', manifest.action?.default_popup],
  ['background worker', manifest.background?.service_worker],
  ['options page', manifest.options_ui?.page],
  ['16px icon', manifest.icons?.['16']],
  ['32px icon', manifest.icons?.['32']],
  ['48px icon', manifest.icons?.['48']],
  ['128px icon', manifest.icons?.['128']],
]) {
  assert.equal(typeof entry, 'string', `${label} is missing from manifest.json`);
  assert.ok(approvedFiles.has(entry), `${label} is outside the release allowlist`);
}
assert.deepEqual(manifest.action?.default_icon, manifest.icons, 'action and extension icons must match');

const remoteScript = /<script\b[^>]*\bsrc\s*=\s*["']https?:\/\//i;
for (const html of ['popup.html', 'options.html', 'offscreen.html']) {
  assert.doesNotMatch(await readFile(fromRoot(html), 'utf8'), remoteScript, `${html} contains a remote script`);
}

console.log(`Release contract passed for Video Radar ${packageJson.version} (${expectedExtensionId})`);
