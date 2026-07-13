---
name: fetchly-highlights-clips
description: Fetchly highlights/notes/clips/citations — attention sensors that weight search and produce shareable objects
metadata:
  type: project
---

Phase-3 "attention capteurs": highlight transcript passages, note them, cite them, clip them.

- **DB** ([app/db.py](app/db.py)): `highlights` (INTEGER PK — used as `notes_fts` rowid), `clips` (excerpts, NOT `contents`), and `notes_fts` (fts5, **app-synced** on `highlight_set_note`/`highlight_delete`, not triggers). All cascade-deleted in `_purge_index_rows`. Helpers: `highlight_create/get/set_note/delete`, `highlights_get/all/spans`, `fts_notes`, `clip_create/clips_get/clip_get`.
- **Verbatim is server-rebuilt** from `transcript_segments` via `library.rebuild_span(content_id, start_ms, end_ms)` (never the DOM selection) — the route only takes `{start_ms, end_ms}`.
- **Search fusion** ([app/indexer.py](app/indexer.py) `search()`): `db.fts_notes` added as a 4th RRF source → passages `match_type: "note"` (text=note, `verbatim`, `highlight_id`); `_HL_BONUS` (0.01) added to a content's score when a matched passage falls inside a `highlights_spans` span; `_dedupe_passages` prefers note > lexical > semantic.
- **Clips** ([app/clips.py](app/clips.py)): ffmpeg on `jobs.create_task` queue, 5 min max (`duration_error`), 1 s margin, frame-accurate re-encode (video libx264 / audio aac), output `/downloads/.fetchly/clips/`, row in `clips`. Download via `GET /api/clips/{id}/download` (attachment, traversal-guarded). Clip files deleted in `routes/library.delete_content`.
- Routes in [app/routes/annotations.py](app/routes/annotations.py) (registered in main). Citations are **client-side** (no endpoint): `« {text} » — {channel}, « {title} » ({m:ss})` + `{public_base_url}/?content={id}&t={s}` (public_base_url from digest settings — see [[fetchly-digest]]).
- **Frontend**: transcript selection toolbar + amber highlight rendering + note popover + player `HighlightBar` + `ClipDialog`/`ClipsBlock` in [content-detail-view.tsx](frontend/components/views/content-detail-view.tsx); global [citations-view.tsx](frontend/components/views/citations-view.tsx) behind a Contenus|Citations segmented toggle in [library-view.tsx](frontend/components/views/library-view.tsx); "note" badge in search-view + command-palette. See [[fetchly-frontend-architecture]].
