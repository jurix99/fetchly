# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.0.5] - 2026-07-12

Phase 3 (opening) — Fetchly's north-star made real: **find a phrase you heard in
5 seconds, from anywhere.** Global search becomes omnipresent (Cmd/Ctrl+K), drops
you on the exact second, and the Library steps up as the app's home. The first
crossing of the memory appears — contents that echo one another.

### Added

- **Omnipresent search (Cmd/Ctrl+K)** — a command palette reachable from every
  view: live results (250 ms debounce, stale requests cancelled), full keyboard
  control (↑/↓, Enter to open, Esc to close and restore focus), each result
  showing thumbnail, title, channel and its best timestamped passage. Enter opens
  the content at the exact second (2 s recall for context). The top-bar carries a
  persistent search field with the shortcut shown in a `kbd`; the palette (and the
  whole search stack) is **lazy-loaded** so the top-bar stays light.
- **Full results page** (`/?q=…`) for exploration beyond the palette: header with
  the query, result count and response time ("23 résultats · 41 ms" — speed is a
  product argument, so it's shown), one card per content with up to 3 passages
  (clickable `m:ss` + snippet with matched terms highlighted from API offsets), a
  discreet **« correspondance de sens »** badge on semantic matches (tooltip:
  found by similarity, not exact words), a foldable "voir les N autres passages"
  per content, and light side filters (source, channel, period, duration).
  Pedagogical states for zero results and a partial/empty index, with the real
  numbers (indexed / total) and a CTA toward transcription.
- **Perfect jump-to-second** — opening a result seeks the player to start − 2 s,
  plays, switches to the Transcript, scrolls to the matching segment and pulses it
  for 2 s — the same highlight language as in-transcript search.
- **Library as home** — `/` opens the **Bibliothèque** when it holds at least one
  content (else the onboarding Home, still reachable). Composable header sections:
  **Reprendre** (the 3 last-played contents, resumed at the remembered position)
  and **Ajouts récents** (last 7 days) — structured so a future "Digest" slots in
  above without a rewrite.
- **Related contents** — on a content page, a **« Dans votre bibliothèque »**
  section lists 3–5 close contents (compact card + discreet proximity score); for
  the closest, the best **"this moment ↔ that moment"** passage pair, each
  timestamp clickable (one seeks the current player, the other opens the target at
  its second). Hidden when there are fewer than 2 indexed contents or nothing above
  the similarity floor — never a disappointing empty section.
  `GET /api/library/{id}/related` (mean of the top-3 chunk-pair cosine
  similarities, same-`source_id` dedup, cached per content and invalidated when
  either side is re-indexed).
- **North-star instrumentation (local only)** — a `search_events` table records
  each search and whether it led to opening a passage; Settings shows a
  **« Votre mémoire travaille : N retrouvailles cette semaine »** card. No outbound
  telemetry — usage metrics never leave your own database.
  `POST /api/search/feedback`, `GET /api/search/metrics`.

### Changed

- **`GET /api/search`** gains passage pagination per content (`passage_limit` +
  `passage_total`), facet filters (`source`, `channel`, `period`, `min/max_duration`)
  and explicit **highlight offsets**, and returns index-coverage context
  (`indexed` / `total` / `semantic`) so the UI can render the pedagogical states in
  a single round-trip.

### Notes

- "Reprendre" positions are stored client-side (localStorage) — no schema change,
  no server round-trip.
- Related-content similarity **reuses the stored embeddings** (no re-embedding) and
  the sqlite-vec KNN index, so it stays cheap; results are cached per content and
  keyed on a global index version bumped on every (re)index.

## [0.0.4] - 2026-07-12

Phase 2 — Fetchly stops being just a downloader and becomes a searchable media
library: a real Library view with an integrated player, automatic local
transcription, and hybrid (keyword + meaning) search over every second of your
content. Everything stays in-process — still one container, no external service.

### Added

- **Library** — a first-class **Bibliothèque** view backed by a real content
  model (SQLite `contents` table), not a per-request disk scan. Grid/list
  layouts, sort (recent / title / duration) and filters (type, transcription,
  free-text on title/channel), infinite "load more", skeleton/empty states.
  Existing downloads are backfilled once on startup and every new download
  appears automatically; thumbnails are copied locally and served. New
  endpoints: `GET /api/library`, `GET/DELETE /api/library/{id}` (remove entry
  only, or entry + file — two distinct confirmations), `POST /api/library/rescan`.
- **Integrated player** — HTML5 video/audio with **HTTP Range** streaming
  (`GET /api/library/{id}/stream`, path-traversal guarded) for instant seek,
  keyboard shortcuts (space, ±5 s), and a start-at timestamp (`?content=<id>&t=<s>`).
  A content detail page shows metadata, "open original", copyable file path,
  re-download when a file is missing, and a tabbed layout (Aperçu · Transcript).
- **Local transcription (Whisper)** — a builtin **processor plugin**
  (faster-whisper / CTranslate2, CPU int8 or CUDA GPU auto-detected) transcribes
  each download on a **dedicated queue** separate from the download pool: FIFO,
  optional **nightly window**, resume-after-restart, one model resident at a time
  (unloaded when idle). Produces `.srt` + `.vtt` sidecars and timestamped
  segments; detects the language. The Transcript tab gets clickable timestamps
  (seek), karaoke-style highlight during playback, local search, and .srt/.vtt
  download. Settings: model, language, hardware, VAD, schedule, `keep last N`,
  and `skip if captions`. Endpoints: `POST /api/transcripts/backfill`,
  `POST /api/library/{id}/transcribe`, `GET /api/transcript-jobs`,
  `POST /api/transcript-jobs/{id}/cancel`, `GET /api/library/{id}/transcript`.
- **Hybrid search** — every second of the library is searchable by **keyword
  and by meaning**, fully in-process (SQLite FTS5 + sqlite-vec, no external
  search engine). Accent-insensitive full text (`remove_diacritics 2`) over
  transcripts + metadata, plus local ONNX embeddings (fastembed, no torch) over
  ~45 s semantic chunks, fused with Reciprocal Rank Fusion. A reformulation
  ("protéger ses identifiants") finds the same passage as the exact words, and
  queries work **across languages**. `GET /api/search`, `GET /api/index/stats`,
  `POST /api/index/backfill`, `POST /api/index/rebuild`.
- **Import existing subtitles** — content that only has source `.srt`/`.vtt`
  (never run through Whisper) is parsed into segments and indexed, so it's
  searchable too — no re-transcription.

### Changed

- **Source-agnostic navigation** — the sidebar no longer mentions YouTube: the
  source is now a **badge** on cards (multi-source ready). **Bibliothèque** and
  **Abonnements** are promoted to top-level entries; the former YouTube view is
  renamed **Explorer** (unchanged functionally). The Downloads view gains a
  **Transcriptions** section and the "active" counter now includes them.

### Notes

- Transcription and search models are downloaded on first use into
  `/config/models` (persistent). Semantic search embeds the query on CPU
  (~150–200 ms/query) with a one-time model warm-up; lexical search is a few ms.
- Embedding model: `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`
  (384-dim, multilingual, ONNX — no torch).

## [0.0.3] - 2026-07-10

### Added

- **Controllable download queue** — running/queued downloads can now be
  **paused, resumed, cancelled and retried**, individually or all at once, with
  optimistic UI feedback. Cancelling is confirmed and removes the incomplete
  `.part` files (completed files are kept); pausing keeps them, so resuming
  continues where it left off without re-fetching finished videos. Two new
  statuses, **paused** and **canceled**. New endpoints:
  `POST /api/jobs/{id}/pause|resume|cancel|retry`,
  `POST /api/jobs/pause-all|resume-all`.
- **Persistent queue** — jobs are stored in SQLite (`/config/fetchly.db`, WAL)
  as the source of truth behind an in-memory cache. A restart no longer loses
  the queue: interrupted downloads are re-queued automatically (resuming from
  their `.part` files + a per-job done list, so nothing downloads twice), and
  the UI shows a *"N téléchargements repris après redémarrage"* banner.
- **Subscription content filters, applied for real** — min/max **duration**,
  **include / exclude keywords** (case- and accent-insensitive; a single
  exclude match wins over include), **exclude Shorts** (by `/shorts/` URL or
  ≤ 60 s) and **exclude Lives**, plus **keep last N** retention (prunes the
  oldest files in the watch folder after a sync — never other folders, never
  the archive). Filters are enforced twice: at listing and as a yt-dlp
  `match_filter` safety net at download, and apply to the initial backfill too.
  The editor gets a chip-based keyword input and a **"Tester les filtres"**
  preview (`POST /api/watches/preview-filters`) reporting kept/rejected on the
  last ~30 videos; each subscription card shows the last check as
  *"12 listées · 4 filtrées · 8 téléchargées"*.
- **Plugin architecture** — a small documented plugin system (`app/plugins/`,
  see [`docs/PLUGINS.md`](docs/PLUGINS.md)) with three contracts —
  **SourcePlugin**, **ProcessorPlugin**, **OutputPlugin** — and a journalled
  post-download pipeline (`content_downloaded → processors → content_ready →
  outputs`, logged to a `pipeline_runs` table). Builtin and user plugins
  (dropped in `/config/plugins`) are discovered with **isolated error
  handling**: a broken plugin is flagged in the UI and never blocks startup.
  Managed from a new **Réglages → Plugins** tab (enable/disable, settings
  generated from each plugin's schema). Endpoints: `GET /api/plugins`,
  `POST /api/plugins/{id}/enable|disable`, `PATCH /api/plugins/{id}/settings`,
  `POST /api/plugins/{id}/actions/{action}`. yt-dlp is now the first **source**
  plugin.
- **Media Center integration (Jellyfin / Plex)** — a builtin **output** plugin
  that, after each download, writes Kodi/Jellyfin metadata (`episodedetails`
  `.nfo` per video + per-channel `tvshow.nfo`, `poster.jpg` and `-thumb.jpg`)
  so each channel shows up as a clean series, and notifies the server to
  rescan (Jellyfin `POST /Library/Refresh`, Plex
  `/library/sections/{id|all}/refresh`), **debounced 60 s** so a burst of
  downloads triggers a single refresh. Includes a **"Tester la connexion"**
  button (clear DNS / 401 / timeout messages) and a **"Générer les métadonnées
  pour la bibliothèque existante"** action (background job; never moves or
  deletes media). Best-effort throughout — a media-center problem never fails
  or blocks a download; the download card shows what ran
  (*"NFO ✓ · Jellyfin notifié ✓"*, or a failure linking to the job log).
- **Design system** — [`frontend/DESIGN.md`](frontend/DESIGN.md) documents the
  product language: a single source of truth for the status vocabulary
  (`frontend/lib/status.ts`) and reusable `ConfirmDialog` / `InlineFeedback`
  (loading / empty / error) components applied across the views.

### Changed

- **Backend restructured** from a single ~1700-line `main.py` into focused
  modules — download **jobs engine**, **watches** scheduler, plugin
  **registry** + **pipeline**, the **yt-dlp source plugin** (the only module
  that imports `yt_dlp`) and thin **routes** — with `main.py` reduced to app
  assembly + startup. Same public endpoints and download/watch behaviour.

### Fixed

- Subscription filters that were stored only in the frontend now actually reach
  and are honoured by the backend (see *Subscription content filters* above),
  superseding the earlier Shorts/Lives-only fix.

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

[0.0.4]: https://github.com/OWNER/REPO/releases/tag/v0.0.4
[0.0.3]: https://github.com/OWNER/REPO/releases/tag/v0.0.3
[0.0.2]: https://github.com/OWNER/REPO/releases/tag/v0.0.2
[0.0.1]: https://github.com/OWNER/REPO/releases/tag/v0.0.1
