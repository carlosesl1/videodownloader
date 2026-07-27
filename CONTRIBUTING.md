# Contributing to Video Radar

Thank you for helping improve Video Radar.

## Project boundaries

Contributions must preserve the project's authorized-use model. Do not add DRM
bypass, cookie extraction, authenticated-session reuse, private-content access,
credential handling or bulk downloading intended to evade platform controls.

## Development setup

1. Use Windows x64 with Node.js 20+ and the .NET 10 SDK.
2. Fork and clone the repository.
3. Create a focused branch.
4. Run the checks before opening a pull request:

   ```powershell
   npm run check:all
   ```

The repository has no runtime npm dependencies. Native helper packaging is a
separate, networked step:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-native-helper.ps1
```

## Pull requests

- Keep each pull request focused and explain user-visible behavior.
- Add or update tests for behavioral changes.
- Do not commit `dist`, `.tools`, native build outputs, downloaded binaries,
  media, secrets or private URLs.
- Document permissions, privacy or security impact when relevant.
- Test only with media you own or are authorized to download.

Bug reports should include the browser/version, media category (direct, HLS or
YouTube), expected behavior and sanitized error text. Never publish private
media URLs, tokens, cookies or credentials.
