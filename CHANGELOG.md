# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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

[0.0.1]: https://github.com/OWNER/REPO/releases/tag/v0.0.1
