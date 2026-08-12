# Privacy policy

Last updated: July 29, 2026

Video Radar is designed to operate locally and on demand. It has no project
account, telemetry, analytics, advertising or maintainer-operated backend.

## Data handled locally

When the user clicks **Search videos**, the extension may inspect the active
page's `<video>` and `<source>` elements and its browser-exposed performance
resource entries. It stores local snapshots of detected items, download
preferences, bounded recent operation results and active-job progress so the
popup can be closed and reopened and Manifest V3 work can be reconciled after a
service-worker restart.

The Windows native host receives only the command data required to perform the
requested operation, such as a public media URL, selected quality, filename or
destination folder. Public metadata is cached only in the helper's memory for
up to 30 minutes for YouTube and 5 minutes for TikTok, Instagram and X. It
communicates with the extension through Native Messaging over `stdio`.

## Network requests

Video Radar connects only as needed to:

- the media servers referenced by the page, for authorized direct/HLS
  downloads;
- public YouTube, TikTok, Instagram and X endpoints through `yt-dlp`, for
  authorized public-media metadata and downloads;
- official release sources only while a maintainer packages the native helper.

Bundled tools are pinned to published SHA-256 hashes and are replaced only by a
new Video Radar installer. The installed helper does not run `yt-dlp -U` or
silently mutate its executable set.

The project maintainer does not receive these requests or their contents.

## Data not collected

Video Radar does not collect or transmit browsing history, download history,
cookies, credentials, browser-profile data, personal identifiers or usage
analytics to the maintainer. It does not use `netrc` or authenticated browser
sessions.

## Permissions

- `activeTab` and optional site access: inspect only the current page after an
  explicit user action.
- `alarms`: wake the Manifest V3 service worker for local cleanup and operation
  reconciliation; no data is sent by an alarm.
- `downloads`: create and manage requested browser downloads.
- `nativeMessaging`: communicate with the installed Windows helper.
- `notifications`: report completion or failure.
- `offscreen`: assemble compatible HLS media.
- `scripting`: run the on-demand page scan.
- `storage`: preserve settings and job state locally.

## Retention and deletion

Local extension data can be removed by uninstalling the extension or clearing
its site/extension data in the browser. Native-helper files can be removed by
following the uninstall instructions in the Portuguese documentation. Finished
media remains wherever the user chose to save it.

## Questions

Open a public GitHub discussion or issue for general privacy questions. Do not
include private URLs, credentials or personal media details. Report sensitive
security concerns through GitHub's private vulnerability reporting flow.
