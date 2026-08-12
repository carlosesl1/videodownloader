import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('release SBOM is deterministic and the artifact verifier rejects missing payloads', (context) => {
  const releaseRoot = mkdtempSync(path.join(tmpdir(), 'video-radar-release-'));
  context.after(() => rmSync(releaseRoot, { recursive: true, force: true }));
  const sbomPath = path.join(releaseRoot, 'SBOM.spdx.json');
  const generate = () => spawnSync(process.execPath, ['scripts/generate-sbom.mjs', `--output=${sbomPath}`], {
    cwd: root,
    encoding: 'utf8',
  });

  const first = generate();
  assert.equal(first.status, 0, first.stderr);
  const firstSbom = readFileSync(sbomPath, 'utf8');
  const second = generate();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(sbomPath, 'utf8'), firstSbom);

  const sbom = JSON.parse(firstSbom);
  assert.equal(sbom.spdxVersion, 'SPDX-2.3');
  assert.equal(typeof sbom.comment, 'string');
  assert.equal(Object.hasOwn(sbom, 'documentComment'), false);
  assert.equal(sbom.packages.find((entry) => entry.name === 'Video Radar').versionInfo, '1.2.0');
  assert.equal(sbom.packages.find((entry) => entry.name === 'Microsoft .NET Runtime').versionInfo, '10.0.11');
  for (const component of [
    'Microsoft .NET Runtime',
    'Video Radar Native Messaging host (win-x64)',
    'Video Radar Native Messaging host (win-arm64)',
    'deno (win-x64)',
    'deno (win-arm64)',
    'ffmpeg (win-x64)',
    'ffmpeg (win-arm64)',
    'yt-dlp (win-x64)',
    'yt-dlp (win-arm64)',
  ]) {
    assert.ok(sbom.packages.some((entry) => entry.name === component), `SBOM sem ${component}`);
  }

  const payloadNames = [
    'SBOM.spdx.json',
    'VideoRadar-1.2.0-Developer-Windows-x64.zip',
    'VideoRadar-1.2.0-Developer-Windows-arm64.zip',
    'VideoRadar-Setup-1.2.0-Windows-x64.exe',
    'VideoRadar-Setup-1.2.0-Windows-arm64.exe',
  ].sort();
  for (const name of payloadNames.filter((name) => name.endsWith('.zip'))) {
    writeFileSync(path.join(releaseRoot, name), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x66, 0x69, 0x78]));
  }
  for (const name of payloadNames.filter((name) => name.endsWith('.exe'))) {
    writeFileSync(path.join(releaseRoot, name), Buffer.from([0x4d, 0x5a, 0x66, 0x69, 0x78]));
  }
  const checksums = payloadNames.map((name) => {
    const digest = createHash('sha256').update(readFileSync(path.join(releaseRoot, name))).digest('hex');
    return `${digest}  ${name}`;
  });
  writeFileSync(path.join(releaseRoot, 'SHA256SUMS.txt'), `${checksums.join('\n')}\n`);

  const verify = () => spawnSync(process.execPath, ['scripts/verify-release-artifacts.mjs', `--directory=${releaseRoot}`], {
    cwd: root,
    encoding: 'utf8',
  });
  const complete = verify();
  assert.equal(complete.status, 0, complete.stderr);
  assert.match(complete.stdout, /Release artifacts verified/);

  unlinkSync(path.join(releaseRoot, 'VideoRadar-1.2.0-Developer-Windows-arm64.zip'));
  const incomplete = verify();
  assert.notEqual(incomplete.status, 0);
  assert.match(incomplete.stderr, /missing or unexpected artifacts/);
});
