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
  assert.equal(manifest.incognito, 'not_allowed');
  assert.equal(
    manifest.content_security_policy.extension_pages,
    "script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none';",
  );
  assert.deepEqual(
    [...manifest.permissions].sort(),
    ['activeTab', 'alarms', 'downloads', 'nativeMessaging', 'notifications', 'offscreen', 'scripting', 'storage'],
  );

  const icons = {
    16: 'assets/icon-16.png',
    32: 'assets/icon-32.png',
    48: 'assets/icon-48.png',
    128: 'assets/icon-128.png',
  };
  assert.deepEqual(manifest.icons, icons);
  assert.deepEqual(manifest.action.default_icon, icons);
  for (const [size, relativePath] of Object.entries(icons)) {
    const icon = await readFile(new URL(`../${relativePath}`, import.meta.url));
    assert.deepEqual([...icon.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(icon.readUInt32BE(16), Number(size));
    assert.equal(icon.readUInt32BE(20), Number(size));
  }

  assert.match(manifest.key, /^[A-Za-z0-9+/]+={0,2}$/);
  const publicKey = createPublicKey({
    key: Buffer.from(manifest.key, 'base64'),
    format: 'der',
    type: 'spki',
  });
  assert.equal(publicKey.asymmetricKeyType, 'rsa');
  assert.equal(publicKey.asymmetricKeyDetails.modulusLength, 2048);
});
