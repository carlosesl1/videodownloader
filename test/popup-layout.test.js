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

test('popup media content contains long names and paths without a viewport overflow escape hatch', async () => {
  const css = await readFile(new URL('../styles/popup.css', import.meta.url), 'utf8');
  const withoutDocumentWidth = css.replace(/html,\s*body\s*\{[^}]*\}/s, '');

  assert.match(css, /\.media-row\s*\{[^}]*minmax\(0,\s*1fr\)/s);
  assert.match(css, /\.media-row__(?:path|stage)\s*\{[^}]*grid-column:\s*1\s*\/\s*-1[^}]*min-width:\s*0[^}]*(?:overflow-wrap:\s*anywhere|text-overflow:\s*ellipsis)/s);
  assert.doesNotMatch(withoutDocumentWidth, /(?:width|min-width|max-width):\s*(?:3[89]\d|[4-9]\d\d|\d{4,})px/);
  assert.doesNotMatch(css, /100vw/);
});

test('popup preserves keyboard focus and disables indeterminate motion for reduced motion', async () => {
  const css = await readFile(new URL('../styles/popup.css', import.meta.url), 'utf8');

  assert.match(css, /button:focus-visible,\s*select:focus-visible/);
  assert.match(css, /\.media-row__progress(?::indeterminate|:not\(\[value\]\))/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.media-row__progress[\s\S]*?animation:\s*none\s*!important/s);
});
