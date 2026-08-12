import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const fromRoot = (...parts) => resolve(root, ...parts);
const directoryArgument = process.argv.find((value) => value.startsWith('--directory='));
const releaseRoot = directoryArgument
  ? resolve(process.cwd(), directoryArgument.slice('--directory='.length))
  : fromRoot('dist/release');

const packageJson = JSON.parse(await readFile(fromRoot('package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(fromRoot('manifest.json'), 'utf8'));
const toolLock = JSON.parse(await readFile(fromRoot('native-host/tool-lock.json'), 'utf8'));
assert.equal(packageJson.version, manifest.version, 'package.json and manifest.json versions differ');

const payloadNames = [
  'SBOM.spdx.json',
  `VideoRadar-${packageJson.version}-Developer-Windows-x64.zip`,
  `VideoRadar-${packageJson.version}-Developer-Windows-arm64.zip`,
  `VideoRadar-Setup-${packageJson.version}-Windows-x64.exe`,
  `VideoRadar-Setup-${packageJson.version}-Windows-arm64.exe`,
].sort();
const expectedNames = [...payloadNames, 'SHA256SUMS.txt'].sort();
const entries = await readdir(releaseRoot, { withFileTypes: true });
assert.deepEqual(entries.map((entry) => entry.name).sort(), expectedNames, 'release directory contains missing or unexpected artifacts');
for (const entry of entries) {
  assert.ok(entry.isFile(), `${entry.name} must be a regular file`);
  assert.ok((await stat(resolve(releaseRoot, entry.name))).size > 0, `${entry.name} must not be empty`);
}

async function readHeader(name, length) {
  const handle = await open(resolve(releaseRoot, name), 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function sha256File(name) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(resolve(releaseRoot, name))) hash.update(chunk);
  return hash.digest('hex');
}

const setupName = `VideoRadar-Setup-${packageJson.version}-Windows-x64.exe`;
const armSetupName = `VideoRadar-Setup-${packageJson.version}-Windows-arm64.exe`;
const developerZipName = `VideoRadar-${packageJson.version}-Developer-Windows-x64.zip`;
const armDeveloperZipName = `VideoRadar-${packageJson.version}-Developer-Windows-arm64.zip`;
for (const name of [setupName, armSetupName]) {
  assert.deepEqual([...await readHeader(name, 2)], [0x4d, 0x5a], `${name} must be a Windows PE executable`);
}
for (const name of [developerZipName, armDeveloperZipName]) {
  assert.deepEqual([...await readHeader(name, 2)], [0x50, 0x4b], `${name} must be a ZIP archive`);
}
assert.ok((await stat(resolve(releaseRoot, 'SBOM.spdx.json'))).size <= 16 * 1024 * 1024, 'SBOM exceeds the GitHub attestation limit');

const checksumSource = await readFile(resolve(releaseRoot, 'SHA256SUMS.txt'), 'utf8');
assert.ok(checksumSource.endsWith('\n'), 'SHA256SUMS.txt must end with a newline');
const checksumLines = checksumSource.trimEnd().split(/\r?\n/);
assert.equal(checksumLines.length, payloadNames.length, 'SHA256SUMS.txt must cover every payload exactly once');

const checksums = new Map();
for (const line of checksumLines) {
  const match = line.match(/^([0-9a-f]{64})  ([^/\\]+)$/);
  assert.ok(match, `invalid checksum line: ${line}`);
  assert.ok(!checksums.has(match[2]), `duplicate checksum entry: ${match[2]}`);
  checksums.set(match[2], match[1]);
}
assert.deepEqual([...checksums.keys()].sort(), payloadNames, 'SHA256SUMS.txt names differ from release payloads');

for (const name of payloadNames) {
  const digest = await sha256File(name);
  assert.equal(checksums.get(name), digest, `SHA-256 mismatch for ${name}`);
}

const sbom = JSON.parse(await readFile(resolve(releaseRoot, 'SBOM.spdx.json'), 'utf8'));
assert.equal(sbom.spdxVersion, 'SPDX-2.3');
assert.equal(sbom.dataLicense, 'CC0-1.0');
assert.equal(sbom.name, `Video Radar ${packageJson.version} release SBOM`);
assert.equal(typeof sbom.comment, 'string');
assert.ok(!Object.hasOwn(sbom, 'documentComment'), 'SBOM must use the SPDX JSON comment property');
assert.match(sbom.documentNamespace, new RegExp(`/v${packageJson.version.replaceAll('.', '\\.')}\/sbom-[0-9a-f]{16}$`));
const packages = new Map(sbom.packages.map((entry) => [entry.name, entry]));
assert.equal(packages.get('Video Radar')?.versionInfo, packageJson.version);
assert.equal(packages.get('Video Radar Chromium extension')?.versionInfo, packageJson.version);
for (const rid of ['win-x64', 'win-arm64']) {
  assert.equal(packages.get(`Video Radar Native Messaging host (${rid})`)?.versionInfo, packageJson.version);
}
assert.equal(packages.get('Microsoft .NET Runtime')?.versionInfo, '10.0.11');
assert.deepEqual(toolLock.targets?.map(({ rid }) => rid), ['win-x64', 'win-arm64']);
for (const target of toolLock.targets) {
  for (const source of target.sources) {
    const component = packages.get(`${source.name} (${target.rid})`);
    assert.equal(component?.versionInfo, source.version, `SBOM version mismatch for ${target.rid}/${source.name}`);
    assert.deepEqual(component?.checksums, [{ algorithm: 'SHA256', checksumValue: source.sha256 }], `SBOM checksum mismatch for ${target.rid}/${source.name}`);
  }
}

console.log(`Release artifacts verified for Video Radar ${packageJson.version}: ${expectedNames.join(', ')}`);
