# Security policy

## Supported versions

Security fixes are applied to the latest commit on `main` and the latest
published release.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting feature:

`https://github.com/carlosesl1/videodownloader/security/advisories/new`

Include a concise description, affected component, reproduction steps and
impact. Remove credentials, signed media URLs, cookies and personal data from
the report.

Do not open a public issue for an unpatched vulnerability. You can expect an
initial acknowledgement within seven days. A fix timeline depends on severity,
reproducibility and maintainer availability.

## Security boundaries

Video Radar intentionally does not:

- bypass DRM or access controls;
- read cookies, credentials, `netrc` or browser profiles;
- accept non-HTTP(S) media URLs;
- expose a localhost service or listening socket;
- publish raw native-tool diagnostics to the extension UI.

Reports requesting these behaviors are outside the project's security and
product scope.
