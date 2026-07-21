# Vídeo Radar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir uma extensão Chromium Manifest V3 que detecta vídeos diretos e HLS sob demanda, permite escolher a qualidade disponível e entrega arquivos diretos ou HLS MPEG-TS ao gerenciador de downloads do navegador.

**Architecture:** O popup injeta uma função autocontida na aba ativa, normaliza os candidatos e apresenta os resultados. Um service worker valida comandos e coordena downloads; HLS é analisado e montado em um documento offscreen para sobreviver ao fechamento do popup. Toda lógica de parsing, nomes, estado e validação fica em módulos puros testáveis com `node:test`.

**Tech Stack:** Chrome Extensions Manifest V3, JavaScript ES modules, HTML/CSS, `chrome.scripting`, `chrome.downloads`, `chrome.offscreen`, `chrome.permissions`, `chrome.storage.session`, Node.js test runner.

---

## File map

- `manifest.json` — permissões mínimas, popup e service worker.
- `package.json` — comandos de teste e validação, sem dependências de produção.
- `popup.html` — shell acessível do popup.
- `offscreen.html` — shell mínimo do processador HLS.
- `styles/popup.css` — tokens e estados visuais do popup.
- `src/detection/scan-page.js` — função autocontida executada na página.
- `src/detection/media-candidates.js` — classificação, normalização, deduplicação e agrupamento.
- `src/hls/parse-playlist.js` — parser e erros HLS suportados.
- `src/hls/hls-operation.js` — inspeção de variantes e montagem ordenada dos segmentos.
- `src/shared/filename.js` — nomes seguros e extensões finais.
- `src/shared/messages.js` — contratos e validação de mensagens.
- `src/popup/state.js` — máquina de estados pura do popup.
- `src/popup/render.js` — DOM do popup e acessibilidade.
- `src/popup/main.js` — integração com abas, permissões e worker.
- `src/background/handlers.js` — handlers testáveis do service worker.
- `src/background/main.js` — registro de eventos Chrome.
- `src/offscreen/main.js` — bridge entre mensagens e operações HLS.
- `scripts/validate-extension.mjs` — preflight do pacote descompactado.
- `scripts/serve-fixtures.mjs` — servidor HTTP local para QA manual.
- `test/**/*.test.js` — testes unitários e de integração com fakes explícitos.
- `test/fixtures/` — páginas, playlists e segmentos pequenos e determinísticos.

### Task 1: Scaffold Manifest V3 and validation harness

**Files:**
- Create: `package.json`
- Create: `manifest.json`
- Create: `popup.html`
- Create: `offscreen.html`
- Create: `scripts/validate-extension.mjs`
- Create: `test/manifest.test.js`

- [ ] **Step 1: Write the failing manifest test**

```js
// test/manifest.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("manifest uses optional host access and required MV3 surfaces", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.action.default_popup, "popup.html");
  assert.equal(manifest.background.service_worker, "src/background/main.js");
  assert.equal(manifest.background.type, "module");
  assert.deepEqual(manifest.host_permissions ?? [], []);
  assert.deepEqual(manifest.optional_host_permissions, ["http://*/*", "https://*/*"]);
  assert.deepEqual(
    [...manifest.permissions].sort(),
    ["activeTab", "downloads", "offscreen", "scripting", "storage"].sort(),
  );
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test test/manifest.test.js`

Expected: FAIL with `ENOENT` for `manifest.json`.

- [ ] **Step 3: Add the package, manifest and extension shells**

```json
// package.json
{
  "name": "video-radar-extension",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test",
    "check": "node scripts/validate-extension.mjs && node --test"
  }
}
```

```json
// manifest.json
{
  "manifest_version": 3,
  "name": "Vídeo Radar",
  "description": "Encontre e baixe vídeos diretos ou HLS disponíveis na página atual.",
  "version": "1.0.0",
  "permissions": ["activeTab", "downloads", "offscreen", "scripting", "storage"],
  "optional_host_permissions": ["http://*/*", "https://*/*"],
  "action": { "default_popup": "popup.html", "default_title": "Vídeo Radar" },
  "background": { "service_worker": "src/background/main.js", "type": "module" },
  "minimum_chrome_version": "116"
}
```

```html
<!-- popup.html -->
<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Vídeo Radar</title>
    <link rel="stylesheet" href="styles/popup.css">
  </head>
  <body>
    <main id="app" aria-busy="false"></main>
    <div id="announcer" class="sr-only" aria-live="polite"></div>
    <script type="module" src="src/popup/main.js"></script>
  </body>
</html>
```

```html
<!-- offscreen.html -->
<!doctype html>
<html lang="pt-BR">
  <head><meta charset="utf-8"><title>Processador HLS</title></head>
  <body><script type="module" src="src/offscreen/main.js"></script></body>
</html>
```

```js
// scripts/validate-extension.mjs
import { access, readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
const required = [
  manifest.action.default_popup,
  manifest.background.service_worker,
  "offscreen.html",
  "styles/popup.css",
  "src/popup/main.js",
  "src/offscreen/main.js",
];
await Promise.all(required.map((file) => access(new URL(file, root))));
if (manifest.host_permissions?.length) throw new Error("host_permissions must remain empty");
console.log(`Extension preflight passed: ${required.length} referenced files found`);
```

Create the referenced JS/CSS files only in their owning tasks; until then `npm run check` is expected to fail while the focused manifest test passes.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --test test/manifest.test.js`

Expected: PASS, `1` test and `0` failures.

- [ ] **Step 5: Commit the scaffold**

```powershell
git add package.json manifest.json popup.html offscreen.html scripts/validate-extension.mjs test/manifest.test.js
git commit -m "chore: scaffold video radar extension"
```

### Task 2: Add filename and message contracts

**Files:**
- Create: `src/shared/filename.js`
- Create: `src/shared/messages.js`
- Create: `test/filename.test.js`
- Create: `test/messages.test.js`

- [ ] **Step 1: Write failing tests for safe filenames and message validation**

```js
// test/filename.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { buildDownloadFilename, sanitizeFilename } from "../src/shared/filename.js";

test("sanitizes Windows reserved characters and names", () => {
  assert.equal(sanitizeFilename('  aula: 04 / revisão?  '), "aula 04 revisão");
  assert.equal(sanitizeFilename("CON"), "video-CON");
});

test("preserves direct extension and forces ts for HLS", () => {
  assert.equal(buildDownloadFilename({ url: "https://cdn.test/aula.mp4?token=x", kind: "direct" }), "aula.mp4");
  assert.equal(buildDownloadFilename({ url: "https://cdn.test/master.m3u8", kind: "hls", pageTitle: "Minha aula" }), "master.ts");
});
```

```js
// test/messages.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { ACTIONS, assertBackgroundMessage } from "../src/shared/messages.js";

test("accepts a complete direct-download command", () => {
  assert.deepEqual(assertBackgroundMessage({
    target: "background",
    action: ACTIONS.DOWNLOAD_DIRECT,
    payload: { url: "https://cdn.test/video.mp4", filename: "video.mp4" },
  }).payload, { url: "https://cdn.test/video.mp4", filename: "video.mp4" });
});

test("rejects unknown commands and non-http URLs", () => {
  assert.throws(() => assertBackgroundMessage({ target: "background", action: "ERASE_ALL", payload: {} }), /Mensagem inválida/);
  assert.throws(() => assertBackgroundMessage({ target: "background", action: ACTIONS.DOWNLOAD_DIRECT, payload: { url: "file:///secret", filename: "x.mp4" } }), /URL inválida/);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test test/filename.test.js test/messages.test.js`

Expected: FAIL because both shared modules are missing.

- [ ] **Step 3: Implement the pure contracts**

```js
// src/shared/filename.js
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const DIRECT_EXTENSIONS = new Set(["mp4", "webm", "mov"]);

export function sanitizeFilename(value) {
  const clean = String(value ?? "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  const fallback = clean || "video";
  return RESERVED.test(fallback) ? `video-${fallback}` : fallback;
}

export function buildDownloadFilename({ url, kind, pageTitle = "" }) {
  const parsed = new URL(url);
  const leaf = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).at(-1) ?? "");
  const base = sanitizeFilename(leaf.replace(/\.[^.]+$/, "") || pageTitle || `video-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  if (kind === "hls") return `${base}.ts`;
  const ext = leaf.split(".").at(-1)?.toLowerCase();
  return `${base}.${DIRECT_EXTENSIONS.has(ext) ? ext : "mp4"}`;
}
```

```js
// src/shared/messages.js
export const ACTIONS = Object.freeze({
  DOWNLOAD_DIRECT: "DOWNLOAD_DIRECT",
  INSPECT_HLS: "INSPECT_HLS",
  DOWNLOAD_HLS: "DOWNLOAD_HLS",
  RELEASE_BLOB: "RELEASE_BLOB",
});

const backgroundActions = new Set([ACTIONS.DOWNLOAD_DIRECT, ACTIONS.INSPECT_HLS, ACTIONS.DOWNLOAD_HLS]);
const offscreenActions = new Set([ACTIONS.INSPECT_HLS, ACTIONS.DOWNLOAD_HLS, ACTIONS.RELEASE_BLOB]);
const httpUrl = (value) => {
  const parsed = new URL(value);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("URL inválida");
  return parsed.href;
};

export function assertBackgroundMessage(message) {
  if (!message || message.target !== "background" || !backgroundActions.has(message.action)) throw new Error("Mensagem inválida");
  if (message.action === ACTIONS.DOWNLOAD_DIRECT) {
    httpUrl(message.payload?.url);
    if (!message.payload?.filename) throw new Error("Mensagem inválida");
  }
  if (message.action === ACTIONS.INSPECT_HLS) {
    httpUrl(message.payload?.url);
    if (!Array.isArray(message.payload?.permissionPatterns)) throw new Error("Mensagem inválida");
  }
  if (message.action === ACTIONS.DOWNLOAD_HLS) {
    httpUrl(message.payload?.url);
    if (!message.payload?.filename || !Array.isArray(message.payload?.allowedOrigins) || !Array.isArray(message.payload?.permissionPatterns)) throw new Error("Mensagem inválida");
  }
  return message;
}

export function assertOffscreenMessage(message) {
  if (!message || message.target !== "offscreen" || !offscreenActions.has(message.action)) throw new Error("Mensagem inválida");
  if ([ACTIONS.INSPECT_HLS, ACTIONS.DOWNLOAD_HLS].includes(message.action)) httpUrl(message.payload?.url);
  if (message.action === ACTIONS.RELEASE_BLOB && !String(message.payload?.blobUrl ?? "").startsWith("blob:")) throw new Error("Mensagem inválida");
  return message;
}
```

- [ ] **Step 4: Run tests and verify GREEN**

Run: `node --test test/filename.test.js test/messages.test.js`

Expected: PASS, `4` tests and `0` failures.

- [ ] **Step 5: Commit shared contracts**

```powershell
git add src/shared test/filename.test.js test/messages.test.js
git commit -m "feat: add safe download contracts"
```

### Task 3: Implement on-demand hybrid detection

**Files:**
- Create: `src/detection/scan-page.js`
- Create: `src/detection/media-candidates.js`
- Create: `test/scan-page.test.js`
- Create: `test/media-candidates.test.js`

- [ ] **Step 1: Write failing tests for DOM, performance and deduplication**

```js
// test/scan-page.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { scanPage } from "../src/detection/scan-page.js";

test("collects video sources and performance HLS resources", () => {
  const video = {
    currentSrc: "https://site.test/video-720.mp4?sig=1#time",
    src: "",
    videoWidth: 1280,
    videoHeight: 720,
    getAttribute: () => "Aula",
    querySelectorAll: () => [{ src: "https://site.test/video-1080.mp4", type: "video/mp4" }],
  };
  globalThis.document = { title: "Curso", querySelectorAll: () => [video] };
  globalThis.location = { href: "https://site.test/aula" };
  globalThis.performance = { getEntriesByType: () => [{ name: "https://cdn.test/master.m3u8?token=x" }] };
  const result = scanPage();
  assert.equal(result.pageTitle, "Curso");
  assert.equal(result.candidates.length, 3);
  assert.equal(result.candidates[0].height, 720);
  assert.equal(result.candidates[2].kind, "hls");
});
```

```js
// test/media-candidates.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCandidates } from "../src/detection/media-candidates.js";

test("deduplicates fragments while preserving signed queries", () => {
  const result = normalizeCandidates([
    { url: "https://cdn.test/v.mp4?sig=1#t=2", source: "dom" },
    { url: "https://cdn.test/v.mp4?sig=1", source: "performance" },
    { url: "https://cdn.test/v.mp4?sig=2", source: "performance" },
  ]);
  assert.deepEqual(result.map((item) => item.url), ["https://cdn.test/v.mp4?sig=1", "https://cdn.test/v.mp4?sig=2"]);
});

test("filters blob and unsupported resources", () => {
  assert.deepEqual(normalizeCandidates([{ url: "blob:https://site.test/x" }, { url: "https://site.test/image.jpg" }]), []);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test test/scan-page.test.js test/media-candidates.test.js`

Expected: FAIL because the detection modules are missing.

- [ ] **Step 3: Implement the autocontained page scan and normalizer**

```js
// src/detection/scan-page.js
export function scanPage() {
  const classify = (url, mime = "") => {
    const path = (() => { try { return new URL(url, location.href).pathname.toLowerCase(); } catch { return ""; } })();
    if (path.endsWith(".m3u8") || /mpegurl/i.test(mime)) return "hls";
    if (/\.(mp4|webm|mov)$/i.test(path) || /^video\/(mp4|webm|quicktime)$/i.test(mime)) return "direct";
    return null;
  };
  const candidates = [];
  document.querySelectorAll("video").forEach((video, index) => {
    const add = (url, mime = "", isCurrent = false) => {
      const kind = classify(url, mime);
      if (url && kind) candidates.push({ url: new URL(url, location.href).href, kind, mimeType: mime, width: isCurrent ? video.videoWidth || null : null, height: isCurrent ? video.videoHeight || null : null, label: video.getAttribute("aria-label") || video.getAttribute("title") || "", groupKey: `video-${index}`, source: "dom" });
    };
    const current = video.currentSrc || video.src;
    add(current, video.getAttribute("type") || "", true);
    video.querySelectorAll("source").forEach((source) => add(source.src, source.type, new URL(source.src, location.href).href === new URL(current, location.href).href));
  });
  performance.getEntriesByType("resource").forEach((entry) => {
    const kind = classify(entry.name);
    if (kind) candidates.push({ url: entry.name, kind, mimeType: "", width: null, height: null, label: "", groupKey: null, source: "performance" });
  });
  return { pageTitle: document.title, candidates };
}
```

```js
// src/detection/media-candidates.js
const classifyPath = (pathname) => pathname.endsWith(".m3u8") ? "hls" : /\.(mp4|webm|mov)$/i.test(pathname) ? "direct" : null;

export function normalizeCandidates(candidates) {
  const byUrl = new Map();
  for (const raw of candidates) {
    let parsed;
    try { parsed = new URL(raw.url); } catch { continue; }
    if (!/^https?:$/.test(parsed.protocol)) continue;
    parsed.hash = "";
    const kind = raw.kind ?? classifyPath(parsed.pathname.toLowerCase());
    if (!kind) continue;
    const key = parsed.href;
    const previous = byUrl.get(key);
    byUrl.set(key, previous ? { ...previous, ...raw, url: key, kind, source: previous.source === "dom" ? "dom" : raw.source } : { ...raw, url: key, kind });
  }
  return [...byUrl.values()];
}

export function groupDirectVariants(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.kind === "direct" && item.groupKey ? item.groupKey : item.url;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.entries()].map(([id, variants]) => {
    const ordered = [...variants].sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.width ?? 0) - (a.width ?? 0));
    return { id, kind: ordered[0].kind, variants: ordered };
  });
}
```

- [ ] **Step 4: Run tests and verify GREEN**

Run: `node --test test/scan-page.test.js test/media-candidates.test.js`

Expected: PASS, `3` tests and `0` failures.

- [ ] **Step 5: Commit detection**

```powershell
git add src/detection test/scan-page.test.js test/media-candidates.test.js
git commit -m "feat: detect page video candidates on demand"
```

### Task 4: Parse supported HLS playlists and quality variants

**Files:**
- Create: `src/hls/parse-playlist.js`
- Create: `test/hls-parser.test.js`
- Create: `test/fixtures/hls/master.m3u8`
- Create: `test/fixtures/hls/1080p.m3u8`
- Create: `test/fixtures/hls/rejected-fmp4.m3u8`

- [ ] **Step 1: Write failing parser tests**

```js
// test/hls-parser.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { parseHlsPlaylist } from "../src/hls/parse-playlist.js";

test("parses and sorts master variants by quality", () => {
  const text = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1800000,RESOLUTION=1280x720,CODECS="avc1"\n720p/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=5200000,RESOLUTION=1920x1080,CODECS="avc1"\n1080p/index.m3u8`;
  const parsed = parseHlsPlaylist(text, "https://cdn.test/master.m3u8");
  assert.equal(parsed.kind, "master");
  assert.deepEqual(parsed.variants.map((v) => v.label), ["1080p", "720p"]);
  assert.equal(parsed.variants[0].url, "https://cdn.test/1080p/index.m3u8");
});

test("parses a finite MPEG-TS media playlist", () => {
  const text = `#EXTM3U\n#EXTINF:4.0,\nseg-1.ts\n#EXTINF:3.5,\nseg-2.ts\n#EXT-X-ENDLIST`;
  const parsed = parseHlsPlaylist(text, "https://cdn.test/720/index.m3u8");
  assert.equal(parsed.kind, "media");
  assert.deepEqual(parsed.segments.map((s) => s.url), ["https://cdn.test/720/seg-1.ts", "https://cdn.test/720/seg-2.ts"]);
});

for (const [name, line, code] of [
  ["encrypted", "#EXT-X-KEY:METHOD=AES-128,URI=\"key\"", "HLS_ENCRYPTED"],
  ["fMP4", "#EXT-X-MAP:URI=\"init.mp4\"", "HLS_FMP4"],
  ["byte range", "#EXT-X-BYTERANGE:100@0", "HLS_BYTERANGE"],
]) test(`rejects ${name} HLS`, () => {
  assert.throws(() => parseHlsPlaylist(`#EXTM3U\n${line}\n#EXTINF:1,\na.ts\n#EXT-X-ENDLIST`, "https://cdn.test/x.m3u8"), (error) => error.code === code);
});
```

- [ ] **Step 2: Run the parser tests and verify RED**

Run: `node --test test/hls-parser.test.js`

Expected: FAIL because `parse-playlist.js` is missing.

- [ ] **Step 3: Implement the parser with explicit error codes**

```js
// src/hls/parse-playlist.js
export class HlsError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = "HlsError"; this.code = code; this.details = details; }
}

const attributes = (line) => Object.fromEntries([...line.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)].map(([, key, value]) => [key, value.replace(/^"|"$/g, "")]));
const absolute = (value, base) => new URL(value, base).href;

export function parseHlsPlaylist(text, playlistUrl) {
  const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines[0] !== "#EXTM3U") throw new HlsError("HLS_INVALID", "A resposta não é uma playlist HLS válida.");
  if (lines.some((line) => line.startsWith("#EXT-X-KEY") && !/METHOD=NONE(?:,|$)/.test(line))) throw new HlsError("HLS_ENCRYPTED", "Esta playlist usa criptografia não suportada.");
  if (lines.some((line) => line.startsWith("#EXT-X-MAP"))) throw new HlsError("HLS_FMP4", "Esta playlist usa segmentos fMP4 não suportados.");
  if (lines.some((line) => line.startsWith("#EXT-X-BYTERANGE"))) throw new HlsError("HLS_BYTERANGE", "Esta playlist usa intervalos de bytes não suportados.");

  const variants = [];
  const segments = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].startsWith("#EXT-X-STREAM-INF:")) {
      const meta = attributes(lines[index]);
      const [width, height] = (meta.RESOLUTION ?? "0x0").split("x").map(Number);
      const next = lines.slice(index + 1).find((line) => !line.startsWith("#"));
      if (next) variants.push({ url: absolute(next, playlistUrl), width, height, bandwidth: Number(meta.BANDWIDTH ?? 0), codecs: meta.CODECS ?? "", label: height ? `${height}p` : "Qualidade desconhecida" });
    }
    if (lines[index].startsWith("#EXTINF:")) {
      const next = lines.slice(index + 1).find((line) => !line.startsWith("#"));
      if (next) segments.push({ url: absolute(next, playlistUrl), duration: Number(lines[index].slice(8).split(",")[0]) || 0 });
    }
  }
  if (variants.length) {
    variants.sort((a, b) => b.height - a.height || b.width - a.width || b.bandwidth - a.bandwidth);
    return { kind: "master", variants };
  }
  if (!lines.includes("#EXT-X-ENDLIST")) throw new HlsError("HLS_LIVE", "Playlists ao vivo não são suportadas nesta versão.");
  if (!segments.length) throw new HlsError("HLS_EMPTY", "A playlist não contém segmentos de vídeo.");
  return { kind: "media", segments };
}
```

```m3u8
# test/fixtures/hls/master.m3u8
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=5200000,RESOLUTION=1920x1080
1080p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720
720p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=854x480
480p.m3u8
```

```m3u8
# test/fixtures/hls/1080p.m3u8
#EXTM3U
#EXTINF:1.0,
seg-1.ts
#EXTINF:1.0,
seg-2.ts
#EXT-X-ENDLIST
```

```m3u8
# test/fixtures/hls/rejected-fmp4.m3u8
#EXTM3U
#EXT-X-MAP:URI="init.mp4"
#EXTINF:1.0,
chunk.m4s
#EXT-X-ENDLIST
```

- [ ] **Step 4: Run the parser tests and verify GREEN**

Run: `node --test test/hls-parser.test.js`

Expected: PASS, `5` tests and `0` failures.

- [ ] **Step 5: Commit HLS parsing**

```powershell
git add src/hls/parse-playlist.js test/hls-parser.test.js test/fixtures/hls
git commit -m "feat: parse supported HLS playlists"
```

### Task 5: Inspect and assemble HLS safely

**Files:**
- Create: `src/hls/hls-operation.js`
- Create: `test/hls-operation.test.js`

- [ ] **Step 1: Write failing tests for inspection, order, permissions and size**

```js
// test/hls-operation.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { assembleHls, inspectHls } from "../src/hls/hls-operation.js";

const response = (body) => ({ ok: true, text: async () => body, arrayBuffer: async () => new TextEncoder().encode(body).buffer });

test("inspects master variants without downloading segments", async () => {
  const fetchImpl = async () => response(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=10,RESOLUTION=1280x720\n720.m3u8`);
  const result = await inspectHls("https://cdn.test/master.m3u8", { fetchImpl });
  assert.deepEqual(result.variants.map((v) => v.label), ["720p"]);
});

test("assembles segments in playlist order despite out-of-order completion", async () => {
  const bodies = new Map([
    ["https://cdn.test/v.m3u8", `#EXTM3U\n#EXTINF:1,\n1.ts\n#EXTINF:1,\n2.ts\n#EXT-X-ENDLIST`],
    ["https://cdn.test/1.ts", "ONE"], ["https://cdn.test/2.ts", "TWO"],
  ]);
  const fetchImpl = async (url) => { if (url.endsWith("1.ts")) await new Promise((resolve) => setTimeout(resolve, 10)); return response(bodies.get(url)); };
  const result = await assembleHls("https://cdn.test/v.m3u8", { fetchImpl, allowedOrigins: ["https://cdn.test"], maxBytes: 100 });
  assert.equal(await result.blob.text(), "ONETWO");
});

test("returns missing segment origins before fetching them", async () => {
  const fetchImpl = async () => response(`#EXTM3U\n#EXTINF:1,\nhttps://media.test/1.ts\n#EXT-X-ENDLIST`);
  await assert.rejects(() => assembleHls("https://cdn.test/v.m3u8", { fetchImpl, allowedOrigins: ["https://cdn.test"] }), (error) => error.code === "HLS_PERMISSION" && error.details.origins[0] === "https://media.test");
});

test("aborts before accumulated bytes exceed the cap", async () => {
  const fetchImpl = async (url) => response(url.endsWith("m3u8") ? `#EXTM3U\n#EXTINF:1,\n1.ts\n#EXT-X-ENDLIST` : "12345");
  await assert.rejects(() => assembleHls("https://cdn.test/v.m3u8", { fetchImpl, allowedOrigins: ["https://cdn.test"], maxBytes: 4 }), (error) => error.code === "HLS_TOO_LARGE");
});
```

- [ ] **Step 2: Run operation tests and verify RED**

Run: `node --test test/hls-operation.test.js`

Expected: FAIL because `hls-operation.js` is missing.

- [ ] **Step 3: Implement bounded concurrent assembly**

```js
// src/hls/hls-operation.js
import { HlsError, parseHlsPlaylist } from "./parse-playlist.js";

const fetchOk = async (url, fetchImpl) => {
  const response = await fetchImpl(url, { credentials: "include" });
  if (!response.ok) throw new HlsError("HLS_NETWORK", `Falha ao buscar mídia: HTTP ${response.status ?? "?"}.`);
  return response;
};

export async function inspectHls(url, { fetchImpl = fetch } = {}) {
  const parsed = parseHlsPlaylist(await (await fetchOk(url, fetchImpl)).text(), url);
  return parsed.kind === "master" ? parsed : { kind: "media", variants: [{ url, width: 0, height: 0, bandwidth: 0, codecs: "", label: "Qualidade única" }] };
}

export async function assembleHls(url, { fetchImpl = fetch, allowedOrigins = [], maxBytes = 1024 ** 3, concurrency = 4 } = {}) {
  const parsed = parseHlsPlaylist(await (await fetchOk(url, fetchImpl)).text(), url);
  if (parsed.kind !== "media") throw new HlsError("HLS_VARIANT_REQUIRED", "Escolha uma qualidade antes de baixar.");
  const missing = [...new Set(parsed.segments.map((segment) => new URL(segment.url).origin).filter((origin) => !allowedOrigins.includes(origin)))];
  if (missing.length) throw new HlsError("HLS_PERMISSION", "Autorize o servidor de mídia para continuar.", { origins: missing });
  const parts = new Array(parsed.segments.length);
  let nextIndex = 0;
  let total = 0;
  const worker = async () => {
    while (nextIndex < parsed.segments.length) {
      const index = nextIndex++;
      const bytes = await (await fetchOk(parsed.segments[index].url, fetchImpl)).arrayBuffer();
      total += bytes.byteLength;
      if (total > maxBytes) throw new HlsError("HLS_TOO_LARGE", "O vídeo HLS ultrapassa o limite seguro de 1 GiB.");
      parts[index] = bytes;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, parsed.segments.length) }, worker));
  return { blob: new Blob(parts, { type: "video/mp2t" }), size: total };
}
```

- [ ] **Step 4: Run operation tests and verify GREEN**

Run: `node --test test/hls-operation.test.js`

Expected: PASS, `4` tests and `0` failures.

- [ ] **Step 5: Commit HLS operations**

```powershell
git add src/hls/hls-operation.js test/hls-operation.test.js
git commit -m "feat: assemble bounded HLS downloads"
```

### Task 6: Add offscreen HLS bridge

**Files:**
- Create: `src/offscreen/main.js`
- Create: `src/offscreen/bridge.js`
- Create: `test/offscreen-bridge.test.js`

- [ ] **Step 1: Write failing bridge tests with a real Blob**

```js
// test/offscreen-bridge.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { createOffscreenBridge } from "../src/offscreen/bridge.js";
import { ACTIONS } from "../src/shared/messages.js";

test("stores and releases an assembled blob URL", async () => {
  const revoked = [];
  const bridge = createOffscreenBridge({
    inspect: async () => ({ variants: [] }),
    assemble: async () => ({ blob: new Blob(["TS"]), size: 2 }),
    createObjectURL: () => "blob:extension/result",
    revokeObjectURL: (url) => revoked.push(url),
  });
  const built = await bridge.handle({ target: "offscreen", action: ACTIONS.DOWNLOAD_HLS, payload: { url: "https://cdn.test/v.m3u8", allowedOrigins: ["https://cdn.test"] } });
  assert.equal(built.blobUrl, "blob:extension/result");
  await bridge.handle({ target: "offscreen", action: ACTIONS.RELEASE_BLOB, payload: { blobUrl: built.blobUrl } });
  assert.deepEqual(revoked, ["blob:extension/result"]);
});
```

- [ ] **Step 2: Run the bridge test and verify RED**

Run: `node --test test/offscreen-bridge.test.js`

Expected: FAIL because the bridge is missing.

- [ ] **Step 3: Implement the bridge and runtime listener**

```js
// src/offscreen/bridge.js
import { assembleHls, inspectHls } from "../hls/hls-operation.js";
import { ACTIONS, assertOffscreenMessage } from "../shared/messages.js";

export function createOffscreenBridge({ inspect = inspectHls, assemble = assembleHls, createObjectURL = URL.createObjectURL, revokeObjectURL = URL.revokeObjectURL } = {}) {
  const owned = new Set();
  return { async handle(raw) {
    const message = assertOffscreenMessage(raw);
    if (message.action === ACTIONS.INSPECT_HLS) return inspect(message.payload.url);
    if (message.action === ACTIONS.DOWNLOAD_HLS) {
      const result = await assemble(message.payload.url, { allowedOrigins: message.payload.allowedOrigins });
      const blobUrl = createObjectURL(result.blob); owned.add(blobUrl);
      return { blobUrl, size: result.size };
    }
    if (message.action === ACTIONS.RELEASE_BLOB) {
      if (owned.delete(message.payload.blobUrl)) revokeObjectURL(message.payload.blobUrl);
      return { released: true };
    }
    throw new Error("Mensagem inválida");
  }};
}
```

```js
// src/offscreen/main.js
import { createOffscreenBridge } from "./bridge.js";

const bridge = createOffscreenBridge();
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") return false;
  bridge.handle(message).then(
    (value) => sendResponse({ ok: true, value }),
    (error) => sendResponse({ ok: false, error: { code: error.code ?? "HLS_UNKNOWN", message: error.message, details: error.details ?? {} } }),
  );
  return true;
});
```

- [ ] **Step 4: Run the bridge test and verify GREEN**

Run: `node --test test/offscreen-bridge.test.js`

Expected: PASS, `1` test and `0` failures.

- [ ] **Step 5: Commit offscreen processing**

```powershell
git add src/offscreen test/offscreen-bridge.test.js
git commit -m "feat: process HLS in offscreen document"
```

### Task 7: Orchestrate downloads in the service worker

**Files:**
- Create: `src/background/handlers.js`
- Create: `src/background/main.js`
- Create: `test/background-handlers.test.js`

- [ ] **Step 1: Write failing handler tests**

```js
// test/background-handlers.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { createBackgroundHandlers } from "../src/background/handlers.js";
import { ACTIONS } from "../src/shared/messages.js";

test("starts a direct Chrome download with a safe filename", async () => {
  const calls = [];
  const handlers = createBackgroundHandlers({ downloads: { download: async (options) => (calls.push(options), 7) } });
  const result = await handlers.handle({ target: "background", action: ACTIONS.DOWNLOAD_DIRECT, payload: { url: "https://cdn.test/a.mp4", filename: "a.mp4" } });
  assert.equal(result.downloadId, 7);
  assert.deepEqual(calls[0], { url: "https://cdn.test/a.mp4", filename: "a.mp4", saveAs: false });
});

test("hands an HLS blob to downloads and remembers cleanup", async () => {
  const session = new Map();
  const removed = [];
  const handlers = createBackgroundHandlers({
    downloads: { download: async () => 8 },
    sendOffscreen: async () => ({ ok: true, value: { blobUrl: "blob:extension/x", size: 2 } }),
    session: { get: async (key) => ({ [key]: session.get(key) }), set: async (data) => Object.entries(data).forEach(([k, v]) => session.set(k, v)) },
    permissions: { remove: async ({ origins }) => (removed.push(origins), true) },
  });
  const result = await handlers.handle({ target: "background", action: ACTIONS.DOWNLOAD_HLS, payload: { url: "https://cdn.test/v.m3u8", filename: "v.ts", allowedOrigins: ["https://cdn.test"], permissionPatterns: ["https://cdn.test/*"] } });
  assert.equal(result.downloadId, 8);
  assert.equal(session.get("hlsDownloadBlobs")["8"], "blob:extension/x");
  assert.deepEqual(removed, [["https://cdn.test/*"]]);
});
```

- [ ] **Step 2: Run handler tests and verify RED**

Run: `node --test test/background-handlers.test.js`

Expected: FAIL because the background handlers are missing.

- [ ] **Step 3: Implement testable handlers and MV3 registration**

```js
// src/background/handlers.js
import { ACTIONS, assertBackgroundMessage } from "../shared/messages.js";

export function createBackgroundHandlers({ downloads = chrome.downloads, sendOffscreen = (message) => chrome.runtime.sendMessage(message), session = chrome.storage.session, permissions = chrome.permissions } = {}) {
  return {
    async handle(raw) {
      const message = assertBackgroundMessage(raw);
      if (message.action === ACTIONS.DOWNLOAD_DIRECT) {
        const downloadId = await downloads.download({ url: message.payload.url, filename: message.payload.filename, saveAs: false });
        return { downloadId };
      }
      if (message.action === ACTIONS.INSPECT_HLS) {
        try {
          const response = await sendOffscreen({ ...message, target: "offscreen" });
          if (!response.ok) throw Object.assign(new Error(response.error.message), response.error);
          return response.value;
        } finally {
          if (message.payload.permissionPatterns.length) await permissions.remove({ origins: message.payload.permissionPatterns });
        }
      }
      if (message.action === ACTIONS.DOWNLOAD_HLS) {
        try {
          const response = await sendOffscreen({ ...message, target: "offscreen" });
          if (!response.ok) throw Object.assign(new Error(response.error.message), response.error);
          const downloadId = await downloads.download({ url: response.value.blobUrl, filename: message.payload.filename, saveAs: false });
          const stored = (await session.get("hlsDownloadBlobs")).hlsDownloadBlobs ?? {};
          await session.set({ hlsDownloadBlobs: { ...stored, [downloadId]: response.value.blobUrl } });
          return { ok: true, downloadId };
        } finally {
          if (message.payload.permissionPatterns.length) await permissions.remove({ origins: message.payload.permissionPatterns });
        }
      }
      throw new Error("Mensagem inválida");
    },
  };
}
```

```js
// src/background/main.js
import { createBackgroundHandlers } from "./handlers.js";
import { ACTIONS } from "../shared/messages.js";

const OFFSCREEN_URL = "offscreen.html";
const handlers = createBackgroundHandlers({
  sendOffscreen: async (message) => {
    if (!(await chrome.offscreen.hasDocument())) await chrome.offscreen.createDocument({ url: OFFSCREEN_URL, reasons: ["BLOBS"], justification: "Montar segmentos HLS em um arquivo local para download" });
    return chrome.runtime.sendMessage(message);
  },
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "background") return false;
  handlers.handle(message).then((value) => sendResponse({ ok: true, value }), (error) => sendResponse({ ok: false, error: { code: error.code ?? "UNKNOWN", message: error.message, details: error.details ?? {} } }));
  return true;
});

chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta.state || !["complete", "interrupted"].includes(delta.state.current)) return;
  const stored = (await chrome.storage.session.get("hlsDownloadBlobs")).hlsDownloadBlobs ?? {};
  const blobUrl = stored[delta.id];
  if (!blobUrl) return;
  await chrome.runtime.sendMessage({ target: "offscreen", action: ACTIONS.RELEASE_BLOB, payload: { blobUrl } });
  delete stored[delta.id];
  await chrome.storage.session.set({ hlsDownloadBlobs: stored });
});
```

Append this contract test to `test/messages.test.js`:

```js
test("separates background and offscreen-only commands", () => {
  assert.throws(() => assertBackgroundMessage({ target: "background", action: ACTIONS.RELEASE_BLOB, payload: { blobUrl: "blob:x" } }), /Mensagem inválida/);
  assert.doesNotThrow(() => assertBackgroundMessage({ target: "background", action: ACTIONS.DOWNLOAD_HLS, payload: { url: "https://cdn.test/v.m3u8", filename: "v.ts", allowedOrigins: ["https://cdn.test"], permissionPatterns: ["https://cdn.test/*"] } }));
});
```

- [ ] **Step 4: Run background and contract tests and verify GREEN**

Run: `node --test test/background-handlers.test.js test/messages.test.js`

Expected: PASS, `4` tests and `0` failures.

- [ ] **Step 5: Commit worker orchestration**

```powershell
git add src/background src/shared/messages.js test/background-handlers.test.js test/messages.test.js
git commit -m "feat: orchestrate browser downloads"
```

### Task 8: Build the popup state model and accessible interface

**Files:**
- Create: `src/popup/state.js`
- Create: `src/popup/render.js`
- Create: `src/popup/main.js`
- Create: `styles/popup.css`
- Create: `test/popup-state.test.js`

- [ ] **Step 1: Write failing state-transition tests**

```js
// test/popup-state.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { initialState, reduceState } from "../src/popup/state.js";

test("moves from idle through scanning to results", () => {
  const scanning = reduceState(initialState, { type: "SCAN_STARTED" });
  assert.equal(scanning.status, "scanning");
  const results = reduceState(scanning, { type: "SCAN_SUCCEEDED", items: [{ id: "x", kind: "direct", variants: [] }] });
  assert.equal(results.status, "results");
  assert.equal(results.items.length, 1);
});

test("tracks only per-item preparation and no progress value", () => {
  const state = reduceState({ ...initialState, status: "results", items: [{ id: "hls", kind: "hls" }] }, { type: "DOWNLOAD_STARTED", id: "hls" });
  assert.equal(state.busyId, "hls");
  assert.equal("progress" in state, false);
});

test("maps a supported error to actionable Portuguese copy", () => {
  const state = reduceState(initialState, { type: "FAILED", code: "HLS_FMP4" });
  assert.match(state.message, /segmentos fMP4/);
});

test("stores inspected HLS variants and a permission retry", () => {
  const base = { ...initialState, status: "results", items: [{ id: "h", kind: "hls", inspected: false, variants: [{ url: "https://cdn.test/master.m3u8" }] }] };
  const inspected = reduceState(base, { type: "HLS_INSPECTED", id: "h", variants: [{ url: "https://cdn.test/720.m3u8", label: "720p" }], allowedOrigins: ["https://cdn.test"] });
  assert.equal(inspected.items[0].inspected, true);
  const waiting = reduceState(inspected, { type: "PERMISSION_REQUIRED", id: "h", selectedIndex: 0, origins: ["https://media.test"] });
  assert.deepEqual(waiting.pendingPermission.origins, ["https://media.test"]);
});
```

- [ ] **Step 2: Run state tests and verify RED**

Run: `node --test test/popup-state.test.js`

Expected: FAIL because `state.js` is missing.

- [ ] **Step 3: Implement the reducer and error copy**

```js
// src/popup/state.js
const errors = {
  PERMISSION_DENIED: "O acesso ao servidor de mídia foi negado. Autorize o domínio para continuar.",
  HLS_ENCRYPTED: "Esta playlist usa criptografia não suportada.",
  HLS_FMP4: "Esta playlist usa segmentos fMP4, não suportados nesta versão.",
  HLS_BYTERANGE: "Esta playlist usa intervalos de bytes não suportados.",
  HLS_LIVE: "Transmissões HLS ao vivo não são suportadas nesta versão.",
  HLS_TOO_LARGE: "O vídeo ultrapassa o limite seguro de 1 GiB para HLS.",
  HLS_NETWORK: "Não foi possível acessar todos os segmentos. Tente buscar novamente.",
};

export const initialState = Object.freeze({ status: "idle", items: [], busyId: null, message: "", pendingPermission: null });
export function reduceState(state, event) {
  if (event.type === "SCAN_STARTED") return { ...state, status: "scanning", message: "Analisando a página…" };
  if (event.type === "SCAN_SUCCEEDED") return { ...state, status: event.items.length ? "results" : "empty", items: event.items, message: event.items.length ? `${event.items.length} mídia(s) encontrada(s)` : "Nenhum vídeo direto ou HLS foi encontrado." };
  if (event.type === "DOWNLOAD_STARTED") return { ...state, busyId: event.id, message: "Preparando…" };
  if (event.type === "DOWNLOAD_SENT") return { ...state, busyId: null, message: "Download enviado ao Chrome" };
  if (event.type === "HLS_INSPECTED") return { ...state, items: state.items.map((item) => item.id === event.id ? { ...item, inspected: true, variants: event.variants, allowedOrigins: event.allowedOrigins } : item), busyId: null, message: `${event.variants.length} qualidade(s) encontrada(s)` };
  if (event.type === "PERMISSION_REQUIRED") return { ...state, busyId: null, pendingPermission: { id: event.id, selectedIndex: event.selectedIndex, origins: event.origins }, message: "Autorize o servidor de mídia para continuar." };
  if (event.type === "ORIGINS_GRANTED") return { ...state, pendingPermission: null, items: state.items.map((item) => item.id === event.id ? { ...item, allowedOrigins: [...new Set([...(item.allowedOrigins ?? []), ...event.origins])] } : item) };
  if (event.type === "ORIGINS_CLEARED") return { ...state, pendingPermission: null, items: state.items.map((item) => ({ ...item, allowedOrigins: [] })) };
  if (event.type === "FAILED") return { ...state, status: state.items.length ? "results" : "error", busyId: null, message: errors[event.code] ?? "Não foi possível concluir a operação." };
  return state;
}
```

- [ ] **Step 4: Implement rendering, scan and download interactions**

```js
// src/popup/render.js
const escapeText = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
export function renderPopup(root, state) {
  const cards = state.items.map((item) => {
    const needsInspection = item.kind === "hls" && !item.inspected;
    const action = needsInspection ? `data-inspect="${escapeText(item.id)}"` : `data-download="${escapeText(item.id)}"`;
    const label = state.busyId === item.id ? "Preparando…" : needsInspection ? "Ver qualidades" : "Baixar";
    const quality = item.variants?.length > 1 ? `<label class="quality">Qualidade<span class="sr-only"> de ${escapeText(item.filename)}</span><select data-quality>${item.variants.map((variant, index) => `<option value="${index}">${escapeText(variant.label)}</option>`).join("")}</select></label>` : `<span class="single-quality">${escapeText(item.variants?.[0]?.label ?? "Qualidade única")}</span>`;
    const authorize = state.pendingPermission?.id === item.id ? `<button class="authorize" data-authorize="${escapeText(item.id)}">Autorizar servidor de mídia</button>` : "";
    return `<li class="media" data-id="${escapeText(item.id)}"><div class="media__meta"><strong>${escapeText(item.filename)}</strong><span>${item.kind === "hls" ? "HLS · salvo como TS" : escapeText(item.format.toUpperCase())}</span></div>${quality}<button class="download" ${action} ${state.busyId ? "disabled" : ""}>${label}</button>${authorize}</li>`;
  }).join("");
  root.innerHTML = `<header class="header"><div><span class="eyebrow">Detector de mídia</span><h1>Vídeo Radar</h1></div><span class="radar" aria-label="${state.items.length} vídeos encontrados">${state.items.length || "◎"}</span></header><section class="surface">${state.status === "idle" ? `<div class="empty"><span aria-hidden="true">◎</span><strong>Pronto para analisar</strong><p>A busca só começa quando você solicitar.</p></div><button class="primary" data-scan>Buscar vídeos nesta página</button>` : ""}${state.status === "scanning" ? `<p class="status">Analisando a página…</p>` : ""}${["results", "empty", "error"].includes(state.status) ? `<div class="results-head"><strong>Mídias disponíveis</strong><button class="link" data-scan>Buscar novamente</button></div><ul class="media-list">${cards}</ul>` : ""}<p class="feedback" role="status">${escapeText(state.message)}</p></section>`;
}
```

```js
// src/popup/main.js
import { scanPage } from "../detection/scan-page.js";
import { groupDirectVariants, normalizeCandidates } from "../detection/media-candidates.js";
import { buildDownloadFilename } from "../shared/filename.js";
import { ACTIONS } from "../shared/messages.js";
import { initialState, reduceState } from "./state.js";
import { renderPopup } from "./render.js";

const root = document.querySelector("#app");
let state = initialState;
const draw = () => { renderPopup(root, state); document.querySelector("#announcer").textContent = state.message; };
const dispatch = (event) => { state = reduceState(state, event); draw(); };
const originPattern = (url) => { const parsed = new URL(url); return `${parsed.protocol}//${parsed.hostname}/*`; };
const requestOrigins = async (values) => {
  const origins = [...new Set(values.map((value) => new URL(value).origin))];
  const patterns = origins.map(originPattern);
  const granted = (await chrome.permissions.contains({ origins: patterns })) || await chrome.permissions.request({ origins: patterns });
  if (!granted) throw Object.assign(new Error("permission denied"), { code: "PERMISSION_DENIED" });
  return { origins, patterns };
};

async function scan() {
  dispatch({ type: "SCAN_STARTED" });
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scanPage });
    const items = groupDirectVariants(normalizeCandidates(result.candidates)).map((group) => ({ ...group, inspected: group.kind === "direct", allowedOrigins: [], filename: buildDownloadFilename({ url: group.variants[0].url, kind: group.kind, pageTitle: result.pageTitle }), format: group.kind === "hls" ? "ts" : new URL(group.variants[0].url).pathname.split(".").at(-1), variants: group.variants.map((variant) => ({ ...variant, label: variant.height ? `${variant.height}p` : "Qualidade única" })) }));
    dispatch({ type: "SCAN_SUCCEEDED", items });
  } catch (error) { dispatch({ type: "FAILED", code: error.code ?? "SCAN_FAILED" }); }
}

async function inspect(item) {
  dispatch({ type: "DOWNLOAD_STARTED", id: item.id });
  try {
    const grant = await requestOrigins([item.variants[0].url]);
    const response = await chrome.runtime.sendMessage({ target: "background", action: ACTIONS.INSPECT_HLS, payload: { url: item.variants[0].url, permissionPatterns: grant.patterns } });
    if (!response.ok) throw Object.assign(new Error(response.error.message), response.error);
    dispatch({ type: "HLS_INSPECTED", id: item.id, variants: response.value.variants, allowedOrigins: grant.origins });
  } catch (error) { dispatch({ type: "FAILED", code: error.code ?? "UNKNOWN" }); }
}

async function download(item, selectedIndex, existingGrant = null) {
  dispatch({ type: "DOWNLOAD_STARTED", id: item.id });
  try {
    const variant = item.variants[selectedIndex] ?? item.variants[0];
    if (item.kind === "direct") {
      const response = await chrome.runtime.sendMessage({ target: "background", action: ACTIONS.DOWNLOAD_DIRECT, payload: { url: variant.url, filename: item.filename } });
      if (!response.ok) throw Object.assign(new Error(response.error.message), response.error);
    }
    else {
      const grant = existingGrant ?? await requestOrigins([variant.url]);
      const origins = [...new Set([...(item.allowedOrigins ?? []), ...grant.origins])];
      const response = await chrome.runtime.sendMessage({ target: "background", action: ACTIONS.DOWNLOAD_HLS, payload: { url: variant.url, filename: item.filename, allowedOrigins: origins, permissionPatterns: grant.patterns } });
      if (!response.ok) throw Object.assign(new Error(response.error.message), response.error);
      dispatch({ type: "ORIGINS_CLEARED" });
    }
    dispatch({ type: "DOWNLOAD_SENT" });
  } catch (error) {
    if (error.code === "HLS_PERMISSION") { dispatch({ type: "PERMISSION_REQUIRED", id: item.id, selectedIndex, origins: error.details.origins }); return; }
    dispatch({ type: "FAILED", code: error.code ?? "UNKNOWN" });
  }
}

root.addEventListener("click", (event) => {
  if (event.target.closest("[data-scan]")) scan();
  const inspectButton = event.target.closest("[data-inspect]");
  if (inspectButton) inspect(state.items.find((entry) => entry.id === inspectButton.dataset.inspect));
  const button = event.target.closest("[data-download]");
  if (button) { const item = state.items.find((entry) => entry.id === button.dataset.download); const select = button.closest(".media").querySelector("[data-quality]"); download(item, Number(select?.value ?? 0)); }
  const authorize = event.target.closest("[data-authorize]");
  if (authorize) {
    const pending = state.pendingPermission;
    const item = state.items.find((entry) => entry.id === pending.id);
    const variant = item.variants[pending.selectedIndex] ?? item.variants[0];
    requestOrigins([variant.url, ...pending.origins]).then((grant) => { dispatch({ type: "ORIGINS_GRANTED", id: pending.id, origins: grant.origins }); const refreshed = state.items.find((entry) => entry.id === pending.id); download(refreshed, pending.selectedIndex, grant); }).catch((error) => dispatch({ type: "FAILED", code: error.code ?? "PERMISSION_DENIED" }));
  }
});
draw();
```

```css
/* styles/popup.css */
:root { color-scheme: light; --navy:#101d30; --blue:#2f67e8; --green:#6fe2ae; --surface:#f7f9fc; --text:#17253a; --muted:#66758a; --line:#dde4ed; font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
* { box-sizing:border-box; }
body { margin:0; width:380px; min-height:260px; color:var(--text); background:var(--surface); }
button,select { font:inherit; }
button { min-height:40px; cursor:pointer; }
button:focus-visible,select:focus-visible { outline:3px solid color-mix(in srgb,var(--blue) 40%,transparent); outline-offset:2px; }
.header { display:flex; justify-content:space-between; align-items:center; padding:18px 20px 15px; color:white; background:var(--navy); }
.eyebrow { color:#8ca2bf; font-size:11px; font-weight:700; letter-spacing:.14em; text-transform:uppercase; }
h1 { margin:4px 0 0; font-size:22px; }
.radar { display:grid; place-items:center; min-width:42px; height:42px; padding:0 10px; border:1px solid #39516d; border-radius:999px; color:var(--green); font-weight:800; }
.surface { padding:16px 14px 18px; }
.empty { display:grid; justify-items:center; gap:7px; padding:24px; text-align:center; border:1px dashed #b9c5d4; border-radius:16px; background:white; }
.empty > span { color:var(--blue); font-size:32px; }
.empty p,.feedback { margin:0; color:var(--muted); font-size:12px; line-height:1.45; }
.primary,.download,.authorize { border:0; border-radius:10px; color:white; background:var(--blue); font-weight:750; }
.primary { width:100%; margin-top:14px; }
.results-head { display:flex; justify-content:space-between; align-items:center; padding:0 4px 10px; font-size:13px; }
.link { border:0; color:var(--blue); background:transparent; font-size:12px; font-weight:750; }
.media-list { display:grid; gap:10px; margin:0; padding:0; list-style:none; }
.media { display:grid; grid-template-columns:1fr auto; gap:10px; padding:14px; border:1px solid var(--line); border-radius:14px; background:white; }
.media__meta { min-width:0; }
.media__meta strong { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; }
.media__meta span,.single-quality { display:block; margin-top:4px; color:var(--muted); font-size:11px; }
.quality { grid-column:1; color:var(--muted); font-size:11px; }
.quality select { display:block; width:100%; min-height:40px; margin-top:4px; padding:0 10px; border:1px solid #cfd8e5; border-radius:10px; color:var(--text); background:white; }
.download { grid-column:2; grid-row:2; padding:0 13px; }
.authorize { grid-column:1/-1; padding:0 13px; background:#276f50; }
.feedback { min-height:18px; margin-top:12px; }
.sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
@media (prefers-reduced-motion:reduce) { *,*::before,*::after { scroll-behavior:auto!important; transition:none!important; } }
```

- [ ] **Step 5: Run state tests and verify GREEN**

Run: `node --test test/popup-state.test.js`

Expected: PASS, `4` tests and `0` failures.

- [ ] **Step 6: Commit popup UI**

```powershell
git add popup.html styles/popup.css src/popup test/popup-state.test.js
git commit -m "feat: add accessible video radar popup"
```

### Task 9: Add deterministic browser fixtures and full preflight

**Files:**
- Create: `test/fixtures/pages/direct.html`
- Create: `test/fixtures/pages/empty.html`
- Create: `test/fixtures/hls/720p.m3u8`
- Create: `test/fixtures/hls/480p.m3u8`
- Create: `test/fixtures/hls/seg-1.ts`
- Create: `test/fixtures/hls/seg-2.ts`
- Create: `test/fixtures/media/demo-720.mp4`
- Create: `test/fixtures/media/demo-480.webm`
- Create: `test/fixtures/media/clip.mov`
- Create: `scripts/serve-fixtures.mjs`
- Modify: `scripts/validate-extension.mjs`
- Create: `test/extension-preflight.test.js`

- [ ] **Step 1: Write the failing full-package preflight test**

```js
// test/extension-preflight.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("extension package passes static preflight", () => {
  const result = spawnSync(process.execPath, ["scripts/validate-extension.mjs"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Extension preflight passed/);
});
```

- [ ] **Step 2: Run preflight and verify RED**

Run: `node --test test/extension-preflight.test.js`

Expected: FAIL until every referenced production file exists and passes static validation.

- [ ] **Step 3: Add local fixture pages, playlists and server**

```html
<!-- test/fixtures/pages/direct.html -->
<!doctype html><html><head><title>Fixture de vídeos</title></head><body>
  <video aria-label="Demonstração" controls>
    <source src="/media/demo-720.mp4" type="video/mp4">
    <source src="/media/demo-480.webm" type="video/webm">
  </video>
  <video src="/media/clip.mov" controls></video>
  <script>fetch("/hls/master.m3u8").then(() => performance.mark("fixture-ready"))</script>
</body></html>
```

```html
<!-- test/fixtures/pages/empty.html -->
<!doctype html><html><head><title>Fixture vazia</title></head><body><p>Nenhuma mídia nesta página.</p></body></html>
```

```m3u8
# test/fixtures/hls/720p.m3u8
#EXTM3U
#EXTINF:1.0,
seg-1.ts
#EXTINF:1.0,
seg-2.ts
#EXT-X-ENDLIST
```

```m3u8
# test/fixtures/hls/480p.m3u8
#EXTM3U
#EXTINF:1.0,
seg-1.ts
#EXT-X-ENDLIST
```

```js
// scripts/serve-fixtures.mjs
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../test/fixtures/", import.meta.url));
const types = { ".html": "text/html", ".m3u8": "application/vnd.apple.mpegurl", ".ts": "video/mp2t", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime" };
const server = http.createServer(async (request, response) => {
  const pathname = request.url === "/" ? "/pages/direct.html" : new URL(request.url, "http://localhost").pathname;
  const file = normalize(join(root, pathname));
  if (!file.startsWith(normalize(root))) { response.writeHead(403).end(); return; }
  try { response.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "access-control-allow-origin": "*" }); response.end(await readFile(file)); }
  catch { response.writeHead(404).end("not found"); }
});
server.listen(4173, "127.0.0.1", () => console.log("Fixture server: http://127.0.0.1:4173"));
```

Create these deterministic fixture bodies exactly:

```text
# test/fixtures/hls/seg-1.ts
SEGMENT-ONE
```

```text
# test/fixtures/hls/seg-2.ts
SEGMENT-TWO
```

```text
# test/fixtures/media/demo-720.mp4
DIRECT-MP4-FIXTURE
```

```text
# test/fixtures/media/demo-480.webm
DIRECT-WEBM-FIXTURE
```

```text
# test/fixtures/media/clip.mov
DIRECT-MOV-FIXTURE
```

These files validate detection, ordering and download plumbing; codec playback is not part of the deterministic fixture assertion.

- [ ] **Step 4: Strengthen static validation**

```js
// scripts/validate-extension.mjs — replace with this final preflight
import { access, readdir, readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
const required = [manifest.action.default_popup, manifest.background.service_worker, "offscreen.html", "styles/popup.css", "src/popup/main.js", "src/offscreen/main.js"];
await Promise.all(required.map((file) => access(resolve(root, file))));
if (manifest.host_permissions?.length) throw new Error("host_permissions must remain empty");

const remoteScript = /<script[^>]+src=["']https?:/i;
for (const html of ["popup.html", "offscreen.html"]) {
  const source = await readFile(resolve(root, html), "utf8");
  if (remoteScript.test(source)) throw new Error(`${html} contains a remote script`);
}

const walk = async (directory) => (await Promise.all((await readdir(directory, { withFileTypes: true })).map((entry) => entry.isDirectory() ? walk(resolve(directory, entry.name)) : resolve(directory, entry.name)))).flat();
const productionFiles = (await walk(resolve(root, "src"))).filter((file) => extname(file) === ".js");
for (const file of productionFiles) {
  const source = await readFile(file, "utf8");
  for (const match of source.matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/g)) await access(resolve(dirname(file), match[1]));
}

const popup = await readFile(resolve(root, "popup.html"), "utf8");
if ((popup.match(/<script\s+type="module"/g) ?? []).length !== 1) throw new Error("popup.html must have one module entry point");
console.log(`Extension preflight passed: ${productionFiles.length} production modules validated`);
```

- [ ] **Step 5: Run full verification and verify GREEN**

Run: `npm run check`

Expected: `Extension preflight passed`, all tests PASS, `0` failures, exit code `0`.

Run: `git diff --check`

Expected: no output and exit code `0`.

- [ ] **Step 6: Commit fixtures and preflight**

```powershell
git add scripts test/fixtures test/extension-preflight.test.js
git commit -m "test: add extension fixtures and preflight"
```

### Task 10: Perform real Chromium verification and document loading

**Files:**
- Create: `README.md`
- Create: `docs/verification/2026-07-21-video-radar.md`

- [ ] **Step 1: Write user-facing loading and limitation instructions**

```markdown
# Vídeo Radar

Extensão Manifest V3 para detectar, escolher e baixar vídeos diretos ou HLS MPEG-TS disponíveis na página atual.

## Instalar no Chrome/Edge

1. Abra `chrome://extensions` ou `edge://extensions`.
2. Ative **Modo do desenvolvedor**.
3. Clique em **Carregar sem compactação**.
4. Escolha esta pasta do projeto.
5. Abra uma página, clique em **Vídeo Radar** e depois em **Buscar vídeos nesta página**.

## Limites

Não suporta DRM, HLS criptografado, HLS ao vivo, segmentos fMP4/CMAF, byte ranges ou DASH. Use apenas em conteúdo que você tem autorização para baixar.
```

- [ ] **Step 2: Start deterministic fixtures**

Run: `node scripts/serve-fixtures.mjs`

Expected: `Fixture server: http://127.0.0.1:4173` and the process remains running for the manual session.

- [ ] **Step 3: Load the unpacked extension and execute the acceptance matrix**

Record evidence in `docs/verification/2026-07-21-video-radar.md` with a row for each result:

```markdown
| Scenario | Expected | Result | Evidence |
|---|---|---|---|
| Install | No global site permission prompt | Pass/Fail | browser observation |
| Direct scan | MP4, WEBM and MOV listed once | Pass/Fail | popup screenshot |
| Empty scan | Actionable empty state | Pass/Fail | popup screenshot |
| Quality | HLS 1080p, 720p and 480p ordered | Pass/Fail | popup screenshot |
| HLS download | Selected variant saved as `.ts` | Pass/Fail | download list + bytes |
| Popup close | HLS completes after popup closes | Pass/Fail | download list |
| Permission denied | Recovery copy appears | Pass/Fail | popup screenshot |
| Keyboard | Scan, quality and download reachable | Pass/Fail | manual keyboard pass |
| Zoom | No clipping at 200% | Pass/Fail | popup screenshot |
```

For the fixture HLS output, inspect the downloaded file and confirm `SEGMENT-ONESEGMENT-TWO` order. Confirm there is no popup progress bar and that only the per-item button displays **Preparando…**.

- [ ] **Step 4: Re-run automated verification after browser fixes**

Run: `npm run check`

Expected: preflight passes, all tests pass, `0` failures.

Run: `git status --short`

Expected: only `README.md` and `docs/verification/2026-07-21-video-radar.md` are uncommitted before the final documentation commit.

- [ ] **Step 5: Commit verified handoff**

```powershell
git add README.md docs/verification/2026-07-21-video-radar.md
git commit -m "docs: add video radar setup and verification"
```

## Final completion gate

Before claiming completion, run these commands fresh and read their full output:

```powershell
npm run check
git diff --check
git status --short
git log --oneline -10
```

The work is complete only if the preflight and tests exit `0`, `git diff --check` is empty, the worktree contains no unintended changes, and every acceptance row in the verification document has a concrete Pass/Fail result with evidence.
