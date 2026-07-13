# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.0.10] - 2026-07-13

Listen anywhere. Each subscription can become a self-hosted **podcast RSS feed**
(audio) playable in AntennaPod, Overcast, Apple Podcasts, etc. Reliability first:
audio is prepared **ahead of time** — the media route never transcodes on demand.

### Added

- **OutputPlugin `podcast`** — on each finished download whose subscription has
  the podcast flag, it prepares the audio rendition: audio content references its
  own file; video is extracted with ffmpeg (`-vn`, chosen codec) to
  `/downloads/.fetchly/audio/{content_id}.{ext}` and its size/duration recorded on
  `contents` (`audio_path`, `audio_bytes`). Best-effort — a failure is logged to
  `pipeline_runs` and never blocks a download. Settings: global **enabled**,
  `audio_format` (m4a/AAC default, opus), `bitrate` (64/96/128k). Action
  **« Préparer l'audio des épisodes existants »** (visible job).
- **Per-subscription toggle** — a `podcast_feed` flag on the watch, edited via a
  **Flux podcast** switch in the subscription editor (« Version audio préparée
  automatiquement pour vos apps de podcast »); if no public URL is set the switch
  points to the setting.
- **Feed token** — a random `feeds_token` (generated on first use, regenerable
  with a destructive confirm — old links break). **Every feed/media URL requires
  `?token=`**; the token is compared in constant time and never logged.
- **Routes** — `GET /feeds/{watch_id}.xml` and `GET /feeds/all.xml` (RSS 2.0 +
  `itunes:` — title/artwork from the watch avatar, up to 100 items newest-first,
  `itunes:duration`, description = `summary_short` else truncated, `enclosure`
  with the **exact** length + type, stable `guid` = content_id); `GET
  /feeds/media/{content_id}.{ext}` serves the prepared audio with **HTTP Range**
  and an exact `Content-Length` (required by podcast apps), **never** transcoding.
  All URLs are absolute via `public_base_url`; without it the routes return **409**
  with a clear message. Management: `GET/POST /api/feeds/config`,
  `POST /api/feeds/token/regenerate`, `GET /api/feeds/watch/{id}`,
  `POST /api/feeds/backfill`.
- **UI** — a subscription card **Flux podcast** popover (full URL with a masked
  token, copy, revoke note, and a backfill link with a missing-audio counter);
  a Settings → **Flux podcast** card (global enable, format/bitrate, live stats —
  active feeds / episodes ready / audio disk usage — the aggregated feed URL, and
  token regeneration behind a destructive confirm).

### Notes

- Never transcodes on demand: if the audio isn't prepared, the item isn't in the
  feed and the media route 404s.
- No feed without a token; regenerating it revokes every previously shared link.
- Extracted audio creates no `contents` row and is removed by the parent
  content's delete cascade.

## [0.0.9] - 2026-07-13

Mark what matters. Highlight a transcript passage, pin a note to it, copy a
sourced citation, or extract the video/audio clip of that moment. These
attention sensors weight the memory (highlighted passages boost search) and
produce the first shareable objects.

### Added

- **Highlights** — select text across one or more transcript segments and a
  floating toolbar appears: **Surligner · Noter · Citer · Clip**. The span rounds
  to the covered segments and the **verbatim is always rebuilt server-side from
  transcript_segments** (the DOM selection is never trusted). Highlighted
  passages get a soft amber background in the transcript (light + dark, AA) and a
  note icon when annotated. New table `highlights` (cascade-deleted with the
  content). `POST /api/library/{id}/highlights`, `PATCH/DELETE /api/highlights/{id}`,
  `GET /api/highlights?content_id=|(all, paginated)`.
- **Notes** — an inline popover (textarea, Cmd/Ctrl+Enter to save, light delete
  confirm) on any highlight. Notes are **indexed** (`notes_fts`, accent-insensitive)
  and fused into search as a typed **`kind: "note"`** result (note + verbatim +
  timestamp), carrying a "note" badge in the palette and on `/search`. A plain
  highlight needs no dedicated index (its text is already in `segments_fts`) but
  **boosts** ranking: a light RRF bonus when a match falls inside a highlight —
  the memory weighted by attention.
- **Player markers** — highlights show as thin **amber** spans on the timeline
  (distinct from the purple chapter markers); click to seek.
- **Clips** — extract a video (`.mp4`) or audio (`.m4a`) excerpt of a passage
  via ffmpeg on the existing task queue: editable `m:ss` bounds, 5 min max (413
  above), 1 s of air before/after, frame-accurate (seek + re-encode; precision
  over speed for short clips). Output under `/downloads/.fetchly/clips/`, tracked
  in a `clips` table (they are excerpts — **no `contents` row**). A finished clip
  toasts a **Télécharger** action and is listed in a **Clips** block on the
  Aperçu tab. `POST /api/library/{id}/clip`, `GET /api/library/{id}/clips`,
  `GET /api/clips/{id}/download`. An ffmpeg failure only fails the clip job.
- **Sourced citations** — client-side, no endpoint: `« {texte} » — {chaîne},
  « {titre} » ({m:ss})` + a deep link `{public_base_url}/?content={id}&t={s}`
  (falls back to the current origin with a hint when no public URL is set).
- **Global « Citations » view** — a **Contenus | Citations** segmented toggle in
  the Bibliothèque lists every highlight (verbatim, note, clickable source →
  the exact second, copy button), with a local search and a pedagogical empty
  state.

### Notes

- No multi-colour highlights/tags (v2), and no hosted public sharing — a clip is
  downloaded, not published.
- Deleting a content cascades its highlights, indexed notes and clip files.

## [0.0.8] - 2026-07-13

The founding promise, realized: **follow ~100 channels without noise or misses.**
The Bibliothèque (already the default route) gains its **Digest** — "since your
last visit", summaries first, memory resurfacing, and an optional weekly e-mail.
It's a TiVo, not a feed: strict reverse-chronological, grouped, predictable — no
opaque ranking anywhere.

### Added

- **Digest section** at the top of the Bibliothèque (above Reprendre / Ajouts
  récents, which don't move). A lede — *« Depuis votre dernière visite : 8
  nouveautés · 3 h 40 · 5 chaînes »* — then new content grouped by **day**
  (Aujourd'hui / Hier / date) and **subscription** (collapsible, avatar + name +
  count). Each item: compact thumbnail, title, duration, `summary_short` on two
  lines, and hover/tap actions — Ouvrir, Plus tard (bookmark toggle), Marquer vu.
  A **Tout marquer comme vu** button clears the section optimistically with a 5 s
  undo toast (flushed on navigation so it's never silently lost).
- **« En écho à vos archives »** — for each new, indexed content, the digest
  reuses `indexer.related()` keeping only **old** contents (> 60 days, score
  ≥ 0.6) and shows up to 3 deduped *nouveau ↔ ancien* pairs, reusing the fiche's
  "Ici · Là-bas" language: two clickable timestamps that open each side at the
  right second. The memory working, made visible but discreet.
- **« À regarder plus tard »** — a bookmark flag on any content
  (`POST /api/library/{id}/watch-later`), surfaced in a collapsed, counted
  section. Persists across visits.
- **Visit state** — `digest_last_seen_at` setting + `seen_at` / `watch_later`
  columns on `contents`. Opening a content marks it seen (drops it from the
  digest). `POST /api/digest/seen { content_ids | all }`, `GET /api/digest`,
  `GET /api/digest/new-count`. A discreet **new-count badge** on the sidebar's
  Bibliothèque entry, cleared by "tout marquer vu".
- **Optional weekly e-mail** — Settings → Digest: enable, day, hour, and a
  **public base URL** (validated — no e-mail without it, so no dead links). The
  existing watch scheduler fires it once a week (anti-duplicate guard) as a
  sober HTML message (text logo, stats, top items per subscription with
  `summary_short`, deep links to your instance), sent through your configured
  **Apprise** notification URLs (add a `mailto://`). A **« M'envoyer un aperçu
  maintenant »** button. No tracking pixels.

### Notes

- Predictability by design: the digest never re-orders by a recommendation
  score — only reverse-chronological, grouped by day then subscription.
- No e-mail is sent without a valid `public_base_url`; the transport is whatever
  Apprise URLs you already configured for notifications.
- Graceful states: nothing new → a calm *« Vous êtes à jour ✓ »* (never an
  anxious empty block); a content with no summary (no AI provider) shows without
  one rather than leaving a hole.

## [0.0.7] - 2026-07-13

Optional **cloud transcription engine**. On a NAS or small server, local Whisper
is the heavy job; a cloud STT provider turns it into a few HTTP requests. Cloud
is strictly opt-in — the default stays 100 % local, and no audio leaves the
machine unless you pick the Cloud engine **and** enter a key.

### Added

- **Transcriber interface** — the core step (produce timestamped segments from a
  media file) now sits behind `transcribe_media(path, settings) -> (language,
  segments)` with two implementations: **LocalWhisper** (the existing
  faster-whisper path, unchanged, default) and **CloudSTT**. The rest of the
  pipeline — `.srt`/`.vtt` sidecars, search indexing, summary/chapter generation,
  per-content statuses, the queue and the night window — is byte-for-byte
  identical for both; it only ever sees `(language, segments)`.
- **Cloud STT engine** (`app/cloud_stt.py`, stdlib only) — one protocol: the
  OpenAI-compatible multipart `POST {base}/audio/transcriptions` (OpenAI
  `whisper-1`/`gpt-4o-transcribe`, Groq `whisper-large-v3-turbo`, Mistral
  `voxtral-mini-latest`). Audio is always **extracted + downsampled with ffmpeg**
  (mono, 16 kHz, AAC ~48 kbps) to a temp file first — the video is never
  uploaded, cutting size 20–50×. If the audio exceeds the provider cap (~25 MB),
  it's **split into 10-minute slices with 5 s overlap**, sent sequentially, and
  re-stitched by offsetting timestamps and de-duplicating the overlap by text
  similarity at the join. `verbose_json` segments are mapped to
  `transcript_segments` exactly like local; **2 retries with backoff** on 429/5xx,
  clean actionable error otherwise. Temp audio is always deleted (success or
  failure).
- **Whisper plugin settings** — an **Engine** selector (Local | Cloud, default
  Local) at the top. In Cloud mode: provider preset (OpenAI, Groq, Mistral,
  Personnalisé) that pre-fills base URL + model, an editable model, and a masked
  API key. A **Tester la connexion cloud** button (sends 5 s of generated silence
  and checks the reply) and an **explicit privacy warning** — *« L'audio de vos
  contenus sera envoyé à {fournisseur}. »* In Local mode: the hardware card
  (CPU/GPU, measured speed) stays, plus a hint when the measured speed is below
  real time — *« Matériel modeste détecté — le moteur Cloud peut transcrire
  beaucoup plus vite. »*
- **Monthly cost journal** — counts minutes sent to the cloud per month (resets
  monthly), shown as *« N min transcrites dans le cloud ce mois-ci »*. Minutes
  only, no price (rates move).
- **Cloud job indicator** — a discreet cloud icon on cloud transcription jobs in
  the Transcriptions queue; everything else about the queue is unchanged.

### Notes

- Default is local: no byte leaves the machine unless the user selects Cloud
  **and** provides a key. This release adds no diarization and no proprietary
  provider protocol (a single OpenAI-compatible one).
- The night window ("deferred processing") applies to the cloud engine too, to
  smooth request bursts if the user wants it.
- Suggested cloud model IDs are editable defaults (verified July 2026):
  Groq `whisper-large-v3-turbo`, OpenAI `whisper-1`, Mistral `voxtral-mini-latest`.

## [0.0.6] - 2026-07-12

First **intelligence** brick — every transcribed content can get an LLM-generated
**summary and chapters**, from a **local** model (Ollama, LM Studio) or a **remote**
one (an API key). Optional, asynchronous, and replayable: with no provider
configured Fetchly works exactly as before and makes zero outbound LLM calls.
Built as reusable infrastructure the future digest and later phases sit on.

### Added

- **LLM provider abstraction** (`app/llm.py`) — deliberately tiny, one file, no
  SDK (stdlib `urllib` only). Two protocols cover the whole market:
  **openai_compatible** (`/chat/completions` — OpenAI, Gemini's OpenAI endpoint,
  Mistral, Groq, OpenRouter, Ollama, LM Studio, vLLM…) and **anthropic**
  (`/v1/messages`). A single editable **presets table** pre-fills protocol +
  base URL + a suggested model per provider; `generate(system, prompt,
  json_schema=…)` returns text or parsed JSON with tolerant parsing (strips
  code fences) and **one** automatic retry on invalid JSON, then a clean failure
  — never a retry loop. `test_connection()` powers the settings button.
- **Generation queue** (`app/generate.py`) — a dedicated single-worker FIFO queue
  (same shape as the transcription queue): persisted, resumable across restarts,
  honouring the **shared night window** ("deferred processing"). One pass per
  content produces `summary_short` (2–3 sentences), `summary_long` (3–6
  paragraphs) and 3–12 **chapters**. Short transcripts summarise in a single
  pass; long ones use **map-reduce over the ~45 s semantic chunks** (bounded map
  calls, with a note in the long summary when truncated). Each chapter's
  timestamp is **snapped to the nearest real segment start**, so player markers
  always land on a spoken boundary. Guardrails: per-call timeout, capped calls
  per content, call count logged per job.
- **Automatic + manual triggering** — a successful transcription (and `skipped`
  content that has source subtitles) enqueues generation **only if a provider is
  configured**. `POST /api/library/{id}/generate` forces a regeneration
  (overwrites), `POST /api/generate/backfill { only_missing }` runs the whole
  library as a visible job, and jobs are cancelable
  (`GET /api/generation-jobs`, `POST /api/generation-jobs/{id}/cancel`).
- **Settings → Intelligence** — a provider picker (Anthropic, OpenAI, Google
  Gemini, Mistral, Groq, OpenRouter, Ollama, LM Studio, Personnalisé) that
  pre-fills the fields and shows contextual help: where to get the key (provider
  console link), a rough cost hint ("~0,1–0,5 centime par vidéo résumée avec un
  modèle léger"), and the model-install command for Ollama/LM Studio. A visible
  note on cloud presets — *« Les transcripts partent chez le fournisseur choisi
  pour être résumés — préférez Ollama pour un traitement 100 % local. »* — plus a
  **Tester la connexion** button (three inline states) and **Générer pour toute
  la bibliothèque** behind a confirm dialog. The API key is stored locally and
  **never returned** by the API (responses expose only `has_key`).
- **Content page — enriched Aperçu** — `summary_short` in the lede, `summary_long`
  below, a discreet *"Généré par {modèle} · {date}"* footer and a **Régénérer**
  button. Pedagogical states: no provider → an Empty pointing to the settings;
  queued/running → skeleton + status (auto-refreshes); error → message + retry.
- **Chapters in the player** — clickable markers along a slim timeline under the
  player (title on hover) and a **Chapitres** list that seeks, with the current
  chapter highlighted during playback (same mechanic as the transcript karaoke).
- **Library cards** — `summary_short` on one or two lines under the title (in
  place of the raw description) and a discreet **« chapitré »** badge when a
  content has chapters.

### Notes

- **Deferred processing is shared** with transcription: if you enabled the
  nightly window for Whisper, summaries generate in that same window.
- Nothing runs without an explicit provider — no default key, no auto-generation,
  no outbound LLM call. Cloud providers receive the transcript text to summarise;
  choose Ollama or LM Studio for a fully local pipeline.
- Suggested model IDs are just editable defaults (verified July 2026):
  `claude-haiku-4-5`, `gpt-4o-mini`, `gemini-2.5-flash-lite`,
  `mistral-small-latest`, Groq `openai/gpt-oss-120b`. base_url and model stay
  editable after picking a preset.

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
