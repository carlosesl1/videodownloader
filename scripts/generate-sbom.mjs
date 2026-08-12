import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const fromRoot = (...parts) => resolve(root, ...parts);
const outputArgument = process.argv.find((value) => value.startsWith('--output='));
const outputPath = outputArgument
  ? resolve(process.cwd(), outputArgument.slice('--output='.length))
  : fromRoot('dist/release/SBOM.spdx.json');

const packageSource = await readFile(fromRoot('package.json'), 'utf8');
const manifestSource = await readFile(fromRoot('manifest.json'), 'utf8');
const packageJson = JSON.parse(packageSource);
const manifest = JSON.parse(manifestSource);
const toolLockSource = await readFile(fromRoot('native-host/tool-lock.json'), 'utf8');
const toolLock = JSON.parse(toolLockSource);
const nativeProject = await readFile(fromRoot('native-host/VideoRadar.NativeHost/VideoRadar.NativeHost.csproj'), 'utf8');
const dotnetBootstrap = await readFile(fromRoot('scripts/bootstrap-dotnet.ps1'), 'utf8');
const changelog = await readFile(fromRoot('CHANGELOG.md'), 'utf8');
const generatorSource = await readFile(fileURLToPath(import.meta.url), 'utf8');

assert.match(packageJson.version, /^\d+\.\d+\.\d+$/, 'package version must be stable semver');
assert.equal(manifest.version, packageJson.version, 'package.json and manifest.json versions differ');
assert.equal(toolLock.schemaVersion, 2, 'native tool lock schema must be 2');
assert.deepEqual(toolLock.targets?.map(({ rid }) => rid), ['win-x64', 'win-arm64'], 'native tool lock targets differ');

const escapedVersion = packageJson.version.replaceAll('.', '\\.');
const releaseHeading = changelog.match(new RegExp(`^## ${escapedVersion} — (\\d{4}-\\d{2}-\\d{2})$`, 'm'));
assert.ok(releaseHeading, `CHANGELOG.md must contain a dated ${packageJson.version} release heading`);

const sbomInputDigest = createHash('sha256')
  .update(packageSource).update('\0')
  .update(manifestSource).update('\0')
  .update(toolLockSource).update('\0')
  .update(nativeProject).update('\0')
  .update(dotnetBootstrap).update('\0')
  .update(changelog).update('\0')
  .update(generatorSource)
  .digest('hex');
const documentNamespace = [
  'https://github.com/carlosesl1/videodownloader/releases/tag',
  `v${packageJson.version}`,
  `sbom-${sbomInputDigest.slice(0, 16)}`,
].join('/');

const packageTemplate = (values) => ({
  downloadLocation: 'NOASSERTION',
  filesAnalyzed: false,
  licenseConcluded: 'NOASSERTION',
  licenseDeclared: 'NOASSERTION',
  copyrightText: 'NOASSERTION',
  ...values,
});

const productPackage = packageTemplate({
  SPDXID: 'SPDXRef-Package-VideoRadar',
  name: 'Video Radar',
  versionInfo: packageJson.version,
  licenseDeclared: 'MIT',
  homepage: 'https://github.com/carlosesl1/videodownloader',
});
const extensionPackage = packageTemplate({
  SPDXID: 'SPDXRef-Package-Extension',
  name: 'Video Radar Chromium extension',
  versionInfo: packageJson.version,
  licenseDeclared: 'MIT',
});
const nativeHostPackages = toolLock.targets.map((target) => packageTemplate({
  SPDXID: `SPDXRef-Package-NativeHost-${target.rid}`,
  name: `Video Radar Native Messaging host (${target.rid})`,
  versionInfo: packageJson.version,
  licenseDeclared: 'MIT',
  comment: `Self-contained Windows host built for ${target.architecture}.`,
}));
const runtimeMajor = nativeProject.match(/<TargetFramework>net(\d+)\.\d+<\/TargetFramework>/)?.[1];
assert.ok(runtimeMajor, 'native host target framework is missing or unsupported');
const runtimeVersion = `${runtimeMajor}.0.11`;
const dotnetRuntimePackage = packageTemplate({
  SPDXID: 'SPDXRef-Package-DotnetRuntime',
  name: 'Microsoft .NET Runtime',
  versionInfo: runtimeVersion,
  comment: `Self-contained runtime patch ${runtimeVersion} supplied by the pinned .NET SDK 10.0.400.`,
  externalRefs: [{
    referenceCategory: 'OTHER',
    referenceType: 'repository',
    referenceLocator: 'https://github.com/dotnet/runtime',
  }],
});

const toolPackagesByTarget = new Map(toolLock.targets.map((target) => [
  target.rid,
  target.sources.map((source) => {
    assert.match(source.sha256, /^[0-9a-f]{64}$/, `invalid SHA-256 for ${target.rid}/${source.name}`);
    assert.equal(typeof source.version, 'string', `missing version for ${target.rid}/${source.name}`);
    assert.match(source.repository, /^[^/]+\/[^/]+$/, `invalid repository for ${target.rid}/${source.name}`);
    return packageTemplate({
      SPDXID: `SPDXRef-Package-Tool-${target.rid}-${source.name.replaceAll(/[^A-Za-z0-9.-]/g, '-')}`,
      name: `${source.name} (${target.rid})`,
      versionInfo: source.version,
      downloadLocation: source.url,
      checksums: [{ algorithm: 'SHA256', checksumValue: source.sha256 }],
      comment: `Native ${target.architecture} tool; no cross-architecture fallback is permitted.`,
      externalRefs: [{
        referenceCategory: 'OTHER',
        referenceType: 'repository',
        referenceLocator: `https://github.com/${source.repository}`,
      }],
    });
  }),
]));
const toolPackages = [...toolPackagesByTarget.values()].flat();

const relationships = [
  {
    spdxElementId: 'SPDXRef-DOCUMENT',
    relationshipType: 'DESCRIBES',
    relatedSpdxElement: productPackage.SPDXID,
  },
  ...[extensionPackage, ...nativeHostPackages].map((component) => ({
    spdxElementId: productPackage.SPDXID,
    relationshipType: 'CONTAINS',
    relatedSpdxElement: component.SPDXID,
  })),
  ...nativeHostPackages.flatMap((host, index) => [
    ...(toolPackagesByTarget.get(toolLock.targets[index].rid) ?? []).map((tool) => ({
      spdxElementId: host.SPDXID,
      relationshipType: 'DEPENDS_ON',
      relatedSpdxElement: tool.SPDXID,
    })),
    {
      spdxElementId: host.SPDXID,
      relationshipType: 'DEPENDS_ON',
      relatedSpdxElement: dotnetRuntimePackage.SPDXID,
    },
  ]),
];

const sbom = {
  spdxVersion: 'SPDX-2.3',
  dataLicense: 'CC0-1.0',
  SPDXID: 'SPDXRef-DOCUMENT',
  name: `Video Radar ${packageJson.version} release SBOM`,
  documentNamespace,
  comment: 'Component-level inventory of both Windows architectures, the target .NET runtime family, and immutable architecture-specific native-tool inputs. It is not a file-by-file inventory of the self-contained executables.',
  creationInfo: {
    created: `${releaseHeading[1]}T00:00:00Z`,
    creators: ['Tool: Video Radar release tooling'],
  },
  packages: [productPackage, extensionPackage, ...nativeHostPackages, dotnetRuntimePackage, ...toolPackages],
  relationships,
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(sbom, null, 2)}\n`, 'utf8');
console.log(`SPDX SBOM created at ${outputPath}`);
