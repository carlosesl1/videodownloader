# Changelog

All notable changes to Video Radar are documented in this file.

## Unreleased

## 1.2.0 — 2026-08-12

- Added a durable FIFO for native social downloads with one active worker, up
  to 32 non-terminal jobs and a bounded total of 64 entries including recent
  terminal history.
- Added pause/resume for queued and active native jobs. Active pauses preserve
  yt-dlp `.part` data, while resume uses `--continue --part` and cancellation
  discards the retained partial.
- Added restart reconciliation: interrupted running jobs return to the queue
  and reuse partial data when the browser next reconnects to Native Messaging;
  the helper remains on-demand and does not install a Windows service or daemon.
- Added an atomic per-job output manifest so a restart after the final move or
  during validation reuses the same reserved filename, revalidates the existing
  output and never deletes files outside that job's exact allowlist.
- Added service-worker startup recovery for active queue snapshots, restoring
  native keepalive before the popup is opened and reconciling authoritative
  state without waking the helper for terminal-only history.
- Added a final, bounded `ffprobe` gate for native downloads, validating the
  output container, expected streams, duration and size plausibility before a
  job can complete and removing rejected output files.
- Added local diagnostics with event logging disabled by default, strict
  event/error-code-only records, bounded rotation, health/tool inspection,
  explicit ZIP export and log deletion controls. URLs, cookies, media paths and
  process stderr are excluded.
- Added rich media catalogs and selection for audio-only M4A and manual or
  automatic VTT subtitles, plus available fps, HDR/dynamic range, codecs,
  bitrate, audio-language metadata and exact or approximate file size.
- Added first-class Windows ARM64 distribution alongside x64, including native
  .NET host, Deno, FFmpeg/ffprobe and yt-dlp binaries for each architecture.
- Added architecture-specific installers and developer ZIPs, PE machine checks,
  native ARM64 CI smoke tests and a fail-closed ban on silent x64 tool fallback.
- Documented the x64 Inno Setup loader used by the ARM64 installer as the sole
  emulated layer; the installed host and download tools remain native ARM64.
- Expanded the immutable tool lock, checksums, SBOM and provenance attestations
  to cover both Windows architectures.

## 1.1.0 — 2026-08-12

- Added strict public-video URL recognition for TikTok, Instagram and X/Twitter.
- Generalized yt-dlp metadata and downloads across the four supported social
  platforms while preserving quality selection, durable progress, cancellation,
  download destinations and Explorer reveal.
- Added platform-aware popup states and safe handling for public metadata whose
  availability field is omitted.
- Separated current-page results from active and recent downloads, made popup
  restoration transactional and preserved keyboard focus during live updates.
- Surfaced actionable public-platform, destination-helper and Explorer errors
  instead of silently replacing or hiding them.
- Unified social format catalog and download selection so every advertised
  quality is actually selectable by the native helper.
- Added bounded metadata caching with 30-minute YouTube and 5-minute social TTLs,
  observer-local cancellation and one safe Instagram refresh/retry for expired media URLs.
- Added HLS manifest, line, variant, segment, duration and 256 MiB assembly limits,
  real request abortion and lower-copy Blob assembly.
- Added indexed, bounded operation persistence, throttled HLS progress writes,
  alarm-based Manifest V3 maintenance and safe offscreen-document cleanup.
- Added an explicit extension-page CSP, disabled incognito operation to prevent
  cross-profile state exposure, and supplied native 16, 32 and 48 px icons.
- Added deterministic SPDX 2.3 release SBOM generation and an exact artifact
  verifier covering the installer, developer ZIP, SBOM and SHA-256 manifest.
- Hardened CI and release workflows with least-privilege jobs, immutable action
  SHAs, JavaScript/C# CodeQL scanning, provenance and SBOM attestations, and a
  second verification immediately before publication. Release promotion now
  reuses a draft idempotently and checks every remote asset digest before making
  it public; custom Inno Setup compiler paths receive the same signature and
  version validation as the managed compiler.
- Documented the current unsigned Desktop Edition separately from a future,
  policy-constrained Store Edition without claiming either code signing or a
  store listing that does not exist.

## 1.0.0 — 2026-07-27

- Added on-demand hybrid discovery for direct video and HLS playlists.
- Added compatible HLS MPEG-TS assembly with quality selection and concurrent
  segment downloads.
- Added public YouTube format discovery and durable background downloads
  through a Windows Native Messaging helper.
- Added persistent progress, cancellation and duplicate-result prevention.
- Added a unified default-folder and per-download destination workflow.
- Added Chrome, Edge, Brave and Vivaldi Native Messaging registration.
- Added pinned native-tool packaging with integrity checks and bundled
  third-party licenses.
- Added automated JavaScript and native-host tests.
- Added a per-user offline Windows installer with normal Apps & Features
  uninstall and no administrator requirement.
- Added an offline Portuguese onboarding guide for loading the stable
  `cakpfifpfmbdcilimpedanglnopnmckg` extension folder in Chromium browsers.
- Added reproducible V1 release artifacts: the installer, a transparent
  developer ZIP and `SHA256SUMS.txt`.
- Added a stable-tag GitHub Release workflow and documented the optional
  SignPath Foundation signing path without claiming unsigned builds are signed.
- Stopped in-place `yt-dlp` self-updates; pinned tool updates now arrive only
  through a new Video Radar installer.
