---
name: fetchly-podcast-feeds
description: Fetchly self-hosted podcast RSS feeds per subscription (audio prepared ahead of time, token-gated)
metadata:
  type: project
---

Each subscription can be a self-hosted **podcast RSS feed** (audio). **Reliability first: audio is prepared ahead of time — the media route NEVER transcodes on demand.**

- **OutputPlugin** `podcast` ([app/plugins/builtin/podcast_output.py](app/plugins/builtin/podcast_output.py), auto-discovered): `on_content_ready` → if global `enabled` + the content's watch has `podcast_feed`, calls `podcast.prepare_audio` (audio-kind references its own file; video → ffmpeg `-vn` extract). Isolated via `pipeline_runs`, never blocks. Settings: `enabled`/`audio_format` (m4a|opus)/`bitrate`. Backfill action → `podcast.backfill(None)`.
- **Core** [app/podcast.py](app/podcast.py): `prepare_audio`, `backfill(watch_id|None)` (jobs.create_task), `build_feed(scope, base, token)` (RSS 2.0 + `itunes:` via `ET.register_namespace` — do NOT also set `xmlns:itunes` manually → duplicate-attr error), `itunes_duration`, `stats`. Audio under `/downloads/.fetchly/audio/{content_id}.{ext}`.
- **DB**: `contents.audio_path`/`audio_bytes` (preserved on re-scan, cascade-deleted); `db.podcast_items(watch_ids|None, limit)`, `podcast_missing_count`, `contents_without_audio`, `podcast_stats`, `content_set_audio`. Audio FILE deleted in `routes/library.delete_content`.
- **Token** ([store.py](app/store.py)): `feeds_token()` (gen on first use), `regenerate_feeds_token()`. `store.public_base_url()` (from digest settings — see [[fetchly-digest]]) required; routes 409 without it.
- **Routes** [app/routes/feeds.py](app/routes/feeds.py): public `GET /feeds/{feed_id}.xml` (feed_id="all" → aggregate of `podcast_watch_ids()`), `GET /feeds/media/{content_id}.{ext}` (token + HTTP Range via `library.parse_byte_range`, exact Content-Length, no transcode). Token via `hmac.compare_digest`, never logged. Management `GET/POST /api/feeds/config`, `POST /api/feeds/token/regenerate`, `GET /api/feeds/watch/{id}`, `POST /api/feeds/backfill`.
- Per-watch flag `podcast_feed` on the watch (store `add_watch` default False; `WatchUpdate`/patch route). Frontend: switch in [subscription-editor.tsx](frontend/components/subscription-editor.tsx), `PodcastFeedButton` popover in [subscriptions-panel.tsx](frontend/components/subscriptions-panel.tsx), Settings [feeds-card.tsx](frontend/components/feeds-card.tsx); `Subscription.podcastFeed` mapped in store-provider `watchToSub`/`updateSubscription`.
