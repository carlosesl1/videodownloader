# Changelog

All notable changes to Video Radar are documented in this file.

## Unreleased

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
