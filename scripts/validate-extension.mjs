import { createHash } from 'node:crypto';
import { access, readdir, readFile } from 'node:fs/promises';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const fromRoot = (...parts) => resolve(root, ...parts);
const manifest = JSON.parse(await readFile(fromRoot('manifest.json'), 'utf8'));

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? walk(path) : path;
  }))).flat();
}

function sameSet(actual, expected, label) {
  const normalizedActual = [...actual].sort();
  const normalizedExpected = [...expected].sort();
  if (normalizedActual.join('\n') !== normalizedExpected.join('\n')) {
    throw new Error(`${label} must contain exactly the approved values`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const required = [
  'manifest.json', 'popup.html', 'offscreen.html', 'styles/popup.css', 'assets/icon-128.png',
  'src/popup/main.js', 'src/offscreen/main.js', 'src/background/main.js',
  'README.md', 'Instalar-Video-Radar.cmd',
  'scripts/dotnet.ps1', 'scripts/fetch-native-tools.ps1', 'scripts/install-native-host.ps1',
  'scripts/package-native-helper.ps1', 'scripts/generate-extension-key.mjs',
  'native-host/tool-lock.json', 'native-host/VideoRadar.NativeHost/VideoRadar.NativeHost.csproj',
  'native-host/VideoRadar.NativeHost/Program.cs',
];
await Promise.all(required.map((file) => access(fromRoot(file))));

sameSet(manifest.permissions ?? [], [
  'activeTab', 'downloads', 'nativeMessaging', 'notifications', 'offscreen', 'scripting', 'storage',
], 'manifest permissions');
assert(!manifest.host_permissions?.length, 'host_permissions must remain absent or empty');
assert(JSON.stringify(manifest.optional_host_permissions) === JSON.stringify(['http://*/*', 'https://*/*']),
  'optional_host_permissions must be the approved HTTP(S) pair');
assert(manifest.icons?.['128'] === 'assets/icon-128.png', 'manifest must point at the 128px icon');
await access(fromRoot(manifest.icons['128']));
assert(typeof manifest.key === 'string' && manifest.key.length > 0, 'manifest.key must be non-empty');

let publicKey;
try {
  publicKey = Buffer.from(manifest.key, 'base64');
} catch {
  throw new Error('manifest.key must be base64');
}
assert(publicKey.length > 0 && Buffer.from(publicKey).toString('base64') === manifest.key, 'manifest.key must be canonical base64');
const extensionId = [...createHash('sha256').update(publicKey).digest().subarray(0, 16)]
  .flatMap((byte) => [(byte >> 4) & 0xf, byte & 0xf])
  .map((nibble) => String.fromCharCode('a'.charCodeAt(0) + nibble))
  .join('');
assert(extensionId === 'cakpfifpfmbdcilimpedanglnopnmckg', 'manifest.key derives an unexpected extension ID');

const packagedId = fromRoot('dist/video-radar-helper/extension-id.txt');
try {
  assert((await readFile(packagedId, 'utf8')).trim() === extensionId, 'packaged extension-id does not match manifest.key');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const htmlFiles = ['popup.html', 'offscreen.html'];
const remoteScript = /<script\b[^>]*\bsrc\s*=\s*["']https?:\/\//i;
for (const html of htmlFiles) {
  const source = await readFile(fromRoot(html), 'utf8');
  if (remoteScript.test(source)) throw new Error(`${html} contains a remote script`);
}

const productionFiles = (await walk(fromRoot('src'))).filter((file) => extname(file) === '.js');
const localImport = /(?:from\s*|import\s*)["'](\.{1,2}\/[^"]+?)["']/g;
for (const file of productionFiles) {
  const source = await readFile(file, 'utf8');
  for (const match of source.matchAll(localImport)) await access(resolve(dirname(file), match[1]));
}

const popup = await readFile(fromRoot('popup.html'), 'utf8');
const moduleEntries = popup.match(/<script\b[^>]*\btype\s*=\s*["']module["'][^>]*>/gi) ?? [];
if (moduleEntries.length !== 1) throw new Error('popup.html must have one module entry point');

const hostFiles = (await walk(fromRoot('native-host/VideoRadar.NativeHost')))
  .filter((file) => extname(file) === '.cs');
const forbiddenTerms = [
  ['http:', '//localhost'].join(''), ['https:', '//localhost'].join(''),
  ['Http', 'Listener'].join(''), ['Tcp', 'Listener'].join(''),
  ['--', 'cookies'].join(''), ['--', 'cookies-from-browser'].join(''),
  ['--', 'username'].join(''), ['--', 'password'].join(''), ['--', 'netrc'].join(''),
  ['--', 'user-data-dir'].join(''), ['--', 'profile-directory'].join(''), ['--', 'profile'].join(''),
];
for (const file of [...productionFiles, ...hostFiles]) {
  const source = await readFile(file, 'utf8');
  for (const term of forbiddenTerms) {
    if (source.includes(term)) throw new Error(`${relative(root, file)} contains prohibited local-server or credential behavior`);
  }
}

const textExtensions = new Set(['.json', '.html', '.js', '.mjs', '.md', '.ps1', '.cmd', '.cs', '.csproj', '.css']);
const textFiles = [
  ...['manifest.json', 'popup.html', 'offscreen.html', 'README.md', 'Instalar-Video-Radar.cmd'].map((file) => fromRoot(file)),
  ...(await Promise.all(['src', 'scripts', 'native-host/VideoRadar.NativeHost'].map(async (directory) =>
    (await walk(fromRoot(directory))).filter((file) => textExtensions.has(extname(file)))))).flat(),
];
const mojibakeMarkers = /(?:Ãƒ[Â¡-Â¿]|Ã‚[\u00a0-\u00ff]|Ã¢(?:â‚¬Â¦|â‚¬â„¢|â‚¬Å“|â‚¬Â|â‚¬â€œ|â‚¬â€|â‚¬Â¢))/u;
for (const file of textFiles) {
  const source = await readFile(file, 'utf8');
  if (source.includes('\uFFFD') || mojibakeMarkers.test(source)) {
    throw new Error(`${relative(root, file)} contains invalid or mojibake text`);
  }
}

const lock = JSON.parse(await readFile(fromRoot('native-host/tool-lock.json'), 'utf8'));
assert(lock.schemaVersion === 1 && Array.isArray(lock.sources) && lock.sources.length === 3,
  'tool lock must use schema 1 with exactly three sources');
const expectedSources = {
  deno: { repository: 'denoland/deno', outputs: ['deno.exe'], license: 'deno-LICENSE.md' },
  ffmpeg: { repository: 'yt-dlp/FFmpeg-Builds', outputs: ['ffmpeg.exe', 'ffprobe.exe'], license: 'ffmpeg-builds-LICENSE.txt' },
  'yt-dlp': { repository: 'yt-dlp/yt-dlp', outputs: ['yt-dlp.exe'], license: 'yt-dlp-LICENSE.txt' },
};
sameSet(lock.sources.map((source) => source.name), Object.keys(expectedSources), 'tool lock sources');
const assetBase = ['https:', '', 'api.github.com', 'repos'].join('/');
const rawBase = ['https:', '', 'raw.githubusercontent.com'].join('/');
const forbiddenUrlFragments = [['lat', 'est'].join(''), ['down', 'load'].join(''), ['mir', 'ror'].join('')];
for (const source of lock.sources) {
  const expected = expectedSources[source.name];
  assert(source.repository === expected.repository, `unexpected repository for ${source.name}`);
  assert(typeof source.version === 'string' && source.version.length > 0, `missing version for ${source.name}`);
  assert(Number.isSafeInteger(source.assetId) && source.assetId > 0, `invalid asset ID for ${source.name}`);
  assert(Number.isSafeInteger(source.checksum?.assetId) && source.checksum.assetId > 0, `invalid checksum asset ID for ${source.name}`);
  assert(Number.isSafeInteger(source.size) && source.size > 0, `invalid asset size for ${source.name}`);
  for (const digest of [source.sha256, source.checksum?.sha256, source.license?.sha256]) {
    assert(typeof digest === 'string' && /^[0-9a-f]{64}$/.test(digest), `invalid lowercase SHA-256 for ${source.name}`);
  }
  const assetPattern = new RegExp(`^${assetBase}/${source.repository.replace('/', '\\/')}\\/releases\\/assets\\/(\\d+)$`);
  for (const [label, url, id] of [['asset', source.url, source.assetId], ['checksum', source.checksum?.url, source.checksum?.assetId]]) {
    const match = typeof url === 'string' && url.match(assetPattern);
    assert(match && Number(match[1]) === id, `invalid immutable ${label} URL for ${source.name}`);
  }
  assert(typeof source.license?.url === 'string' && source.license.url.startsWith(`${rawBase}/${source.repository}/`) &&
    new RegExp(`^${rawBase}/${source.repository.replace('/', '\\/')}\\/[0-9a-f]{40}/`).test(source.license.url),
  `license URL must use a commit for ${source.name}`);
  for (const url of [source.url, source.checksum.url, source.license.url]) {
    assert(!forbiddenUrlFragments.some((fragment) => url.toLowerCase().includes(fragment)), `mutable or mirror URL for ${source.name}`);
  }
  sameSet(source.outputs ?? [], expected.outputs, `outputs for ${source.name}`);
  assert(source.license?.fileName === expected.license, `unexpected license for ${source.name}`);
  assert(Array.isArray(source.archiveLicenses), `archive licenses missing for ${source.name}`);
}
const licenseNames = lock.sources.flatMap((source) => [source.license.fileName, ...(source.archiveLicenses ?? []).map((license) => license.fileName)]);
sameSet(licenseNames, ['deno-LICENSE.md', 'ffmpeg-builds-LICENSE.txt', 'ffmpeg-GPL-LICENSE.txt', 'yt-dlp-LICENSE.txt'], 'tool licenses');

const csproj = await readFile(fromRoot('native-host/VideoRadar.NativeHost/VideoRadar.NativeHost.csproj'), 'utf8');
for (const property of ['<TargetFramework>net10.0</TargetFramework>', '<SelfContained>true</SelfContained>', '<PublishSingleFile>true</PublishSingleFile>']) {
  assert(csproj.includes(property), `native host project is missing ${property}`);
}

const packageJson = JSON.parse(await readFile(fromRoot('package.json'), 'utf8'));
for (const script of ['test', 'check']) {
  assert(typeof packageJson.scripts?.[script] === 'string', `package script ${script} is missing`);
  assert(!/(?:fetch|package-native|lock-native|youtube|https?:\/\/)/i.test(packageJson.scripts[script]), `${script} must stay offline`);
}
assert(typeof packageJson.scripts?.['test:native'] === 'string' && /scripts\/dotnet\.ps1 run --project native-host\/VideoRadar\.NativeHost\.Tests/.test(packageJson.scripts['test:native']),
  'test:native must run through the dotnet wrapper');
assert(typeof packageJson.scripts?.['check:all'] === 'string' && /npm run check\s*&&\s*npm run test:native/.test(packageJson.scripts['check:all']),
  'check:all must serially run check and test:native');
assert(!/(?:fetch|package-native|lock-native|youtube|https?:\/\/)/i.test(packageJson.scripts['check:all']), 'check:all must stay offline');

console.log(`Extension preflight passed: ${productionFiles.length} production modules validated`);
