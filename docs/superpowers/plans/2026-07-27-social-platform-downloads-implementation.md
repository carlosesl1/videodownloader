# Social Platform Downloads Implementation Plan

> **For agentic workers:** Execute directly by default. Use subagents only for independent bounded lanes that satisfy the global harness policy. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reliable public-video downloads for TikTok, Instagram, and X/Twitter while preserving Video Radar's on-demand permissions, persistent progress, download destination, and Explorer reveal behavior.

**Architecture:** Replace the YouTube-only URL boundary with a strict allowlisted `MediaPage` model shared by the extension and native host. Keep yt-dlp, FFmpeg, Native Messaging, and the existing durable job engine, but expose them as a platform-neutral media pipeline. Start with one public video per post; represent multi-media metadata explicitly so carousels and slideshows can be added without another state migration.

**Tech Stack:** Chrome Manifest V3, JavaScript ES modules, `chrome.storage`, Native Messaging, .NET 10/C#, yt-dlp 2026.07.04, FFmpeg, Node test runner, custom .NET test harness.

---

### Task 1: Strict multi-platform URL identity

**Files:**
- Create: `src/media/page-url.js`
- Create: `test/media-page-url.test.js`
- Create: `native-host/VideoRadar.NativeHost/Media/MediaPage.cs`
- Modify: `native-host/VideoRadar.NativeHost.Tests/TestSuite.Protocol.cs`
- Modify: `native-host/VideoRadar.NativeHost.Tests/TestSuite.cs`

- [ ] **Step 1: Write failing JavaScript URL tests**

Cover canonical YouTube watch/Shorts URLs, TikTok `/@user/video/<numeric-id>`, TikTok `vm`/`vt` short links, Instagram `/reel|reels|p|tv/<shortcode>`, and X/Twitter `/<user>/status/<numeric-id>`. Assert `{ platform, canonicalUrl, mediaId }` and reject HTTP, credentials, custom ports, lookalike domains, dot segments, profiles, feeds, live pages, and duplicate identity query parameters.

- [ ] **Step 2: Run the focused JavaScript test**

Run: `node --test test/media-page-url.test.js`

Expected: FAIL because `src/media/page-url.js` does not exist.

- [ ] **Step 3: Implement the JavaScript canonicalizer**

Expose:

```js
export function canonicalMediaPage(value) {
  // returns a frozen { platform, canonicalUrl, mediaId } or null
}
```

Preserve TikTok short URLs for yt-dlp to resolve, but derive a stable bounded `mediaId` from their pathname. Normalize YouTube Shorts to watch URLs and `twitter.com` to `x.com`.

- [ ] **Step 4: Add matching native URL tests and implementation**

Expose:

```csharp
public sealed record MediaPage(string Platform, string CanonicalUrl, string MediaId)
{
    public static bool TryCanonicalize(string value, out MediaPage? page);
}
```

Apply the same authority/path security rules as the extension. Do not pass arbitrary URLs to yt-dlp.

- [ ] **Step 5: Run focused URL proofs**

Run:

```powershell
node --test test/media-page-url.test.js test/youtube-protocol.test.js
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dotnet.ps1 run --project native-host/VideoRadar.NativeHost.Tests
```

Expected: all URL and native tests pass.

### Task 2: Platform-neutral native metadata and downloads

**Files:**
- Create: `native-host/VideoRadar.NativeHost/Media/MediaCatalog.cs`
- Create: `native-host/VideoRadar.NativeHost/Media/MediaService.cs`
- Create: `native-host/VideoRadar.NativeHost/Media/IMediaService.cs`
- Create: `native-host/VideoRadar.NativeHost/Media/YtDlpArguments.cs`
- Create: `native-host/VideoRadar.NativeHost.Tests/Fixtures/instagram-info.json`
- Create: `native-host/VideoRadar.NativeHost.Tests/Fixtures/tiktok-info.json`
- Create: `native-host/VideoRadar.NativeHost.Tests/Fixtures/twitter-info.json`
- Modify: `native-host/VideoRadar.NativeHost/Host/NativeHostServer.cs`
- Modify: `native-host/VideoRadar.NativeHost/Program.cs`
- Modify: `native-host/VideoRadar.NativeHost.Tests/TestSuite.Formats.cs`
- Modify: `native-host/VideoRadar.NativeHost.Tests/TestSuite.Download.cs`
- Modify: `native-host/VideoRadar.NativeHost.Tests/TestSuite.Server.cs`

- [ ] **Step 1: Add failing catalog fixtures and tests**

Verify that absent `availability` is accepted, while `private`, `subscriber_only`, `premium_only`, `needs_auth`, and live content are rejected. Verify platform, extractor, title, duration, codec, container, combined audio/video, and height are retained.

- [ ] **Step 2: Implement `MediaCatalog`**

Use a neutral shape:

```csharp
public sealed record MediaCatalog(
    string Platform,
    string MediaId,
    string Title,
    double? DurationSeconds,
    IReadOnlyList<QualityOption> Qualities,
    IReadOnlyList<MediaEntry> Entries);
```

Treat a missing availability field as unknown/publicly retrievable after successful extraction, but explicitly reject restricted values.

- [ ] **Step 3: Generalize the yt-dlp service**

Keep one active durable job. Retain `--ignore-config`, `--no-plugin-dirs`, `--no-remote-components`, bounded filenames, controlled output paths, and fixed argument construction. Add platform-specific selectors:

```text
youtube: existing video+audio merge selector
tiktok: prefer combined MP4 H.264, then combined MP4, then best
instagram: prefer combined MP4 at/below selected height
twitter: prefer combined MP4 at/below selected height
```

Do not expose free-form yt-dlp arguments.

- [ ] **Step 4: Replace host YouTube validation with `MediaPage`**

Keep current Native Messaging command names for backward compatibility in this batch, but return `platform` in catalogs and jobs. Map failures to stable codes: `LOGIN_REQUIRED`, `RATE_LIMITED`, `PRIVATE_CONTENT`, `NO_VIDEO`, `UNSUPPORTED_POST`, and `EXTRACTOR_CHANGED`.

- [ ] **Step 5: Run native proof**

Run: `npm run test:native`

Expected: all native tests pass with YouTube regression coverage plus the three new fixture families.

### Task 3: Persistent social discovery and job state

**Files:**
- Create: `src/media/protocol.js`
- Create: `src/media/job-view.js`
- Create: `src/background/media-coordinator.js`
- Modify: `src/background/discovery-coordinator.js`
- Modify: `src/background/main.js`
- Modify: `src/background/router.js`
- Modify: `src/background/native-port.js`
- Modify: `src/background/download-relocation.js`
- Modify: `src/detection/discovery-protocol.js`
- Modify: `test/discovery-coordinator.test.js`
- Create: `test/media-coordinator.test.js`
- Modify: `test/background-router.test.js`
- Modify: `test/native-port.test.js`

- [ ] **Step 1: Add failing discovery tests**

Assert that supported social pages are sent directly to the native helper, unsupported pages still use the DOM/resource scanner, and the discovery snapshot persists across popup closure.

- [ ] **Step 2: Implement neutral discovery routing**

Store `platform`, `mediaUrl`, and `kind: "remote-media"` in the durable per-tab discovery record. Preserve `kind: "page"` for direct/HLS scanning.

- [ ] **Step 3: Migrate durable job state**

Use `mediaJob` as the canonical key and migrate a valid existing `youtubeJob` once. Keep the public snapshot bounded and platform-neutral:

```js
{
  jobId, platform, mediaId, title, url, height, stage,
  percent, downloadedBytes, totalBytes, speedBytesPerSecond,
  etaSeconds, path, error, updatedAt
}
```

- [ ] **Step 4: Run focused background proofs**

Run:

```powershell
node --test test/media-page-url.test.js test/media-coordinator.test.js test/discovery-coordinator.test.js test/background-router.test.js test/native-port.test.js
```

Expected: all focused background tests pass.

### Task 4: Popup support for TikTok, Instagram, and X

**Files:**
- Modify: `src/popup/main.js`
- Modify: `src/popup/state.js`
- Modify: `src/popup/render.js`
- Modify: `styles/popup.css`
- Modify: `test/popup-main-helpers.test.js`
- Modify: `test/popup-state.test.js`
- Create: `test/popup-media-render.test.js`

- [ ] **Step 1: Add failing popup tests**

Cover platform labels, single-quality fallback, quality selection, persistent scanning/results, active progress after reopening, completion path, cancellation, retry, and Explorer reveal.

- [ ] **Step 2: Render platform-neutral cards**

Use `TikTok`, `Instagram`, `X` or `YouTube` as the source label. Show `Qualidade única` when only one useful option exists. Keep existing progress and destination controls.

- [ ] **Step 3: Translate stable error codes**

Render actionable Portuguese messages such as:

```text
LOGIN_REQUIRED: A plataforma exigiu login para acessar este vídeo.
RATE_LIMITED: A plataforma limitou temporariamente as consultas. Tente novamente mais tarde.
NO_VIDEO: Este post não contém um vídeo compatível.
EXTRACTOR_CHANGED: A plataforma mudou e o auxiliar precisa ser atualizado.
```

- [ ] **Step 4: Run popup proofs**

Run:

```powershell
node --test test/popup-main-helpers.test.js test/popup-state.test.js test/popup-media-render.test.js
```

Expected: all popup tests pass.

### Task 5: Multi-media posts and platform options

**Files:**
- Modify: `native-host/VideoRadar.NativeHost/Media/MediaCatalog.cs`
- Modify: `native-host/VideoRadar.NativeHost/Media/YtDlpArguments.cs`
- Modify: `native-host/VideoRadar.NativeHost/Host/NativeHostServer.cs`
- Modify: `src/media/protocol.js`
- Modify: `src/background/media-coordinator.js`
- Modify: `src/popup/state.js`
- Modify: `src/popup/render.js`
- Modify: `test/media-coordinator.test.js`
- Modify: `test/popup-media-render.test.js`
- Modify: `native-host/VideoRadar.NativeHost.Tests/TestSuite.Formats.cs`

- [ ] **Step 1: Add collection fixture tests**

Cover Instagram carousels, TikTok slideshows, and X posts with multiple media entries. Each entry must have a stable index, type, thumbnail when available, and its own quality list.

- [ ] **Step 2: Add media selection**

Render one selectable entry per video/image item before quality selection. Pass the selected playlist/media index as a validated integer, never as a raw yt-dlp argument.

- [ ] **Step 3: Add bounded platform options**

Support TikTok slideshow images, optional original TikTok audio, and X animated-GIF conversion through explicit typed protocol fields. Default TikTok video downloads to H.264 compatibility.

- [ ] **Step 4: Run focused collection proofs**

Run:

```powershell
node --test test/media-coordinator.test.js test/popup-media-render.test.js
npm run test:native
```

Expected: all collection and native tests pass.

### Task 6: Documentation, packaging, and integrated verification

**Files:**
- Modify: `README.md`
- Modify: `docs/README.pt-BR.md`
- Modify: `PRIVACY.md`
- Modify: `SECURITY.md`
- Modify: `CHANGELOG.md`
- Modify: `package.json`
- Modify: `scripts/package-native-helper.ps1`

- [ ] **Step 1: Document supported and excluded scopes**

Document public individual videos and multi-media behavior for YouTube, TikTok, Instagram, and X. State that private, authenticated, age-restricted, DRM, and live content are not bypassed.

- [ ] **Step 2: Document maintenance behavior**

Record the bundled yt-dlp version and the safe tool-update process. Explain `EXTRACTOR_CHANGED` and that external platform changes can temporarily require an update.

- [ ] **Step 3: Run the final integrated proof**

Run:

```powershell
npm run check:all
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-native-helper.ps1
```

Expected: extension validation, JavaScript tests, native tests, and packaging all pass.

- [ ] **Step 4: Perform three metadata-only smoke checks**

Use one recent public URL from each platform. Do not download copyrighted media during automated verification. Record extractor, platform, title, number of formats, and whether authentication was requested.
