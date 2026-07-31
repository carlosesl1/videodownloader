# Video Radar V1 friend-and-family distribution design

**Date:** 2026-07-31

**Status:** Approved in conversation; formalized before implementation
**Target:** Windows x64, Chrome, Edge, Brave and Vivaldi

## Goal

Ship Video Radar V1 as an open-source, friend-and-family release that does not
depend on a browser store and does not ask the recipient to run PowerShell,
compile .NET code or understand the native helper.

The normal recipient downloads one versioned installer, completes a per-user
Windows installation, and follows a short visual guide for the one browser step
that cannot be automated legitimately: enabling Developer mode and choosing
**Load unpacked**.

## Constraints

- The extension remains outside Chrome Web Store and Microsoft Edge Add-ons.
- Consumer Chrome installations cannot be silently provisioned with a
  self-hosted extension. The installer must not write enterprise extension
  policies or make the browser appear managed.
- Native Messaging requires a helper manifest and per-browser HKCU registry
  entries.
- Installation must not require administrator rights.
- The stable extension ID derived from `manifest.key` remains
  `cakpfifpfmbdcilimpedanglnopnmckg`.
- Existing direct, HLS and public social-media behavior remains unchanged.
- The current dirty worktree contains product work owned by the user. Release
  changes must preserve it and must not revert or rewrite unrelated files.
- The release may initially be unsigned. The build and documentation must be
  ready for later SignPath Foundation integration without changing the user
  installation contract.

## Considered approaches

### A. Offline Inno Setup installer — selected

Produce one versioned `VideoRadar-Setup-<version>-Windows-x64.exe` containing the
extension, native host, pinned tools and required licenses.

Advantages:

- one obvious download and a familiar Windows wizard;
- built-in per-user installation and uninstallation;
- one artifact can later receive an Authenticode signature;
- no first-run dependency download;
- works without administrator rights or a browser store.

Trade-offs:

- the installer is large because FFmpeg, Deno and yt-dlp are bundled;
- every tool update requires a new Video Radar release;
- the first installation can still trigger SmartScreen while unsigned.

### B. Small online bootstrapper

Download tools after the setup program starts.

Advantages: small initial download and replaceable dependencies.

Trade-offs: more failure modes, more antivirus scrutiny, a new update/security
protocol and worse offline reliability. This is deferred until demand justifies
the additional complexity.

### C. ZIP plus CMD/PowerShell

Keep the current package and ask recipients to extract it, run the CMD file and
load the source directory.

Advantages: minimal engineering.

Trade-offs: no normal uninstall entry, ambiguous folder selection, multiple
manual steps and poor friend-and-family usability. It remains a developer
fallback, not the V1 primary release.

## Release contents

The release pipeline produces:

- `VideoRadar-Setup-1.0.0-Windows-x64.exe` — primary recipient download;
- `VideoRadar-1.0.0-Developer.zip` — transparent developer/manual fallback;
- `SHA256SUMS.txt` — SHA-256 for every distributed artifact;
- GitHub's source archives and release notes.

The offline installer contains only:

- extension production files rooted at `manifest.json`;
- `video-radar-host.exe`;
- pinned `yt-dlp.exe`, `deno.exe`, `ffmpeg.exe` and `ffprobe.exe`;
- the third-party license files already validated by the native-tool lock;
- the local onboarding page and V1 legal/support documents.

Tests, fixtures, Git metadata, `.tools`, existing `dist` output and development
plans are never included in the installed extension.

## Installation contract

The setup wizard:

1. installs per user under `%LOCALAPPDATA%\VideoRadar`;
2. places the unpacked extension at `%LOCALAPPDATA%\VideoRadar\Extension`;
3. places the native helper under `%LOCALAPPDATA%\VideoRadar\host`;
4. writes `native-host\com.videoradar.helper.json` with the installed absolute
   host path and exactly one allowed extension origin;
5. registers that manifest in HKCU for Chrome, Edge, Brave and Vivaldi;
6. runs `video-radar-host.exe --ping` and fails the installation if the
   packaged host or tools are incomplete;
7. adds a normal per-user uninstall entry;
8. opens a local Portuguese onboarding page and the installed Extension folder.

The onboarding page explains, with numbered visuals:

1. open the browser's extensions page;
2. enable Developer mode;
3. choose **Load unpacked**;
4. select the already-open `Extension` folder;
5. pin Video Radar and click **Buscar vídeos**.

It also explains the unavoidable Developer mode warning, supported browsers,
authorized-use boundary, helper diagnosis and complete uninstall route.

## Upgrade and uninstall

V1 has no silent updater.

An upgrade is another run of the newer installer. The install path and extension
ID stay stable, so the recipient does not select the folder again. The
onboarding explains that the browser may require **Reload** on its extensions
page after an update.

The installer performs a normal in-place upgrade and preserves extension local
storage and completed media. It replaces program files but does not delete user
downloads.

Uninstall removes:

- the installed Video Radar program files;
- the four Video Radar Native Messaging registry entries;
- the helper manifest and local onboarding files.

The browser extension is removed separately by the user because the installer
must not manipulate browser-managed extension state. Finished videos are never
deleted.

## Tool updates and supply chain

V1 release artifacts use the versions and hashes in
`native-host/tool-lock.json`. Packaging revalidates every tool and license.

The installed helper must not mutate its bundled `yt-dlp.exe` with `yt-dlp -U`.
Tool updates are delivered only through a new versioned Video Radar installer.
This keeps a release reproducible and prevents the installed binary set from
drifting beyond the published hashes.

The GitHub release workflow:

1. runs the full JavaScript and native-host checks;
2. validates that the Git tag, package version and manifest version agree;
3. obtains only the pinned official tool artifacts;
4. builds the native helper and V1 payload;
5. compiles the installer;
6. validates its embedded version and installed payload contract;
7. creates the developer ZIP and checksum file;
8. uploads artifacts to the workflow;
9. publishes a GitHub Release only for an explicit stable `v*` tag.

Signing is optional in the local build. A documented signing hook allows
SignPath Foundation to sign the final installer after the project is accepted.

## Error handling

- Package or hash mismatch: stop before compiling or installing.
- Missing Inno Setup compiler: print one actionable build requirement; never
  silently install machine-global software.
- Existing installation: use the installer's upgrade flow.
- Ping failure: fail installation and retain enough diagnostics for support.
- Registry failure: installation fails and Inno Setup rolls back registered
  entries and files.
- Onboarding launch failure: installation still succeeds and exposes a Start
  Menu shortcut named **Como instalar no navegador**.
- Unsupported OS or architecture: block before copying files.

## Testing

Automated tests cover:

- exact release allowlist and exclusion of development files;
- agreement between manifest, package and tag versions;
- stable extension ID and Native Messaging origin;
- per-user/no-admin Inno Setup contract;
- all four HKCU Native Messaging registrations;
- uninstall cleanup declarations;
- onboarding presence and required browser instructions;
- absence of installed `yt-dlp -U` behavior;
- deterministic artifact names and SHA-256 output;
- existing extension and native-host test suites.

Packaging verification additionally:

- compiles a real installer;
- extracts or inspects the compiled setup to confirm required payload entries;
- runs the packaged host `--ping`;
- performs a reversible installation into an isolated test profile when the
  installer runner supports directory and registry overrides;
- otherwise records that real interactive Windows installation remains a
  manual release-gate item.

## V1 acceptance criteria

- A recipient-facing release has one primary `.exe` download.
- No recipient command line or PowerShell step is required.
- Installation is per-user and requests no elevation.
- The helper works for the stable extension ID on all four supported browsers.
- The installed Extension folder is immediately visible after setup.
- The local guide makes the remaining browser step understandable without
  project knowledge.
- Apps & Features can uninstall the helper and remove its registry entries.
- The full automated check passes after the final change.
- The release bundle contains hashes, licenses, privacy policy, security policy
  and source/repository links.
- Any unsigned/SmartScreen and real-browser limitations are stated plainly in
  the release notes.
