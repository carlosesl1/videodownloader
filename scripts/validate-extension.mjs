import { access, readdir, readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
const required = [
  manifest.action.default_popup,
  manifest.background.service_worker,
  'offscreen.html',
  'styles/popup.css',
  'src/popup/main.js',
  'src/offscreen/main.js',
];
await Promise.all(required.map((file) => access(resolve(root, file))));

if (manifest.host_permissions?.length) throw new Error('host_permissions must remain empty');

const htmlFiles = ['popup.html', 'offscreen.html'];
const remoteScript = /<script\b[^>]*\bsrc\s*=\s*["']https?:\/\//i;
for (const html of htmlFiles) {
  const source = await readFile(resolve(root, html), 'utf8');
  if (remoteScript.test(source)) throw new Error(`${html} contains a remote script`);
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? walk(path) : path;
  }))).flat();
}

const productionFiles = (await walk(resolve(root, 'src'))).filter((file) => extname(file) === '.js');
const localImport = /(?:from\s*|import\s*)["'](\.{1,2}\/[^"']+)["']/g;
for (const file of productionFiles) {
  const source = await readFile(file, 'utf8');
  for (const match of source.matchAll(localImport)) {
    await access(resolve(dirname(file), match[1]));
  }
}

const popup = await readFile(resolve(root, 'popup.html'), 'utf8');
const moduleEntries = popup.match(/<script\b[^>]*\btype\s*=\s*["']module["'][^>]*>/gi) ?? [];
if (moduleEntries.length !== 1) throw new Error('popup.html must have one module entry point');

const mojibakeMarkers = /(?:Ã[¡-¿]|Â[\u00a0-\u00ff]|â(?:€¦|€™|€œ|€|€“|€”|€¢))/u;
for (const file of ['manifest.json', 'popup.html', 'src/popup/main.js', 'src/popup/render.js']) {
  const source = await readFile(resolve(root, file), 'utf8');
  if (source.includes('\uFFFD') || mojibakeMarkers.test(source)) {
    throw new Error(`${file} contains invalid or mojibake text`);
  }
}

console.log(`Extension preflight passed: ${productionFiles.length} production modules validated`);
