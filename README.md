# YouTube Playlist Downloader

A small Dockerized web app that downloads every video from a YouTube playlist
(or a single video) in **1080p and above**, with a live-progress web UI.

Built on [yt-dlp](https://github.com/yt-dlp/yt-dlp) + FastAPI. For 1080p+,
YouTube serves video and audio as separate streams, so the app downloads both
and merges them into a single `.mp4` using **ffmpeg** (bundled in the image).

## Features

**Fetchly** — a Next.js 16 + Tailwind v4 + shadcn (Base UI) dashboard, exported
as a static site and served by FastAPI:

- **Accueil** — paste a URL (or drag-drop / clipboard / bulk `.txt` import), see
  a metadata preview, pick quality + format, and download.
- **YouTube** — analyze a video / channel / playlist, multi-select videos to
  download, and *Watch / Suivre* a channel or playlist to auto-sync new uploads.
- **Téléchargements** — live queue with per-job progress, speed and status.
- **Réglages** — default quality/format, organization, watch interval, and more.

Quality: Auto / 1080p / 720p / 480p / Audio. Format: MP4 / MKV / MP3 / M4A.
Files are saved to a host folder (mounted volume), video merged into a
compatible container (H.264 + AAC for MP4) with a `.jpg` thumbnail.

## Architecture

- `app/` — FastAPI backend (`main.py`) + persistence (`store.py`). Serves the
  JSON API, the downloaded media at `/media`, and the built frontend at `/`.
  Key endpoints: `/api/extract` (metadata, no download), `/api/download`,
  `/api/jobs`, `/api/watches` (+ `/videos`, `/check`), `/api/settings`,
  `/api/files`.
- `frontend/` — the Next.js "Fetchly" app. `next build` with `output: "export"`
  emits a static site to `frontend/out`, copied into `app/web/` in the Docker
  build (stage 1, pnpm). The client calls the backend same-origin.
  Local dev: `cd frontend && pnpm install && pnpm dev`.

### Frontend ↔ backend notes

The UI has a few controls the (stateless) yt-dlp backend can't honor: per-item
**pause/cancel** of a running download, and per-subscription **filters**
(shorts/lives/keywords/duration). Pause/cancel surface an info toast; filters
are display-only. Everything else — previews, downloads, quality/format,
subscriptions (watches), sync, settings — is fully wired.

## Watches (auto-download new videos)

Add a playlist or channel URL under **Watched playlists & channels**. A
background scheduler re-checks each watch every *N* minutes (configurable in
Settings, default 30) and downloads anything new.

- **Download existing videos now** (checked): grabs the whole back catalogue on
  the first check, then keeps up with new uploads.
- Unchecked: records the existing videos as "already seen" without downloading,
  so you only get uploads from now on.

De-duplication uses yt-dlp's download archive at `config/download-archive.txt`,
so videos are never downloaded twice — even across restarts. Manual downloads
don't touch the archive, so you can always re-download a single video by hand.

Watches, settings and the archive live in the `./config` folder on your host.

## Run with Docker Compose (recommended)

```bash
docker compose up --build
```

Then open http://localhost:8000

Downloaded videos appear in the `./downloads` folder next to the compose file.

## Run with plain Docker

```bash
docker build -t yt-playlist-downloader .
docker run --rm -p 8000:8000 -v "${PWD}/downloads:/downloads" yt-playlist-downloader
```

On Windows PowerShell use `${PWD}`; in cmd.exe use `%cd%`.

## How it works

- `app/main.py` — FastAPI backend. Wraps the yt-dlp Python API, tracks each
  job in memory, and exposes `/api/download` and `/api/status/{id}`.
- `app/templates/index.html` — single-page UI that starts a job and polls
  status once per second.
- The format selector (e.g. `bestvideo[height<=1080]+bestaudio`) is what
  triggers the separate video/audio download and the ffmpeg merge.

## Getting past the "Sign in to confirm you're not a bot" error

YouTube blocks anonymous requests from datacenter/Docker IPs with a bot check.
The fix is to give yt-dlp the cookies from a browser where you're logged in.

1. Install a "Get cookies.txt" extension (e.g. *cookies.txt LOCALLY* for
   Chrome/Firefox), open https://www.youtube.com while logged in, and export
   cookies in **Netscape format**.
2. Save the file as `cookies.txt` inside a `cookies/` folder next to the
   compose file:

   ```
   youtube-downloader/
   ├── cookies/
   │   └── cookies.txt
   └── docker-compose.yml
   ```
3. Restart the container (`docker compose up`). The app auto-detects
   `/cookies/cookies.txt` and uses it — you'll see "Using cookies file" in the
   log.

Tip: use a throwaway/secondary Google account, and re-export if cookies expire.

## "Requested format is not available" — and how it's solved

Modern YouTube needs three things before it will hand over real video formats.
This project bakes all of them into the image / compose stack, so a plain
`docker compose up` just works — but it's worth knowing what they are, because
they're the usual failure points:

1. **An up-to-date yt-dlp.** Installed as the nightly build; YouTube breaks
   older versions constantly.
2. **A JavaScript runtime (Deno).** YouTube protects format URLs with a JS "n
   challenge" / EJS signature check. Without a JS runtime yt-dlp can only see
   storyboards and every download fails. The image bundles **Deno**, which
   yt-dlp auto-detects and uses to solve the challenge.
3. **A PO token (proof-of-origin).** YouTube gates many videos behind one. The
   compose stack runs a sidecar container, **`bgutil-provider`**, that mints
   tokens; the app is pointed at it via `POT_PROVIDER_URL`.

Plus **cookies** (see above) to clear the "confirm you're not a bot" check.

If a video still fails, the app log prints how many formats YouTube offered.
"0 formats offered" means one of the three above isn't working — check that the
`bgutil-provider` container is up (`docker compose ps`) and that you rebuilt
after the latest changes.

## Keeping it working

yt-dlp + YouTube is a moving target. If downloads start failing, rebuild to pull
the latest yt-dlp nightly and provider image:

```bash
docker compose build --no-cache && docker compose up
```

## Notes

- Jobs are tracked in memory, so progress resets if the container restarts
  (files already downloaded stay on disk).
- Downloading copyrighted content may violate YouTube's Terms of Service.
  Use this only for content you have the right to download.
