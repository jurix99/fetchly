# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-06-17

Search, an interactive channel browser, 4K, parallel subscription downloads, and
first-class NAS deployment.

### Added

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

[0.1.0]: https://github.com/OWNER/REPO/releases/tag/v0.1.0
[0.0.1]: https://github.com/OWNER/REPO/releases/tag/v0.0.1
