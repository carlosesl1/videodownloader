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

const tagArgument = process.argv.find((value) => value.startsWith('--tag='));
if (tagArgument) {
  const tag = tagArgument.slice('--tag='.length);
  assert.equal(tag, `v${packageJson.version}`, `tag must be v${packageJson.version}`);
}
assert.equal(extensionIdFromKey(manifest.key), expectedExtensionId, 'stable extension ID changed');

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
  ['128px icon', manifest.icons?.['128']],
]) {
  assert.equal(typeof entry, 'string', `${label} is missing from manifest.json`);
  assert.ok(approvedFiles.has(entry), `${label} is outside the release allowlist`);
}

const remoteScript = /<script\b[^>]*\bsrc\s*=\s*["']https?:\/\//i;
for (const html of ['popup.html', 'options.html', 'offscreen.html']) {
  assert.doesNotMatch(await readFile(fromRoot(html), 'utf8'), remoteScript, `${html} contains a remote script`);
}

console.log(`Release contract passed for Video Radar ${packageJson.version} (${expectedExtensionId})`);
