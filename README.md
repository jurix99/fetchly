# Fetchly

A self-hosted **video downloader** with a web UI. Paste a link from YouTube — or
[any of the 1000+ sites yt-dlp supports](https://github.com/yt-dlp/yt-dlp)
(france.tv, Vimeo, Dailymotion…) — and download it in the quality and format you
want. Follow channels, playlists, or your YouTube **Watch Later / subscriptions**
to auto-download new uploads straight to your NAS.

Built on [yt-dlp](https://github.com/yt-dlp/yt-dlp) + FastAPI with a Next.js
dashboard. Ships as a single Docker image plus a small PO-token sidecar.

## Features

- **Download** any video / playlist / channel URL — preview, pick quality
  (Auto→4K, or audio-only) and format (MP4 / MKV / MP3 / M4A), and go.
- **Subscriptions** — follow channels/playlists; a scheduler auto-downloads new
  uploads, skipping anything already grabbed.
- **Mon YouTube** — connect your account (cookies) to grab your **Watch Later**,
  **liked videos** and **subscriptions** in one click.
- **Notifications** on finish / failure (Discord, Telegram, email, ntfy… via
  [Apprise](https://github.com/caronc/apprise)).
- **Jellyfin / Plex** metadata (`.nfo` + poster) and flexible file organization.
- **Disk guard**, bandwidth limit, subtitles, SponsorBlock, and more in Settings.

## Setup

The PO-token sidecar (`bgutil-provider`) is **required** — YouTube gates most
videos behind a proof-of-origin token it mints. Everything else (current yt-dlp,
the Deno JS runtime) is baked into the image, so it just works.

### Docker Compose (recommended)

```bash
git clone <repo-url> fetchly && cd fetchly
docker compose up -d
```

Open **http://localhost:6776**.

Created next to the compose file:

| Path           | Holds                                                |
| -------------- | ---------------------------------------------------- |
| `./downloads`  | your downloaded videos                               |
| `./config`     | settings, subscriptions, cookies, download archive   |

In `docker-compose.yml`, set `PUID` / `PGID` / `TZ` to your NAS user and zone so
files aren't owned by root.

### Plain Docker

Run the sidecar and the app on a shared network:

```bash
docker network create fetchly

docker run -d --name bgutil-provider --network fetchly --restart unless-stopped \
  brainicism/bgutil-ytdlp-pot-provider:latest

docker run -d --name fetchly --network fetchly -p 6776:6776 --restart unless-stopped \
  -v "$PWD/downloads:/downloads" \
  -v "$PWD/config:/config" \
  -e PUID=1000 -e PGID=1000 -e TZ=Europe/Paris \
  -e POT_PROVIDER_URL=http://bgutil-provider:4416 \
  ghcr.io/<owner>/fetchly:latest
```

Then open **http://localhost:6776**.

## Cookies (recommended for YouTube)

Some videos need a logged-in session. Export a `cookies.txt` (Netscape format)
from a browser with a "Get cookies.txt" extension, then paste it in **Settings →
Cookies YouTube** — no restart needed. Cookies are stored in `/config` and
auto-refreshed, so you rarely re-deposit them. They also unlock **Mon YouTube**
(Watch Later / liked / subscriptions) and clear the "confirm you're not a bot"
check. Tip: use a throwaway Google account.

## Security & exposure

Fetchly is a **trusted-LAN, single-user** app: it ships with **no authentication
and no CORS restrictions**, and the API can delete library entries and stream any
downloaded file (`DELETE /api/library/{id}`, `GET /api/library/{id}/stream`).

- **Do not expose it directly to the internet.** Put it behind a reverse proxy
  (Caddy, Nginx, Traefik…) that adds TLS **and** authentication (basic auth, an
  SSO/forward-auth, or a VPN like Tailscale/WireGuard). Keep the container bound
  to your LAN / a private network.
- Model downloads (Whisper / embeddings) verify TLS by default. On a network with
  a TLS-intercepting proxy you can opt in to relaxed verification **for the
  download only** with `insecure_model_download` (config) or
  `FETCHLY_INSECURE_MODEL_DOWNLOAD=1` — leave it **off** otherwise.

## Development

```bash
pip install -r requirements-dev.txt
pytest            # pure-function + DB-integrity tests (no network, no models)
```

## Notes

- yt-dlp + YouTube is a moving target. If downloads start failing, rebuild to
  pull the latest yt-dlp: `docker compose build --no-cache && docker compose up -d`.
- Only download content you have the right to download.
