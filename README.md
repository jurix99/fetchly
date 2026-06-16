# Fetchly

A self-hosted **video downloader** with a web UI. Paste a link from YouTube — or
[any of the 1000+ sites yt-dlp supports](https://github.com/yt-dlp/yt-dlp) such
as france.tv, Vimeo, Dailymotion — and download it in the quality and format you
want. Follow channels and playlists to **auto-download new uploads**.

Runs as a single Docker image (plus a small PO-token sidecar). Built on
[yt-dlp](https://github.com/yt-dlp/yt-dlp) + FastAPI, with a Next.js dashboard.

## Features

- **Download** — paste a video / playlist / channel URL, preview the metadata,
  pick quality + format, and go. Drag-drop, clipboard detection and bulk `.txt`
  import too.
- **Quality**: Auto / 1080p / 720p / 480p / Audio. **Format**: MP4 / MKV / MP3 /
  M4A. Video and audio are downloaded separately and merged with ffmpeg
  (H.264 + AAC for MP4, so it plays everywhere with sound), with a `.jpg`
  thumbnail.
- **Subscriptions** — follow channels/playlists; a scheduler checks them and
  downloads new uploads automatically. Each shows a **sync memory** (which
  videos are downloaded vs pending) and an optional **"sync from date"** so you
  don't pull years of backlog. yt-dlp's download archive means nothing is ever
  fetched twice, even across restarts.
- **Live progress** — a queue with per-job progress, speed, and a distinct
  **merge/conversion** phase.
- **Organize** — choose where files land (by playlist/channel, by uploader, or
  flat) and an optional per-download subfolder.

## Quick start

```bash
docker compose up --build
```

Then open **http://localhost:8000**. Downloaded files appear in `./downloads`
next to the compose file; settings and the subscription list live in `./config`.

### Pull the prebuilt image

Published to GitHub Container Registry by CI:

```bash
docker pull ghcr.io/<owner>/fetchly:0.0.1   # or :latest
```

## Getting past YouTube's defenses

Modern YouTube needs several things before it hands over real video formats.
**They're all baked into the image / compose stack**, so a plain
`docker compose up` just works — but here's what they are, since they're the
usual failure points:

1. **Up-to-date yt-dlp** — installed as the nightly build (YouTube breaks older
   versions constantly).
2. **A JavaScript runtime (Deno)** — solves YouTube's "n challenge" / EJS
   signature check. Without it, only storyboards come back and every download
   fails. The image bundles Deno.
3. **A PO token** — YouTube gates many videos behind a proof-of-origin token.
   The compose stack runs the **`bgutil-provider`** sidecar that mints them.
4. **Cookies** *(optional but recommended)* — clears the "Sign in to confirm
   you're not a bot" check from datacenter/Docker IPs.

### Adding cookies

1. With a browser logged into YouTube, use a "Get cookies.txt" extension
   (e.g. *cookies.txt LOCALLY*) and export cookies in **Netscape format**.
2. Save it as `cookies/cookies.txt` next to the compose file.
3. `docker compose up` — the app auto-detects it (you'll see "Using cookies
   file" in the log).

Tip: use a throwaway/secondary Google account; re-export when cookies expire.

If a download still fails, the job log prints how many formats YouTube offered.
"0 formats offered" means one of the four above isn't working — check that the
`bgutil-provider` container is up (`docker compose ps`).

## Keeping it working

yt-dlp + YouTube is a moving target. If downloads start failing, rebuild to pull
the latest yt-dlp nightly and provider image:

```bash
docker compose build --no-cache && docker compose up
```

## Architecture

- **`app/`** — FastAPI backend (`main.py`) + persistence (`store.py`). Serves
  the JSON API, the downloaded media at `/media`, and the built frontend at `/`.
  Key endpoints: `/api/extract` (metadata, no download), `/api/download`,
  `/api/jobs`, `/api/watches` (+ `/videos`, `/check`), `/api/settings`,
  `/api/files`.
- **`frontend/`** — the Next.js 16 + Tailwind v4 + shadcn (Base UI) dashboard.
  `next build` (`output: "export"`) produces a static site that the Docker build
  copies into `app/web/`; the client calls the backend same-origin. No Node
  runtime in production. Local dev: `cd frontend && pnpm install && pnpm dev`.
- **CI** — [`.github/workflows/docker-release.yml`](.github/workflows/docker-release.yml)
  builds the image, publishes `ghcr.io/<owner>/fetchly`, and cuts a GitHub
  Release from `CHANGELOG.md` when a `v*.*.*` tag is pushed.

### Frontend ↔ backend limits

The stateless yt-dlp backend can't honor a couple of UI controls: per-item
**pause/cancel** of a running download, and per-subscription **filters**
(shorts/lives/keywords/duration). Pause/cancel surface an info toast; filters
are display-only. Everything else is fully wired.

## Notes

- Job progress is tracked in memory, so it resets if the container restarts —
  files already on disk are kept, and leftover `.part` fragments from
  interrupted downloads are cleaned up on startup.
- Only download content you have the right to download; doing otherwise may
  violate a site's Terms of Service.
