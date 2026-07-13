---
name: fetchly-digest
description: Fetchly's Bibliothèque Digest — "since your last visit", echoes, watch-later, optional weekly email
metadata:
  type: project
---

The **Digest** ([app/digest.py](app/digest.py)) powers the Bibliothèque's "since your last visit" section — a TiVo, not a feed: strict reverse-chronological, grouped **day → subscription**, no ranking.

- Visit state: `store.get_digest()`/`update_digest()` (`last_seen_at`, `email_*`, `public_base_url`); `contents.seen_at` + `contents.watch_later` columns (preserved across re-scan, cascade-deleted). `digest_new(since)` = downloaded_at > since AND seen_at IS NULL. Opening a content marks it seen (in `routes/library.get_content`). "Mark all seen" advances `last_seen_at`.
- `digest.build()` → `{stats, new (day→sub groups), echoes, watch_later}`. **Echoes** reuse `indexer.related()` filtered to OLD contents (>60 d, score ≥ 0.6), ≤3 deduped `nouveau ↔ ancien` pairs (pair.a = new moment, pair.b = old moment → "Ici · Là-bas").
- Weekly e-mail: opt-in; the watch scheduler minute-loop calls `digest.maybe_send_weekly()` (fires once in configured day/hour, `email_last_sent` guard). HTML built by `build_email_html` (deep links `{public_base_url}/?content=<id>`, no tracking), sent via `notify.send_digest_email` (Apprise, `body_format=HTML`) over the user's configured notification URLs. **No send without a valid `public_base_url`.**
- Routes: `GET /api/digest`, `GET /api/digest/new-count`, `POST /api/digest/seen`, `GET|POST /api/digest/settings`, `POST /api/digest/email-preview`, `POST /api/library/{id}/watch-later`.
- Frontend: [digest-section.tsx](frontend/components/views/digest-section.tsx) (inserted at top of `LibraryHome` in [library-view.tsx](frontend/components/views/library-view.tsx); "mark all seen" = optimistic + 5 s undo, flushed on unmount), sidebar new badge via `store.digestNewCount`/`refreshDigestCount` ([store-provider.tsx](frontend/components/store-provider.tsx)), and [digest-card.tsx](frontend/components/digest-card.tsx) in Settings. See [[fetchly-frontend-architecture]], [[fetchly-intelligence-llm]].
