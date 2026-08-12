import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeDiscoveryView } from '../src/detection/discovery-protocol.js';

test('measures discovery persistence limits in UTF-8 bytes', () => {
  const oversizedUnicodeView = {
    selections: [],
    inspections: Array.from({ length: 80 }, (_, inspectionIndex) => ({
      id: `inspection-${inspectionIndex}`,
      variants: Array.from({ length: 8 }, (_, variantIndex) => ({
        url: `https://cdn.test/${inspectionIndex}/${variantIndex}.m3u8`,
        label: '1080p',
        width: 1920,
        height: 1080,
        bandwidth: 4_000_000,
        codecs: '漢'.repeat(1_000),
      })),
      allowedOrigins: ['https://cdn.test'],
    })),
  };

  assert.ok(JSON.stringify(oversizedUnicodeView).length < 1024 * 1024);
  assert.throws(
    () => sanitizeDiscoveryView(oversizedUnicodeView),
    /Visualização de descoberta inválida/,
  );
});

test('persiste a legenda escolhida sem quebrar snapshots antigos', () => {
  assert.deepEqual(sanitizeDiscoveryView({
    selections: [{ id: 'youtube:video', selectedIndex: 0, subtitleIndex: -1 }],
    inspections: [],
  }).selections[0], {
    id: 'youtube:video', selectedIndex: 0, subtitleIndex: -1,
  });
  assert.deepEqual(sanitizeDiscoveryView({
    selections: [{ id: 'legacy', selectedIndex: 1 }], inspections: [],
  }).selections[0], { id: 'legacy', selectedIndex: 1 });
  assert.throws(() => sanitizeDiscoveryView({
    selections: [{ id: 'youtube:video', selectedIndex: 0, subtitleIndex: 128 }],
    inspections: [],
  }), /Visualização de descoberta inválida/);
});
