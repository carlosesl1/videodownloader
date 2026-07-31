# Video Radar

[![CI](https://github.com/carlosesl1/videodownloader/actions/workflows/ci.yml/badge.svg)](https://github.com/carlosesl1/videodownloader/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Platform: Windows](https://img.shields.io/badge/platform-Windows-0078D4.svg)](#requirements)

Video Radar is an open-source, on-demand video detector and downloader for
Chromium-based browsers. It finds direct media (`.mp4`, `.webm`, `.mov`), HLS
playlists (`.m3u8`) and public YouTube, TikTok, Instagram and X videos, while requesting access only
when the user explicitly clicks **Buscar vídeos** ("Search videos").

> Use Video Radar only with media you own, public-domain/openly licensed media,
> or content you are explicitly authorized to download. The project does not
> bypass DRM, authentication, private content or access restrictions.

[Documentação completa em português](docs/README.pt-BR.md)

![Video Radar showing detected direct-video results](docs/verification/assets/popup-resultados-diretos.png)

## Why Video Radar

- **On-demand access:** no continuous page or network monitoring.
- **Hybrid detection:** combines `<video>`/`<source>` elements with
  `PerformanceResourceTiming`.
- **Direct and HLS media:** downloads direct files and assembles compatible HLS
  MPEG-TS segments with up to eight concurrent requests and a 256 MiB safety cap.
- **Quality selection:** exposes HLS variants and public social-video formats when
  available.
- **Durable discovery:** an in-progress scan, its results, inspected HLS
  variants and the selected quality are restored when the popup reopens.
- **Clear recovery:** current-page results stay separate from active and recent
  downloads, whose status survives popup and service-worker restarts.
- **Unified destinations:** use a default Windows folder or ask where each
  download should be saved.
- **Privacy by design:** no telemetry, analytics, accounts, cookies or browser
  profile access.
- **Chromium coverage:** Chrome, Edge, Brave and Vivaldi.

## Architecture

| Component | Responsibility |
| --- | --- |
| Manifest V3 extension | User interface, on-demand page scanning and browser downloads |
| Offscreen document | HLS fetching and MPEG-TS assembly |
| Windows native host | Folder picker, durable social-video jobs and final file delivery |
| Pinned tools | `yt-dlp`, Deno and FFmpeg artifacts verified by SHA-256 during packaging |

The native host communicates through Chromium Native Messaging over `stdio`.
It does not start a localhost server, open a listening socket or send usage data
to the project maintainer.

## Requirements

- Windows 10 or Windows 11, x64
- Chrome, Edge, Brave or Vivaldi based on Chromium 116+
- Internet access while downloading authorized media

## Install the V1 release

1. Open [GitHub Releases](https://github.com/carlosesl1/videodownloader/releases)
   and download `VideoRadar-Setup-1.0.0-Windows-x64.exe`.
2. Run the installer. It installs only for the current Windows user, does not
   request administrator access and does not require PowerShell, .NET or npm.
3. Follow the local guide opened at the end: enable Developer mode, choose
   **Load unpacked** (**Carregar sem compactação**) and select the already-open
   `%LOCALAPPDATA%\VideoRadar\Extension` folder.
4. Confirm the extension ID is `cakpfifpfmbdcilimpedanglnopnmckg`, pin Video
   Radar and click **Buscar vídeos**.

The browser step stays manual because Video Radar is not published in a browser
store and does not apply enterprise policies. An unsigned V1 installer may show
a Windows SmartScreen warning; compare its SHA-256 with `SHA256SUMS.txt` on the
same release.

## Build from source

Maintainers need PowerShell, Node.js 22 and internet access while packaging the
native helper.

1. Clone the repository and enter its root directory.
2. Build the distributable native helper:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-native-helper.ps1
   ```

   The first build downloads the exact artifacts recorded in
   `native-host/tool-lock.json`. The generated package is stored in
   `dist\video-radar-helper` and is intentionally excluded from Git.
3. Open `chrome://extensions`, `edge://extensions`, `brave://extensions` or
   `vivaldi://extensions`, enable developer mode and load the **repository
   root** as an unpacked extension (**Carregar sem compactação**). Do not load
   `dist`.
4. Run `dist\video-radar-helper\Instalar-Video-Radar.cmd`.
5. Reload the extension. Its expected stable ID is
   `cakpfifpfmbdcilimpedanglnopnmckg`.

The root-level `Instalar-Video-Radar.cmd` is not the packaged installer. Run the
copy located inside `dist\video-radar-helper`.

## Use

1. Open a page containing authorized media.
2. Open Video Radar and click **Buscar vídeos** ("Search videos").
3. Choose an available quality and start the download.
4. Open **Configurar downloads** ("Configure downloads") to choose a default
   Windows folder or enable **Perguntar onde salvar cada download** ("Ask where
   to save each download").

Direct files use the browser download manager. Compatible HLS streams are
assembled as `.ts`, with a 256 MiB in-memory safety limit. Public YouTube,
TikTok, Instagram and X jobs use the native helper and preserve their status
while the popup or extension service worker is inactive. Current-page findings
and recent downloads are shown separately. Public metadata is cached in memory
for up to 30 minutes for YouTube and 5 minutes for the other social platforms;
expired Instagram media metadata may be refreshed and retried once. Use
**Cancelar** to stop an active job. Automatic direct/HLS delivery temporarily
uses `Downloads\Video Radar\.staging`.

To uninstall completely, remove **Video Radar** in Windows Apps & Features and
then remove the unpacked extension from each browser. Finished videos are never
deleted. The developer-package cleanup commands remain in the
[Portuguese documentation](docs/README.pt-BR.md#desinstalação).

## Development

The regular test suite is offline:

```powershell
npm run check
npm run check:all
```

`check:all` validates the extension, runs the JavaScript tests and runs the
native-host test executable. Packaging is separate because it may download
pinned third-party artifacts. See [docs/RELEASING.md](docs/RELEASING.md) for
the installer, checksums, signing and stable-tag workflow.

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) and
[PRIVACY.md](PRIVACY.md) before contributing or reporting a problem.

## Known boundaries

- No DRM, private, authenticated, age-restricted or live-content bypass.
- No cookies, credentials, `netrc` or browser-profile access.
- No bulk playlist downloading; individual YouTube Shorts and public social-video posts are supported.
- HLS support currently targets MPEG-TS output; incompatible fragmented MP4
  playlists are rejected safely.
- Social-platform behavior depends on public formats supported by `yt-dlp` and
  may temporarily require a new Video Radar installer when a platform changes.

## License

Video Radar is available under the [MIT License](LICENSE). Bundled or downloaded
third-party tools retain their own licenses, which are included in generated
native-helper packages.
