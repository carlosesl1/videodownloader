import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublicKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';

test('manifest declares the Video Radar MV3 extension contract', async () => {
  const manifestPath = new URL('../manifest.json', import.meta.url);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.action.default_popup, 'popup.html');
  assert.equal(manifest.background.service_worker, 'src/background/main.js');
  assert.equal(manifest.background.type, 'module');
  assert.deepEqual(manifest.options_ui, { page: 'options.html', open_in_tab: true });
  assert.ok(!('host_permissions' in manifest) || manifest.host_permissions.length === 0);
  assert.deepEqual(manifest.optional_host_permissions, ['http://*/*', 'https://*/*']);
  assert.deepEqual(
    [...manifest.permissions].sort(),
    ['activeTab', 'downloads', 'nativeMessaging', 'notifications', 'offscreen', 'scripting', 'storage'],
  );

  assert.deepEqual(manifest.icons, { 128: 'assets/icon-128.png' });
  const icon = await readFile(new URL('../assets/icon-128.png', import.meta.url));
  assert.deepEqual([...icon.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(icon.readUInt32BE(16), 128);
  assert.equal(icon.readUInt32BE(20), 128);

  assert.match(manifest.key, /^[A-Za-z0-9+/]+={0,2}$/);
  const publicKey = createPublicKey({
    key: Buffer.from(manifest.key, 'base64'),
    format: 'der',
    type: 'spki',
  });
  assert.equal(publicKey.asymmetricKeyType, 'rsa');
  assert.equal(publicKey.asymmetricKeyDetails.modulusLength, 2048);
});
