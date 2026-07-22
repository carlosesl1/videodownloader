import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('popup keeps a natural 380px browser-action width', async () => {
  const css = await readFile(new URL('../styles/popup.css', import.meta.url), 'utf8');
  const documentRule = css.match(/html,\s*body\s*\{([^}]*)\}/)?.[1] ?? '';

  assert.match(documentRule, /(?:^|;)\s*width:\s*380px\s*;/);
  assert.match(documentRule, /(?:^|;)\s*min-width:\s*380px\s*;/);
  assert.doesNotMatch(documentRule, /max-width:\s*100vw/);
});
