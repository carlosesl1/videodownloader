import { access, readFile } from 'node:fs/promises';

const manifestPath = new URL('../manifest.json', import.meta.url);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const required = [
  manifest.action.default_popup,
  manifest.background.service_worker,
  'offscreen.html',
  'styles/popup.css',
  'src/popup/main.js',
  'src/offscreen/main.js',
];

await Promise.all(required.map((file) => access(new URL(`../${file}`, import.meta.url))));

if (manifest.host_permissions?.length) {
  throw new Error('host_permissions must be empty.');
}

console.log(`Extension preflight passed: ${required.length} referenced files found`);
