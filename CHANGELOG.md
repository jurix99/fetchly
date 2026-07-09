# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- **Subscription "Exclure les Shorts / Lives" now actually apply** — these
  filters were stored only in the frontend and never reached the backend, so
  Shorts (and live streams) kept downloading regardless of the toggle. The
  flags are now persisted per watch and honoured when enumerating a channel:
  excluding Shorts skips the `/shorts` tab entirely, and excluding Lives drops
  live/upcoming/premiere entries (by `live_status`). Applied at both seed and
  sync time.

## [0.0.2] - 2026-06-22

### Added

- **Media options now actually apply** — the Settings toggles that were
  cosmetic are wired to yt-dlp: **bandwidth limit** (`ratelimit`), **subtitles**
  (download + optional embed, configurable languages), **SponsorBlock**
  (skip or mark), **embed thumbnail / metadata / chapters**, and the **download
  archive** toggle (manual downloads skip already-grabbed files). Persisted in
  config and applied on every download.
- **Disk space guard** — Settings shows the downloads volume usage and a
  **minimum free space** threshold. Below it, the backend refuses to start
  downloads (manual *and* scheduled) with a 507 and fires a one-shot
  notification, so a full disk can't silently break things. New endpoint:
  `GET /api/disk`.
- **More notification events** — besides "video downloaded", you can now be
  alerted on **failures** and get a single **playlist/batch digest** instead of
  one message per video (each toggleable in Settings → Notifications). Disk-low
  alerts reuse the same channels.
- **Jellyfin / Plex metadata** — enable *Métadonnées Jellyfin / Plex* in
  Settings and each download gets a Kodi-style `.nfo` (title, description,
  channel as studio/director, upload date, genres, tags, runtime, YouTube id,
  poster) plus a `-poster.jpg` next to the file. Read natively by Jellyfin and
  by Plex via the NFO agent, so your downloads show up as proper library items.
  Applies to new downloads.

- **Download notifications** — get alerted whenever a video finishes
  downloading, on any channel supported by [Apprise](https://github.com/caronc/apprise)
  (Discord, Telegram, email, ntfy/Pushover push, SMS, …). Configure one or more
  service URLs in **Settings → Notifications**, with a **Test** button. New
  endpoints: `GET/POST /api/notifications`, `POST /api/notifications/test`.
- **Cookie management from the UI** — paste a `cookies.txt` in **Settings →
  Cookies YouTube** (no volume remount or container restart). Cookies are stored
  in the writable `/config` volume and **auto-refreshed**: yt-dlp's rotated jar
  is written back after each run, so the session stays alive far longer and you
  rarely have to re-deposit cookies. A legacy `/cookies/cookies.txt` mount is
  imported automatically. New endpoints: `GET/POST/DELETE /api/cookies`.
- **"Mon YouTube"** — one-click access, in the Explorer tab, to your signed-in
  account's own lists: **À regarder plus tard** (Watch Later), **vidéos likées**
  and **abonnements** (recent uploads). No URL to paste — they resolve through
  your stored cookies and feed the existing preview / download / follow flow.
  - **Follow Watch Later / Liked** ("Suivre") — creates a subscription so new
    items added to the list auto-download (future-only by default; use "Voir" to
    grab the current contents).
  - **Pick subscriptions to follow** ("Choisir…") — a dialog lists every channel
    you're subscribed to on YouTube (with avatars + name filter); tick the ones
    you want and follow them in one go. Each becomes its own watch,
    future-uploads-only, so new videos sync without a massive back-catalogue
    download. Already-followed channels are shown as such. New endpoints:
    `GET /api/youtube/subscriptions`, `POST /api/youtube/subscriptions/follow`.
    The unbounded ":ytsubscriptions" preview is now capped (`limit` on
    `/api/extract`) so it can't paginate forever.

Also in this release — search, an interactive channel browser, 4K, parallel
subscription downloads, and first-class NAS deployment:

**Discovery & channels**
- **Search by name** — find creators and videos without knowing a URL; results
  are split into Chaînes and Vidéos.
- **Channel dialog** — picking a channel opens its real logo + stats and a
  video list that loads **lazily on scroll** (nothing fetched up front), with a
  per-video download button and a **Suivre** action.
- Real channel logos in search results (fetched in the background).

**Downloading**
- **2160p (4K)** and **1440p** quality options (VP9/AV1 + AAC, merged to MP4).
- Thumbnails now shown in the Téléchargements list.

**Subscriptions**
- Choose what to grab when following: **only future uploads**, the **entire
  back-catalogue**, or **from a chosen date** — editable later in the filters.
- **Parallel backfill** — a subscription downloads several videos at once, up to
  a configurable **max concurrent**, each shown live with its own progress.
- Subscriptions show the channel name + logo immediately and surface live
  backfill progress on the card.

**NAS deployment**
- LinuxServer-style **PUID / PGID / TZ / UMASK**: runs unprivileged via `gosu`
  so downloads are owned by your NAS user, not root.
- Container **healthcheck**, configurable `DOWNLOAD_DIR` / `CONFIG_DIR`.
- Optional **build-time CA trust** (drop a `*.crt` in `certs/`) for building
  behind a corporate TLS proxy; a no-op (clean image) otherwise.

### Changed
- Watch checks are **much faster**: flat channel listing instead of
  deep-extracting every video.
- Channels enumerate their real **videos (and Shorts)**, not the channel tabs.
- Default container port is now **6776**.

### Fixed
- Duplicate subscriptions for the same channel are rejected (they downloaded the
  same videos twice and clobbered each other's files).
- Picking one video in a channel list no longer selects them all.
- The merge/convert phase is shown correctly instead of jumping to "Terminé".

## [0.0.1] - 2026-06-16

First release — a self-hosted video downloader built on
[yt-dlp](https://github.com/yt-dlp/yt-dlp), with a web UI and automatic
subscriptions. Runs as a single Docker image (plus a PO-token sidecar).

### Added

**Downloading**
- Paste a video, playlist or channel URL and download it; metadata preview
  before downloading.
- Quality: Auto / 1080p / 720p / 480p / Audio. Format: MP4 / MKV / MP3 / M4A.
- Video + audio downloaded separately and merged with ffmpeg; H.264 + AAC for
  MP4 so it plays everywhere with sound.
- Live progress with a distinct **processing/merge** phase, speed and status.
- Per-download destination subfolder; organize by playlist/channel, uploader,
  or flat.

**Subscriptions (watches)**
- Follow channels and playlists; new uploads download automatically on a
  schedule.
- Per-watch **sync memory**: the full video list with synced / pending markers.
- Optional **"sync from date"** to avoid pulling years of backlog.
- yt-dlp download archive so nothing is ever downloaded twice, across restarts.

**Reliability for current YouTube**
- Latest yt-dlp nightly, **Deno** (solves the n-challenge / EJS), and a
  **bgutil PO-token** sidecar — the combination needed to download modern,
  gated YouTube videos. Cookie support for the bot check.
- Per-watch lock to prevent concurrent downloads of the same playlist.
- Startup cleanup of leftover `.part` fragments from interrupted downloads.

**Frontend**
- "Fetchly" dashboard: Next.js 16 + Tailwind v4 + shadcn (Base UI), exported as
  a static site and served by the FastAPI backend (single container).

### Notes
- The stateless backend does not support pausing/cancelling a running download
  or per-subscription content filters; those controls are informational only.

[0.0.2]: https://github.com/OWNER/REPO/releases/tag/v0.0.2
[0.0.1]: https://github.com/OWNER/REPO/releases/tag/v0.0.1
