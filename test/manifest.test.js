import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('manifest declares the Video Radar MV3 extension contract', async () => {
  const manifestPath = new URL('../manifest.json', import.meta.url);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.action.default_popup, 'popup.html');
  assert.equal(manifest.background.service_worker, 'src/background/main.js');
  assert.equal(manifest.background.type, 'module');
  assert.ok(!('host_permissions' in manifest) || manifest.host_permissions.length === 0);
  assert.deepEqual(manifest.optional_host_permissions, ['http://*/*', 'https://*/*']);
  assert.deepEqual(
    [...manifest.permissions].sort(),
    ['activeTab', 'downloads', 'offscreen', 'scripting', 'storage'],
  );
});
