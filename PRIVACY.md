# Privacy policy

Last updated: August 12, 2026

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

For restart recovery, native social-download jobs are stored locally under the
current Windows user's `%LOCALAPPDATA%\VideoRadar\download-queue` directory.
An entry can include the public URL, selected media/subtitle options,
destination, job identifiers, progress, result path and a bounded error code.
The queue allows at most 32 non-terminal jobs and 64 entries in total; the
oldest terminal entries are pruned when space is needed. It is not synchronized
to an account or project server. After Windows restarts, processing resumes only
when a compatible browser starts and reconnects the on-demand native helper.
Video Radar does not install a background service or daemon.

## Optional local diagnostics

Diagnostic event logging is disabled by default and requires explicit opt-in in
**Configure downloads**. When enabled, each structured record contains only a
UTC timestamp, a code-controlled event name and, when applicable, a bounded
error code. Raw URLs, cookies, credentials, media or destination paths, command
lines, browser-profile data and process stdout/stderr are never accepted as log
fields. Local rotation keeps at most eight event files of 256 KiB each.

The health summary can be viewed without enabling event logs. It reports the
host/protocol version, operating system and process architecture, available
space on the selected download volume, and the availability, version and size
of bundled tools. A diagnostic ZIP is created only after the user selects
**Export** and chooses a destination. The export adds tool SHA-256 hashes, a
privacy notice and any existing bounded event logs. It is not uploaded by Video
Radar and remains in the chosen folder until the user deletes it.

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
analytics to the maintainer. The native helper and HLS fetches do not use
`netrc`, browser profiles or authenticated sessions. A direct download is
delegated to Chromium's downloads API, whose network request can follow the
browser's normal cookie semantics; the extension does not read or receive those
cookies.

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
its site/extension data in the browser. Diagnostic event files can be deleted
from **Configure downloads**; disabling logging prevents new records but does
not delete existing ones. Because the durable queue, diagnostic settings and
logs are user-generated data, a normal helper uninstall may leave them under
`%LOCALAPPDATA%\VideoRadar`. Follow the manual cleanup instructions in the
Portuguese documentation to remove that directory after confirming no partial
download or exported report is still needed. Finished media and diagnostic ZIPs
outside that directory remain wherever the user chose to save them.

## Questions

Open a public GitHub discussion or issue for general privacy questions. Do not
include private URLs, credentials or personal media details. Report sensitive
security concerns through GitHub's private vulnerability reporting flow.
