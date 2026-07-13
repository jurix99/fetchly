"""SQLite persistence for download jobs.

The database (``/config/fetchly.db``, WAL mode) is the SOURCE OF TRUTH for jobs;
``main.JOBS`` is a hot in-memory cache rebuilt from it on startup. Rows are
written on every state transition and on throttled progress updates (see
``main._persist`` / ``main._persist_progress``).

Deliberately stdlib-only (``sqlite3``): no ORM, one table, explicit columns.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

CONFIG_DIR = Path(os.environ.get("CONFIG_DIR", "/config"))
DB_FILE = CONFIG_DIR / "fetchly.db"

# One shared connection (WAL lets readers and a single writer coexist); all
# writes are serialised through _LOCK since several download threads persist
# concurrently.
_LOCK = threading.Lock()
_conn: sqlite3.Connection | None = None
VEC_OK = False  # whether the sqlite-vec extension loaded (semantic search)
EMBED_DIM = 384  # intfloat/multilingual-e5-small

# Column order is the single contract between Job <-> row (see main._job_to_row).
COLUMNS = [
    "id", "url", "quality", "fmt", "kind", "status", "phase", "total",
    "completed", "downloaded", "failed", "current_title", "current_thumbnail",
    "current_percent", "current_speed", "files", "error", "log", "done_ids",
    "use_archive", "watch_id", "dest", "date_after", "playlist_title",
    "created_at", "paused_at", "canceled_at", "finished_at",
]
# Columns stored as JSON text (lists on the Python side).
_JSON_COLS = {"files", "log", "done_ids"}


def init() -> None:
    """Open the DB and create the jobs table. Call once at startup."""
    global _conn, VEC_OK
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    _conn = sqlite3.connect(str(DB_FILE), check_same_thread=False)
    _conn.execute("PRAGMA journal_mode=WAL")
    _conn.execute("PRAGMA synchronous=NORMAL")
    # Load the sqlite-vec extension for vector KNN. Best-effort: if it can't load
    # (e.g. extension loading disabled), semantic search is skipped and lexical
    # FTS still works.
    try:
        import sqlite_vec
        _conn.enable_load_extension(True)
        sqlite_vec.load(_conn)
        _conn.enable_load_extension(False)
        VEC_OK = True
    except Exception as exc:  # noqa: BLE001
        print(f"[db] sqlite-vec unavailable ({exc}); semantic search disabled", flush=True)
        VEC_OK = False
    _conn.execute(
        """
        CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY,
            url TEXT, quality TEXT, fmt TEXT, kind TEXT, status TEXT, phase TEXT,
            total INTEGER, completed INTEGER, downloaded INTEGER, failed INTEGER,
            current_title TEXT, current_thumbnail TEXT, current_percent REAL,
            current_speed TEXT, files TEXT, error TEXT, log TEXT, done_ids TEXT,
            use_archive INTEGER, watch_id TEXT, dest TEXT, date_after TEXT,
            playlist_title TEXT, created_at REAL,
            paused_at REAL, canceled_at REAL, finished_at REAL
        )
        """
    )
    # Pipeline observability: one row per plugin step per job (see app/pipeline.py).
    _conn.execute(
        """
        CREATE TABLE IF NOT EXISTS pipeline_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id TEXT, plugin_id TEXT, stage TEXT, status TEXT,
            duration REAL, error TEXT, at REAL
        )
        """
    )
    # Library: one row per downloaded media file — the source of truth for the
    # Bibliothèque view (no more disk scan per request). See app/library.py.
    _conn.execute(
        """
        CREATE TABLE IF NOT EXISTS contents (
            id TEXT PRIMARY KEY,
            source TEXT, source_id TEXT, url TEXT, title TEXT, description TEXT,
            channel TEXT, channel_url TEXT, duration_seconds REAL,
            uploaded_at TEXT, downloaded_at REAL, filepath TEXT UNIQUE,
            filesize INTEGER, thumbnail_path TEXT, watch_id TEXT, kind TEXT,
            transcript_status TEXT DEFAULT 'none', index_status TEXT DEFAULT 'none'
        )
        """
    )
    _conn.execute("CREATE INDEX IF NOT EXISTS idx_contents_source_id ON contents(source_id)")
    _conn.execute("CREATE INDEX IF NOT EXISTS idx_contents_watch_id ON contents(watch_id)")
    _conn.execute("CREATE INDEX IF NOT EXISTS idx_contents_downloaded_at ON contents(downloaded_at)")
    # `language` (detected at transcription) added post-hoc for existing DBs.
    try:
        _conn.execute("ALTER TABLE contents ADD COLUMN language TEXT")
    except sqlite3.OperationalError:
        pass  # already exists
    # Intelligence brick: LLM-generated summary + chapters, added post-hoc.
    for _col, _decl in (
        ("summary_short", "TEXT"),
        ("summary_long", "TEXT"),
        ("summary_model", "TEXT"),
        ("summary_generated_at", "REAL"),
        ("generation_status", "TEXT DEFAULT 'none'"),
        # Digest (phase 3): visit state + watch-later flag.
        ("seen_at", "REAL"),
        ("watch_later", "INTEGER DEFAULT 0"),
        # Podcast feed: prepared audio rendition (extracted ahead of time).
        ("audio_path", "TEXT"),
        ("audio_bytes", "INTEGER"),
    ):
        try:
            _conn.execute(f"ALTER TABLE contents ADD COLUMN {_col} {_decl}")
        except sqlite3.OperationalError:
            pass  # already exists
    # Chapters produced alongside the summary (start_ms snapped to a segment).
    _conn.execute(
        """
        CREATE TABLE IF NOT EXISTS chapters (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content_id TEXT, start_ms INTEGER, title TEXT, ord INTEGER
        )
        """
    )
    _conn.execute("CREATE INDEX IF NOT EXISTS idx_chapters_content ON chapters(content_id)")
    # Dedicated generation queue (separate from downloads and transcription).
    _conn.execute(
        """
        CREATE TABLE IF NOT EXISTS generation_jobs (
            id TEXT PRIMARY KEY, content_id TEXT, task TEXT, title TEXT,
            status TEXT, error TEXT, model TEXT, calls INTEGER DEFAULT 0,
            created_at REAL, started_at REAL, finished_at REAL
        )
        """
    )
    _conn.execute("CREATE INDEX IF NOT EXISTS idx_gjobs_status ON generation_jobs(status)")
    # Highlights (attention capteurs): a span of transcript the user marked, with
    # an optional note. `text` is the verbatim rebuilt server-side from segments.
    _conn.execute(
        """
        CREATE TABLE IF NOT EXISTS highlights (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content_id TEXT, start_ms INTEGER, end_ms INTEGER,
            text TEXT, note TEXT, color TEXT, created_at REAL
        )
        """
    )
    _conn.execute("CREATE INDEX IF NOT EXISTS idx_highlights_content ON highlights(content_id)")
    # Extracted clips (NOT contents — just files on disk we track for listing/GC).
    _conn.execute(
        """
        CREATE TABLE IF NOT EXISTS clips (
            id TEXT PRIMARY KEY,
            content_id TEXT, path TEXT, format TEXT,
            start_ms INTEGER, end_ms INTEGER, created_at REAL
        )
        """
    )
    _conn.execute("CREATE INDEX IF NOT EXISTS idx_clips_content ON clips(content_id)")
    # Dedicated transcription queue (separate from the download pool).
    _conn.execute(
        """
        CREATE TABLE IF NOT EXISTS transcript_jobs (
            id TEXT PRIMARY KEY, content_id TEXT, title TEXT,
            status TEXT, progress INTEGER, model TEXT,
            created_at REAL, started_at REAL, duration_ms INTEGER, error TEXT
        )
        """
    )
    _conn.execute("CREATE INDEX IF NOT EXISTS idx_tjobs_status ON transcript_jobs(status)")
    # Timestamped transcript segments — the substrate for search (prompt 7).
    _conn.execute(
        """
        CREATE TABLE IF NOT EXISTS transcript_segments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content_id TEXT, start_ms INTEGER, end_ms INTEGER, text TEXT
        )
        """
    )
    _conn.execute("CREATE INDEX IF NOT EXISTS idx_segments_content ON transcript_segments(content_id)")
    # Small key/value store for one-shot flags (e.g. library migration done).
    _conn.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)")
    # North-star instrumentation — strictly LOCAL (never leaves this DB). One row
    # per search; `clicked` flips to 1 when a result is opened (a "retrouvaille").
    _conn.execute(
        """
        CREATE TABLE IF NOT EXISTS search_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts REAL, query_hash TEXT, results_count INTEGER,
            clicked INTEGER DEFAULT 0
        )
        """
    )
    _conn.execute("CREATE INDEX IF NOT EXISTS idx_search_events_hash ON search_events(query_hash)")
    _conn.execute("CREATE INDEX IF NOT EXISTS idx_search_events_ts ON search_events(ts)")
    # Per-content "related contents" cache. Invalidated by a global index version
    # bumped whenever any content finishes indexing (superset of "one of the two
    # changed", which is the correctness requirement).
    _conn.execute(
        """
        CREATE TABLE IF NOT EXISTS related_cache (
            content_id TEXT PRIMARY KEY, index_version INTEGER, payload TEXT
        )
        """
    )
    _init_search()
    _conn.commit()


def _init_search() -> None:
    """FTS5 full-text tables (accent-insensitive) kept in sync by triggers, the
    semantic chunk table, and the sqlite-vec vector table."""
    assert _conn is not None
    # Full text over transcript segments (accent-insensitive: remove_diacritics 2).
    _conn.execute(
        "CREATE VIRTUAL TABLE IF NOT EXISTS segments_fts USING fts5("
        "text, content_id UNINDEXED, start_ms UNINDEXED, "
        "tokenize='unicode61 remove_diacritics 2')"
    )
    # Full text over content metadata (title / description / channel).
    _conn.execute(
        "CREATE VIRTUAL TABLE IF NOT EXISTS contents_fts USING fts5("
        "title, description, channel, content_id UNINDEXED, "
        "tokenize='unicode61 remove_diacritics 2')"
    )
    # Full text over highlight notes (rowid = highlights.id). Synced by the app
    # (see highlight_set_note / highlight_delete), not by triggers.
    _conn.execute(
        "CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5("
        "note, content_id UNINDEXED, start_ms UNINDEXED, "
        "tokenize='unicode61 remove_diacritics 2')"
    )
    # Keep segments_fts in sync with transcript_segments (rowid-linked).
    _conn.execute(
        "CREATE TRIGGER IF NOT EXISTS trg_seg_ai AFTER INSERT ON transcript_segments BEGIN "
        "INSERT INTO segments_fts(rowid, text, content_id, start_ms) "
        "VALUES (new.id, new.text, new.content_id, new.start_ms); END"
    )
    _conn.execute(
        "CREATE TRIGGER IF NOT EXISTS trg_seg_ad AFTER DELETE ON transcript_segments BEGIN "
        "DELETE FROM segments_fts WHERE rowid = old.id; END"
    )
    # Keep contents_fts in sync with contents.
    _conn.execute(
        "CREATE TRIGGER IF NOT EXISTS trg_content_ai AFTER INSERT ON contents BEGIN "
        "INSERT INTO contents_fts(rowid, title, description, channel, content_id) "
        "VALUES (new.rowid, new.title, new.description, new.channel, new.id); END"
    )
    _conn.execute(
        "CREATE TRIGGER IF NOT EXISTS trg_content_ad AFTER DELETE ON contents BEGIN "
        "DELETE FROM contents_fts WHERE rowid = old.rowid; END"
    )
    _conn.execute(
        "CREATE TRIGGER IF NOT EXISTS trg_content_au AFTER UPDATE ON contents BEGIN "
        "DELETE FROM contents_fts WHERE rowid = old.rowid; "
        "INSERT INTO contents_fts(rowid, title, description, channel, content_id) "
        "VALUES (new.rowid, new.title, new.description, new.channel, new.id); END"
    )
    # transcript_segments has an explicit id; ensure it (needed for FTS rowid link).
    # Semantic chunks (~45 s, ~10 s overlap) — unit of semantic search + future RAG.
    _conn.execute(
        """
        CREATE TABLE IF NOT EXISTS transcript_chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content_id TEXT, start_ms INTEGER, end_ms INTEGER, text TEXT
        )
        """
    )
    _conn.execute("CREATE INDEX IF NOT EXISTS idx_chunks_content ON transcript_chunks(content_id)")
    if VEC_OK:
        try:
            _conn.execute(
                f"CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0("
                f"chunk_id INTEGER PRIMARY KEY, embedding float[{EMBED_DIM}] distance_metric=cosine)"
            )
        except Exception as exc:  # noqa: BLE001
            print(f"[db] vec_chunks create failed ({exc}); semantic search disabled", flush=True)
            globals()["VEC_OK"] = False


# --- Read path (per-thread, lock-free) -------------------------------------
# WAL lets many readers run concurrently with the single writer. Reads therefore
# use a per-thread, read-only connection and take NO _LOCK, so a long index/
# transcription write batch never stalls search or library browsing. Writes keep
# using the shared _conn under _LOCK (serialised across writer threads).
_read_local = threading.local()


def _reader() -> sqlite3.Connection | None:
    """A per-thread read-only connection (created lazily), or None before init."""
    if _conn is None:
        return None
    conn = getattr(_read_local, "conn", None)
    if conn is not None:
        return conn
    conn = sqlite3.connect(str(DB_FILE), check_same_thread=False, isolation_level=None)
    conn.execute("PRAGMA busy_timeout=5000")
    if VEC_OK:
        try:
            import sqlite_vec
            conn.enable_load_extension(True)
            sqlite_vec.load(conn)
            conn.enable_load_extension(False)
        except Exception:  # noqa: BLE001 — reader falls back to lexical-only
            pass
    conn.execute("PRAGMA query_only=1")  # hard guard: readers can't write
    _read_local.conn = conn
    return conn


# --- Key/value meta --------------------------------------------------------
def meta_get(key: str) -> str | None:
    conn = _reader()
    if conn is None:
        return None
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row[0] if row else None


def meta_set(key: str, value: str) -> None:
    if _conn is None:
        return
    with _LOCK:
        _conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", (key, value))
        _conn.commit()


# --- Cloud STT cost journal (minutes/month, no price) ----------------------
def _current_month() -> str:
    return time.strftime("%Y-%m", time.gmtime())


def cloud_stt_add_minutes(minutes: float) -> None:
    """Add transcribed minutes to the current month's counter (auto-resets when
    the month rolls over). Local-only; no pricing."""
    if _conn is None or minutes <= 0:
        return
    month = _current_month()
    with _LOCK:
        row = _conn.execute("SELECT value FROM meta WHERE key = 'cloud_stt_month'").fetchone()
        cur_row = _conn.execute("SELECT value FROM meta WHERE key = 'cloud_stt_minutes'").fetchone()
        stored_month = row[0] if row else ""
        total = (float(cur_row[0]) if cur_row and cur_row[0] else 0.0) if stored_month == month else 0.0
        total += minutes
        _conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('cloud_stt_month', ?)", (month,))
        _conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('cloud_stt_minutes', ?)", (f"{total:.1f}",))
        _conn.commit()


def cloud_stt_stats() -> dict[str, Any]:
    """{month, minutes} for the current month (0 if a new month started)."""
    conn = _reader()
    if conn is None:
        return {"month": _current_month(), "minutes": 0}
    month = _current_month()
    row = conn.execute("SELECT value FROM meta WHERE key = 'cloud_stt_month'").fetchone()
    cur = conn.execute("SELECT value FROM meta WHERE key = 'cloud_stt_minutes'").fetchone()
    if not row or row[0] != month:
        return {"month": month, "minutes": 0}
    return {"month": month, "minutes": round(float(cur[0]) if cur and cur[0] else 0.0, 1)}


# --- Contents (library) ----------------------------------------------------
CONTENT_COLUMNS = [
    "id", "source", "source_id", "url", "title", "description", "channel",
    "channel_url", "duration_seconds", "uploaded_at", "downloaded_at",
    "filepath", "filesize", "thumbnail_path", "watch_id", "kind",
    "transcript_status", "index_status", "language",
    "summary_short", "summary_long", "summary_model", "summary_generated_at",
    "generation_status", "seen_at", "watch_later", "audio_path", "audio_bytes",
]
# Processing fields owned by later phases — a re-download/re-scan must not wipe them.
_CONTENT_PRESERVE = {
    "id", "filepath", "transcript_status", "index_status", "language",
    "summary_short", "summary_long", "summary_model", "summary_generated_at",
    "generation_status", "seen_at", "watch_later", "audio_path", "audio_bytes",
}
_SORTABLE = {"downloaded_at", "title", "duration_seconds"}


def content_upsert(row: dict[str, Any]) -> None:
    """Insert or update a content row, keyed on its filepath (one row per file).
    On conflict the existing id is kept; processing statuses are preserved."""
    if _conn is None:
        return
    cols = ", ".join(CONTENT_COLUMNS)
    placeholders = ", ".join("?" for _ in CONTENT_COLUMNS)
    values = [row.get(c) for c in CONTENT_COLUMNS]
    # Update everything except id + the processing fields (owned by later phases:
    # a re-download must not wipe a detected language, transcript, or summary).
    updatable = [c for c in CONTENT_COLUMNS if c not in _CONTENT_PRESERVE]
    set_clause = ", ".join(f"{c}=excluded.{c}" for c in updatable)
    with _LOCK:
        _conn.execute(
            f"INSERT INTO contents ({cols}) VALUES ({placeholders}) "
            f"ON CONFLICT(filepath) DO UPDATE SET {set_clause}",
            values,
        )
        _conn.commit()


def content_get(content_id: str) -> dict[str, Any] | None:
    conn = _reader()
    if conn is None:
        return None
    row = conn.execute(
        f"SELECT {', '.join(CONTENT_COLUMNS)} FROM contents WHERE id = ?", (content_id,)
    ).fetchone()
    return dict(zip(CONTENT_COLUMNS, row)) if row else None


def content_by_filepath(filepath: str) -> dict[str, Any] | None:
    conn = _reader()
    if conn is None:
        return None
    row = conn.execute(
        f"SELECT {', '.join(CONTENT_COLUMNS)} FROM contents WHERE filepath = ?", (filepath,)
    ).fetchone()
    return dict(zip(CONTENT_COLUMNS, row)) if row else None


def content_filepaths() -> set[str]:
    conn = _reader()
    if conn is None:
        return set()
    cur = conn.execute("SELECT filepath FROM contents")
    return {r[0] for r in cur.fetchall() if r[0]}


def _bump_index_version() -> None:
    """Increment the global index version (invalidates related caches). Caller
    must hold _LOCK and commit."""
    assert _conn is not None
    cur = _conn.execute("SELECT value FROM meta WHERE key = 'index_version'").fetchone()
    version = (int(cur[0]) if cur and cur[0] else 0) + 1
    _conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('index_version', ?)", (str(version),)
    )


def _purge_index_rows(content_id: str) -> None:
    """Drop every search/index artefact for a content: chunks, their vectors,
    segments (the AFTER DELETE trigger cleans segments_fts), and any related
    cache. Caller must hold _LOCK and commit. contents_fts is cleaned by the
    contents AFTER DELETE trigger when the row itself is removed."""
    assert _conn is not None
    ids = [r[0] for r in _conn.execute(
        "SELECT id FROM transcript_chunks WHERE content_id = ?", (content_id,)
    ).fetchall()]
    if ids and VEC_OK:
        _conn.executemany("DELETE FROM vec_chunks WHERE chunk_id = ?", [(i,) for i in ids])
    _conn.execute("DELETE FROM transcript_chunks WHERE content_id = ?", (content_id,))
    _conn.execute("DELETE FROM transcript_segments WHERE content_id = ?", (content_id,))
    _conn.execute("DELETE FROM related_cache WHERE content_id = ?", (content_id,))
    _conn.execute("DELETE FROM chapters WHERE content_id = ?", (content_id,))
    # Highlights + their indexed notes, and clip rows (files removed by the route).
    hl_ids = [r[0] for r in _conn.execute(
        "SELECT id FROM highlights WHERE content_id = ?", (content_id,)
    ).fetchall()]
    for hid in hl_ids:
        _conn.execute("DELETE FROM notes_fts WHERE rowid = ?", (hid,))
    _conn.execute("DELETE FROM highlights WHERE content_id = ?", (content_id,))
    _conn.execute("DELETE FROM clips WHERE content_id = ?", (content_id,))


def content_delete(content_id: str) -> str | None:
    """Remove a content row **and all its memory** (segments, chunks, vectors,
    FTS, related cache) so nothing is left pointing at a gone content. Returns
    its filepath so the caller can optionally delete the file too."""
    if _conn is None:
        return None
    with _LOCK:
        cur = _conn.execute("SELECT filepath FROM contents WHERE id = ?", (content_id,))
        row = cur.fetchone()
        if not row:
            return None
        _purge_index_rows(content_id)
        _conn.execute("DELETE FROM contents WHERE id = ?", (content_id,))
        _bump_index_version()
        _conn.commit()
    return row[0]


def content_delete_by_filepath(filepath: str) -> bool:
    """Cascade-delete the content row for a media file removed off-band (e.g.
    keepLastN pruning), so no ghost row / orphan vectors survive."""
    if _conn is None or not filepath:
        return False
    with _LOCK:
        row = _conn.execute("SELECT id FROM contents WHERE filepath = ?", (filepath,)).fetchone()
        if not row:
            return False
        cid = row[0]
        _purge_index_rows(cid)
        _conn.execute("DELETE FROM contents WHERE id = ?", (cid,))
        _bump_index_version()
        _conn.commit()
    return True


def gc_orphans() -> dict[str, int]:
    """Startup garbage-collect: drop index rows whose content no longer exists
    (from crashes or off-band file removal) so the KNN isn't polluted by orphan
    vectors forever. Cheap; runs once at boot."""
    if _conn is None:
        return {}
    with _LOCK:
        orphan_chunks = [r[0] for r in _conn.execute(
            "SELECT id FROM transcript_chunks WHERE content_id NOT IN (SELECT id FROM contents)"
        ).fetchall()]
        if orphan_chunks and VEC_OK:
            _conn.executemany("DELETE FROM vec_chunks WHERE chunk_id = ?", [(i,) for i in orphan_chunks])
        c = _conn.execute(
            "DELETE FROM transcript_chunks WHERE content_id NOT IN (SELECT id FROM contents)"
        ).rowcount
        s = _conn.execute(
            "DELETE FROM transcript_segments WHERE content_id NOT IN (SELECT id FROM contents)"
        ).rowcount
        r = _conn.execute(
            "DELETE FROM related_cache WHERE content_id NOT IN (SELECT id FROM contents)"
        ).rowcount
        _conn.execute("DELETE FROM chapters WHERE content_id NOT IN (SELECT id FROM contents)")
        # Vectors whose chunk row is gone (belt and braces around the join above).
        stray = 0
        if VEC_OK:
            try:
                ids = [x[0] for x in _conn.execute(
                    "SELECT chunk_id FROM vec_chunks WHERE chunk_id NOT IN (SELECT id FROM transcript_chunks)"
                ).fetchall()]
                if ids:
                    _conn.executemany("DELETE FROM vec_chunks WHERE chunk_id = ?", [(i,) for i in ids])
                    stray = len(ids)
            except Exception:  # noqa: BLE001 — vec0 metadata scan unsupported → skip
                pass
        if c or s or r or stray:
            _bump_index_version()
        _conn.commit()
    return {"chunks": c, "segments": s, "related": r, "stray_vectors": stray}


def content_list(
    *, limit: int = 40, offset: int = 0, sort: str = "downloaded_at",
    order: str = "desc", source: str | None = None, watch_id: str | None = None,
    kind: str | None = None, q: str | None = None, transcribed: str | None = None,
) -> tuple[list[dict[str, Any]], int]:
    """Filtered/sorted/paginated contents + total count for pagination."""
    if _conn is None:
        return [], 0
    where: list[str] = []
    params: list[Any] = []
    if source:
        where.append("source = ?"); params.append(source)
    if watch_id:
        where.append("watch_id = ?"); params.append(watch_id)
    if kind:
        where.append("kind = ?"); params.append(kind)
    if transcribed == "yes":
        where.append("transcript_status IN ('done', 'skipped')")
    elif transcribed == "no":
        where.append("(transcript_status IS NULL OR transcript_status NOT IN ('done', 'skipped'))")
    if q:
        where.append("(title LIKE ? OR channel LIKE ?)")
        params.extend([f"%{q}%", f"%{q}%"])
    clause = (" WHERE " + " AND ".join(where)) if where else ""
    sort_col = sort if sort in _SORTABLE else "downloaded_at"
    direction = "ASC" if str(order).lower() == "asc" else "DESC"
    conn = _reader()
    if conn is None:
        return [], 0
    total = conn.execute(f"SELECT COUNT(*) FROM contents{clause}", params).fetchone()[0]
    cur = conn.execute(
        f"SELECT {', '.join(CONTENT_COLUMNS)} FROM contents{clause} "
        f"ORDER BY {sort_col} {direction} LIMIT ? OFFSET ?",
        [*params, max(1, min(limit, 200)), max(0, offset)],
    )
    rows = [dict(zip(CONTENT_COLUMNS, r)) for r in cur.fetchall()]
    return rows, total


def contents_without_transcript() -> list[dict[str, Any]]:
    """Content rows whose transcript hasn't been produced (for backfill)."""
    if _conn is None:
        return []
    with _LOCK:
        cur = _conn.execute(
            f"SELECT {', '.join(CONTENT_COLUMNS)} FROM contents "
            "WHERE transcript_status IS NULL OR transcript_status IN ('none', 'error') "
            "ORDER BY downloaded_at ASC"
        )
        return [dict(zip(CONTENT_COLUMNS, r)) for r in cur.fetchall()]


def content_set_transcript(content_id: str, status: str, language: str | None = None) -> None:
    if _conn is None:
        return
    with _LOCK:
        if language is not None:
            _conn.execute(
                "UPDATE contents SET transcript_status = ?, language = ? WHERE id = ?",
                (status, language, content_id),
            )
        else:
            _conn.execute(
                "UPDATE contents SET transcript_status = ? WHERE id = ?", (status, content_id)
            )
        _conn.commit()


# --- Intelligence: summary + chapters --------------------------------------
def content_set_generation(content_id: str, status: str) -> None:
    if _conn is None:
        return
    with _LOCK:
        _conn.execute("UPDATE contents SET generation_status = ? WHERE id = ?", (status, content_id))
        _conn.commit()


def content_set_summary(
    content_id: str, summary_short: str, summary_long: str, model: str, generated_at: float
) -> None:
    if _conn is None:
        return
    with _LOCK:
        _conn.execute(
            "UPDATE contents SET summary_short = ?, summary_long = ?, summary_model = ?, "
            "summary_generated_at = ?, generation_status = 'done' WHERE id = ?",
            (summary_short, summary_long, model, generated_at, content_id),
        )
        _conn.commit()


def chapters_replace(content_id: str, chapters: list[tuple[int, str]]) -> None:
    """Replace all chapters for a content. `chapters` = [(start_ms, title), …]."""
    if _conn is None:
        return
    with _LOCK:
        _conn.execute("DELETE FROM chapters WHERE content_id = ?", (content_id,))
        _conn.executemany(
            "INSERT INTO chapters (content_id, start_ms, title, ord) VALUES (?, ?, ?, ?)",
            [(content_id, s, t, i) for i, (s, t) in enumerate(chapters)],
        )
        _conn.commit()


def chapters_get(content_id: str) -> list[dict[str, Any]]:
    conn = _reader()
    if conn is None:
        return []
    cur = conn.execute(
        "SELECT start_ms, title FROM chapters WHERE content_id = ? ORDER BY ord ASC", (content_id,)
    )
    return [{"start_ms": r[0], "title": r[1]} for r in cur.fetchall()]


def chapters_count(content_id: str) -> int:
    conn = _reader()
    if conn is None:
        return 0
    return conn.execute("SELECT COUNT(*) FROM chapters WHERE content_id = ?", (content_id,)).fetchone()[0]


def contents_without_summary() -> list[dict[str, Any]]:
    """Transcribed/indexed contents with no summary yet (for backfill). Only
    content that HAS a transcript is worth generating for."""
    conn = _reader()
    if conn is None:
        return []
    cur = conn.execute(
        f"SELECT {', '.join(CONTENT_COLUMNS)} FROM contents "
        "WHERE transcript_status IN ('done', 'skipped') "
        "AND (generation_status IS NULL OR generation_status IN ('none', 'error')) "
        "ORDER BY downloaded_at ASC"
    )
    return [dict(zip(CONTENT_COLUMNS, r)) for r in cur.fetchall()]


# --- Digest: visit state + watch-later -------------------------------------
def content_mark_seen(content_ids: list[str], ts: float | None = None) -> None:
    if _conn is None or not content_ids:
        return
    when = ts if ts is not None else time.time()
    with _LOCK:
        _conn.executemany(
            "UPDATE contents SET seen_at = ? WHERE id = ? AND seen_at IS NULL",
            [(when, cid) for cid in content_ids],
        )
        _conn.commit()


def content_set_watch_later(content_id: str, value: bool) -> None:
    if _conn is None:
        return
    with _LOCK:
        _conn.execute(
            "UPDATE contents SET watch_later = ? WHERE id = ?", (1 if value else 0, content_id)
        )
        _conn.commit()


def digest_new(since_ts: float, limit: int = 200) -> list[dict[str, Any]]:
    """Contents downloaded after `since_ts` and not yet seen — the digest's
    'since your last visit'. Strict reverse-chronological (no ranking)."""
    conn = _reader()
    if conn is None:
        return []
    cur = conn.execute(
        f"SELECT {', '.join(CONTENT_COLUMNS)} FROM contents "
        "WHERE downloaded_at > ? AND seen_at IS NULL "
        "ORDER BY downloaded_at DESC LIMIT ?",
        (since_ts, max(1, min(limit, 500))),
    )
    return [dict(zip(CONTENT_COLUMNS, r)) for r in cur.fetchall()]


def digest_new_count(since_ts: float) -> int:
    conn = _reader()
    if conn is None:
        return 0
    return conn.execute(
        "SELECT COUNT(*) FROM contents WHERE downloaded_at > ? AND seen_at IS NULL", (since_ts,)
    ).fetchone()[0]


def watch_later_list(limit: int = 200) -> list[dict[str, Any]]:
    conn = _reader()
    if conn is None:
        return []
    cur = conn.execute(
        f"SELECT {', '.join(CONTENT_COLUMNS)} FROM contents "
        "WHERE watch_later = 1 ORDER BY downloaded_at DESC LIMIT ?",
        (max(1, min(limit, 500)),),
    )
    return [dict(zip(CONTENT_COLUMNS, r)) for r in cur.fetchall()]


# --- Highlights + notes (attention capteurs) -------------------------------
HIGHLIGHT_COLUMNS = ["id", "content_id", "start_ms", "end_ms", "text", "note", "color", "created_at"]


def highlight_create(content_id: str, start_ms: int, end_ms: int, text: str, color: str) -> dict[str, Any] | None:
    if _conn is None:
        return None
    with _LOCK:
        cur = _conn.execute(
            "INSERT INTO highlights (content_id, start_ms, end_ms, text, note, color, created_at) "
            "VALUES (?, ?, ?, ?, NULL, ?, ?)",
            (content_id, start_ms, end_ms, text, color, time.time()),
        )
        hid = int(cur.lastrowid)
        _conn.commit()
    return highlight_get(hid)


def highlight_get(highlight_id: int) -> dict[str, Any] | None:
    conn = _reader()
    if conn is None:
        return None
    row = conn.execute(
        f"SELECT {', '.join(HIGHLIGHT_COLUMNS)} FROM highlights WHERE id = ?", (highlight_id,)
    ).fetchone()
    return dict(zip(HIGHLIGHT_COLUMNS, row)) if row else None


def highlight_set_note(highlight_id: int, note: str | None) -> dict[str, Any] | None:
    if _conn is None:
        return None
    with _LOCK:
        row = _conn.execute(
            "SELECT content_id, start_ms FROM highlights WHERE id = ?", (highlight_id,)
        ).fetchone()
        if not row:
            return None
        _conn.execute("UPDATE highlights SET note = ? WHERE id = ?", (note, highlight_id))
        # App-synced notes_fts (rowid = highlight id).
        _conn.execute("DELETE FROM notes_fts WHERE rowid = ?", (highlight_id,))
        if note and note.strip():
            _conn.execute(
                "INSERT INTO notes_fts(rowid, note, content_id, start_ms) VALUES (?, ?, ?, ?)",
                (highlight_id, note, row[0], row[1]),
            )
        _conn.commit()
    return highlight_get(highlight_id)


def highlight_delete(highlight_id: int) -> str | None:
    """Delete a highlight (+ its indexed note). Returns its content_id or None."""
    if _conn is None:
        return None
    with _LOCK:
        row = _conn.execute("SELECT content_id FROM highlights WHERE id = ?", (highlight_id,)).fetchone()
        if not row:
            return None
        _conn.execute("DELETE FROM notes_fts WHERE rowid = ?", (highlight_id,))
        _conn.execute("DELETE FROM highlights WHERE id = ?", (highlight_id,))
        _conn.commit()
    return row[0]


def _highlight_order(sort: str) -> str:
    return "start_ms ASC" if sort == "position" else "created_at DESC"


def highlights_get(content_id: str, sort: str = "position") -> list[dict[str, Any]]:
    conn = _reader()
    if conn is None:
        return []
    cur = conn.execute(
        f"SELECT {', '.join(HIGHLIGHT_COLUMNS)} FROM highlights WHERE content_id = ? "
        f"ORDER BY {_highlight_order(sort)}",
        (content_id,),
    )
    return [dict(zip(HIGHLIGHT_COLUMNS, r)) for r in cur.fetchall()]


def highlights_all(
    limit: int = 50, offset: int = 0, sort: str = "recent", content_id: str | None = None,
) -> tuple[list[dict[str, Any]], int]:
    conn = _reader()
    if conn is None:
        return [], 0
    where, params = "", []
    if content_id:
        where = " WHERE content_id = ?"
        params.append(content_id)
    order = "start_ms ASC" if sort == "position" else "created_at DESC"
    total = conn.execute(f"SELECT COUNT(*) FROM highlights{where}", params).fetchone()[0]
    cur = conn.execute(
        f"SELECT {', '.join(HIGHLIGHT_COLUMNS)} FROM highlights{where} "
        f"ORDER BY {order} LIMIT ? OFFSET ?",
        [*params, max(1, min(limit, 200)), max(0, offset)],
    )
    return [dict(zip(HIGHLIGHT_COLUMNS, r)) for r in cur.fetchall()], total


def highlights_spans(content_id: str) -> list[tuple[int, int]]:
    """(start_ms, end_ms) spans for a content — for the search RRF highlight bonus."""
    conn = _reader()
    if conn is None:
        return []
    cur = conn.execute("SELECT start_ms, end_ms FROM highlights WHERE content_id = ?", (content_id,))
    return [(r[0], r[1]) for r in cur.fetchall()]


def fts_notes(tokens: list[str], limit: int, content_id: str | None = None) -> list[dict[str, Any]]:
    conn = _reader()
    if conn is None:
        return []
    q = _fts_query(tokens)
    if not q:
        return []
    where = "notes_fts MATCH ?"
    params: list[Any] = [q]
    if content_id:
        where += " AND notes_fts.content_id = ?"
        params.append(content_id)
    params.append(limit)
    try:
        cur = conn.execute(
            "SELECT notes_fts.rowid, notes_fts.content_id, notes_fts.start_ms, notes_fts.note, "
            "highlights.text, bm25(notes_fts) AS rank "
            "FROM notes_fts JOIN highlights ON highlights.id = notes_fts.rowid "
            f"WHERE {where} ORDER BY rank LIMIT ?",
            params,
        )
        return [
            {"highlight_id": r[0], "content_id": r[1], "start_ms": r[2],
             "note": r[3], "text": r[4], "rank": r[5]}
            for r in cur.fetchall()
        ]
    except Exception:  # noqa: BLE001 — malformed FTS query
        return []


# --- Clips (extracted spans; NOT contents) ---------------------------------
CLIP_COLUMNS = ["id", "content_id", "path", "format", "start_ms", "end_ms", "created_at"]


def clip_create(clip_id: str, content_id: str, path: str, fmt: str, start_ms: int, end_ms: int) -> None:
    if _conn is None:
        return
    with _LOCK:
        _conn.execute(
            "INSERT OR REPLACE INTO clips (id, content_id, path, format, start_ms, end_ms, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (clip_id, content_id, path, fmt, start_ms, end_ms, time.time()),
        )
        _conn.commit()


def clips_get(content_id: str) -> list[dict[str, Any]]:
    conn = _reader()
    if conn is None:
        return []
    cur = conn.execute(
        f"SELECT {', '.join(CLIP_COLUMNS)} FROM clips WHERE content_id = ? ORDER BY created_at DESC",
        (content_id,),
    )
    return [dict(zip(CLIP_COLUMNS, r)) for r in cur.fetchall()]


def clip_get(clip_id: str) -> dict[str, Any] | None:
    conn = _reader()
    if conn is None:
        return None
    row = conn.execute(
        f"SELECT {', '.join(CLIP_COLUMNS)} FROM clips WHERE id = ?", (clip_id,)
    ).fetchone()
    return dict(zip(CLIP_COLUMNS, row)) if row else None


# --- Podcast audio renditions ----------------------------------------------
def content_set_audio(content_id: str, audio_path: str, audio_bytes: int) -> None:
    if _conn is None:
        return
    with _LOCK:
        _conn.execute(
            "UPDATE contents SET audio_path = ?, audio_bytes = ? WHERE id = ?",
            (audio_path, audio_bytes, content_id),
        )
        _conn.commit()


def podcast_items(watch_ids: list[str] | None, limit: int = 100) -> list[dict[str, Any]]:
    """Contents with a prepared audio rendition, newest first, for a feed. Pass a
    list of watch_ids to scope (a single-watch feed or the enabled set for 'all');
    None means any content with audio. Empty list means no items."""
    conn = _reader()
    if conn is None:
        return []
    where = "audio_path IS NOT NULL AND audio_path != ''"
    params: list[Any] = []
    if watch_ids is not None:
        if not watch_ids:
            return []
        where += f" AND watch_id IN ({', '.join('?' for _ in watch_ids)})"
        params.extend(watch_ids)
    params.append(max(1, min(limit, 500)))
    cur = conn.execute(
        f"SELECT {', '.join(CONTENT_COLUMNS)} FROM contents WHERE {where} "
        f"ORDER BY downloaded_at DESC LIMIT ?",
        params,
    )
    return [dict(zip(CONTENT_COLUMNS, r)) for r in cur.fetchall()]


def podcast_missing_count(watch_id: str) -> int:
    """Contents of a watch that don't yet have a prepared audio rendition."""
    conn = _reader()
    if conn is None:
        return 0
    return conn.execute(
        "SELECT COUNT(*) FROM contents WHERE watch_id = ? AND (audio_path IS NULL OR audio_path = '')",
        (watch_id,),
    ).fetchone()[0]


def contents_without_audio(watch_ids: list[str]) -> list[dict[str, Any]]:
    """Contents of the given watches lacking audio (for the backfill)."""
    conn = _reader()
    if conn is None or not watch_ids:
        return []
    ph = ", ".join("?" for _ in watch_ids)
    cur = conn.execute(
        f"SELECT {', '.join(CONTENT_COLUMNS)} FROM contents "
        f"WHERE watch_id IN ({ph}) AND (audio_path IS NULL OR audio_path = '') "
        "ORDER BY downloaded_at ASC",
        watch_ids,
    )
    return [dict(zip(CONTENT_COLUMNS, r)) for r in cur.fetchall()]


def podcast_stats() -> dict[str, Any]:
    conn = _reader()
    if conn is None:
        return {"episodes_ready": 0, "audio_bytes": 0}
    ready = conn.execute(
        "SELECT COUNT(*) FROM contents WHERE audio_path IS NOT NULL AND audio_path != ''"
    ).fetchone()[0]
    total_bytes = conn.execute(
        "SELECT COALESCE(SUM(audio_bytes), 0) FROM contents WHERE audio_path IS NOT NULL"
    ).fetchone()[0]
    return {"episodes_ready": ready, "audio_bytes": int(total_bytes or 0)}


# --- Generation jobs -------------------------------------------------------
GJOB_COLUMNS = [
    "id", "content_id", "task", "title", "status", "error", "model",
    "calls", "created_at", "started_at", "finished_at",
]


def gjob_upsert(row: dict[str, Any]) -> None:
    if _conn is None:
        return
    cols = ", ".join(GJOB_COLUMNS)
    placeholders = ", ".join("?" for _ in GJOB_COLUMNS)
    values = [row.get(c) for c in GJOB_COLUMNS]
    with _LOCK:
        _conn.execute(
            f"INSERT OR REPLACE INTO generation_jobs ({cols}) VALUES ({placeholders})", values
        )
        _conn.commit()


def gjob_all() -> list[dict[str, Any]]:
    conn = _reader()
    if conn is None:
        return []
    cur = conn.execute(
        f"SELECT {', '.join(GJOB_COLUMNS)} FROM generation_jobs ORDER BY created_at ASC"
    )
    return [dict(zip(GJOB_COLUMNS, r)) for r in cur.fetchall()]


# --- Transcript jobs -------------------------------------------------------
TJOB_COLUMNS = [
    "id", "content_id", "title", "status", "progress", "model",
    "created_at", "started_at", "duration_ms", "error",
]


def tjob_upsert(row: dict[str, Any]) -> None:
    if _conn is None:
        return
    cols = ", ".join(TJOB_COLUMNS)
    placeholders = ", ".join("?" for _ in TJOB_COLUMNS)
    values = [row.get(c) for c in TJOB_COLUMNS]
    with _LOCK:
        _conn.execute(
            f"INSERT OR REPLACE INTO transcript_jobs ({cols}) VALUES ({placeholders})", values
        )
        _conn.commit()


def tjob_delete(job_id: str) -> None:
    if _conn is None:
        return
    with _LOCK:
        _conn.execute("DELETE FROM transcript_jobs WHERE id = ?", (job_id,))
        _conn.commit()


def tjob_all() -> list[dict[str, Any]]:
    if _conn is None:
        return []
    with _LOCK:
        cur = _conn.execute(
            f"SELECT {', '.join(TJOB_COLUMNS)} FROM transcript_jobs ORDER BY created_at ASC"
        )
        return [dict(zip(TJOB_COLUMNS, r)) for r in cur.fetchall()]


def tjob_get(job_id: str) -> dict[str, Any] | None:
    if _conn is None:
        return None
    with _LOCK:
        cur = _conn.execute(
            f"SELECT {', '.join(TJOB_COLUMNS)} FROM transcript_jobs WHERE id = ?", (job_id,)
        )
        row = cur.fetchone()
    return dict(zip(TJOB_COLUMNS, row)) if row else None


# --- Transcript segments ---------------------------------------------------
def segments_replace(content_id: str, segments: list[tuple[int, int, str]]) -> None:
    """Replace all segments for a content (idempotent re-transcription)."""
    if _conn is None:
        return
    with _LOCK:
        _conn.execute("DELETE FROM transcript_segments WHERE content_id = ?", (content_id,))
        _conn.executemany(
            "INSERT INTO transcript_segments (content_id, start_ms, end_ms, text) VALUES (?, ?, ?, ?)",
            [(content_id, s, e, t) for (s, e, t) in segments],
        )
        _conn.commit()


def segments_get(content_id: str) -> list[dict[str, Any]]:
    conn = _reader()
    if conn is None:
        return []
    cur = conn.execute(
        "SELECT start_ms, end_ms, text FROM transcript_segments "
        "WHERE content_id = ? ORDER BY start_ms ASC",
        (content_id,),
    )
    return [{"start_ms": r[0], "end_ms": r[1], "text": r[2]} for r in cur.fetchall()]


def segments_delete(content_id: str) -> None:
    if _conn is None:
        return
    with _LOCK:
        _conn.execute("DELETE FROM transcript_segments WHERE content_id = ?", (content_id,))
        _conn.commit()


# --- Search: FTS + chunks + vectors ----------------------------------------
def content_set_index(content_id: str, status: str) -> None:
    if _conn is None:
        return
    with _LOCK:
        _conn.execute("UPDATE contents SET index_status = ? WHERE id = ?", (status, content_id))
        # Any index change invalidates the related-contents caches (see related_cache).
        _bump_index_version()
        _conn.commit()


def index_version() -> int:
    """Monotonic counter bumped on every index change; keys the related cache."""
    conn = _reader()
    if conn is None:
        return 0
    cur = conn.execute("SELECT value FROM meta WHERE key = 'index_version'").fetchone()
    return int(cur[0]) if cur and cur[0] else 0


def contents_to_index() -> list[dict[str, Any]]:
    """Content with transcript segments (or importable subs) not yet indexed."""
    if _conn is None:
        return []
    with _LOCK:
        cur = _conn.execute(
            f"SELECT {', '.join(CONTENT_COLUMNS)} FROM contents "
            "WHERE index_status IS NULL OR index_status != 'done'"
        )
        return [dict(zip(CONTENT_COLUMNS, r)) for r in cur.fetchall()]


def segments_fts_sync(content_id: str) -> None:
    """Rebuild segments_fts rows for a content (covers segments that predate the
    sync trigger, and is idempotent alongside it)."""
    if _conn is None:
        return
    with _LOCK:
        _conn.execute("DELETE FROM segments_fts WHERE content_id = ?", (content_id,))
        _conn.execute(
            "INSERT INTO segments_fts(rowid, text, content_id, start_ms) "
            "SELECT id, text, content_id, start_ms FROM transcript_segments WHERE content_id = ?",
            (content_id,),
        )
        _conn.commit()


def index_clear(content_id: str) -> None:
    """Drop a content's chunks + vectors (re-transcription / reindex)."""
    if _conn is None:
        return
    with _LOCK:
        ids = [r[0] for r in _conn.execute(
            "SELECT id FROM transcript_chunks WHERE content_id = ?", (content_id,)
        ).fetchall()]
        if ids and VEC_OK:
            _conn.executemany("DELETE FROM vec_chunks WHERE chunk_id = ?", [(i,) for i in ids])
        _conn.execute("DELETE FROM transcript_chunks WHERE content_id = ?", (content_id,))
        _conn.commit()


def chunks_insert(content_id: str, chunks: list[tuple[int, int, str]]) -> list[int]:
    """Insert chunks and return their row ids (aligned with `chunks`)."""
    if _conn is None:
        return []
    ids: list[int] = []
    with _LOCK:
        for start, end, text in chunks:
            cur = _conn.execute(
                "INSERT INTO transcript_chunks (content_id, start_ms, end_ms, text) VALUES (?, ?, ?, ?)",
                (content_id, start, end, text),
            )
            ids.append(int(cur.lastrowid))
        _conn.commit()
    return ids


def vec_insert(rows: list[tuple[int, bytes]]) -> None:
    """rows: (chunk_id, serialized float32 embedding)."""
    if _conn is None or not VEC_OK:
        return
    with _LOCK:
        _conn.executemany("INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)", rows)
        _conn.commit()


def _fts_query(tokens: list[str]) -> str:
    # OR the quoted terms for recall; bm25 handles ranking. "" if no tokens.
    return " OR ".join(f'"{t}"' for t in tokens if t)


def fts_segments(tokens: list[str], limit: int, content_id: str | None = None) -> list[dict[str, Any]]:
    conn = _reader()
    if conn is None:
        return []
    q = _fts_query(tokens)
    if not q:
        return []
    where = "segments_fts MATCH ?"
    params: list[Any] = [q]
    if content_id:
        where += " AND content_id = ?"
        params.append(content_id)
    params.append(limit)
    try:
        cur = conn.execute(
            f"SELECT content_id, start_ms, "
            f"snippet(segments_fts, 0, char(2), char(3), '…', 12) AS snip, "
            f"bm25(segments_fts) AS rank "
            f"FROM segments_fts WHERE {where} ORDER BY rank LIMIT ?",
            params,
        )
        return [{"content_id": r[0], "start_ms": r[1], "snippet": r[2], "rank": r[3]} for r in cur.fetchall()]
    except Exception:  # noqa: BLE001 — malformed FTS query
        return []


def fts_contents(tokens: list[str], limit: int, content_id: str | None = None) -> list[dict[str, Any]]:
    conn = _reader()
    if conn is None:
        return []
    q = _fts_query(tokens)
    if not q:
        return []
    where = "contents_fts MATCH ?"
    params: list[Any] = [q]
    if content_id:
        where += " AND content_id = ?"
        params.append(content_id)
    params.append(limit)
    try:
        cur = conn.execute(
            f"SELECT content_id, bm25(contents_fts) AS rank "
            f"FROM contents_fts WHERE {where} ORDER BY rank LIMIT ?",
            params,
        )
        return [{"content_id": r[0], "rank": r[1]} for r in cur.fetchall()]
    except Exception:  # noqa: BLE001
        return []


def vec_knn(embedding_blob: bytes, k: int) -> list[dict[str, Any]]:
    conn = _reader()
    if conn is None or not VEC_OK:
        return []
    try:
        # The LIMIT/k constraint must sit directly on the vec0 scan, so run
        # the KNN in a subquery and join chunk metadata around it.
        cur = conn.execute(
            "SELECT c.content_id, c.start_ms, c.end_ms, c.text, k.distance "
            "FROM (SELECT chunk_id, distance FROM vec_chunks "
            "      WHERE embedding MATCH ? ORDER BY distance LIMIT ?) k "
            "JOIN transcript_chunks c ON c.id = k.chunk_id "
            "ORDER BY k.distance",
            (embedding_blob, k),
        )
        return [
            {"content_id": r[0], "start_ms": r[1], "end_ms": r[2], "text": r[3], "distance": r[4]}
            for r in cur.fetchall()
        ]
    except Exception as exc:  # noqa: BLE001
        print(f"[db] vec_knn: {exc}", flush=True)
        return []


def chunks_of(content_id: str) -> list[dict[str, Any]]:
    """A content's semantic chunks (id + span + text), ordered — the unit used to
    compute cross-content similarity for 'related'."""
    conn = _reader()
    if conn is None:
        return []
    cur = conn.execute(
        "SELECT id, start_ms, end_ms, text FROM transcript_chunks "
        "WHERE content_id = ? ORDER BY start_ms ASC",
        (content_id,),
    )
    return [{"id": r[0], "start_ms": r[1], "end_ms": r[2], "text": r[3]} for r in cur.fetchall()]


def vec_get(chunk_id: int) -> bytes | None:
    """The stored float32 embedding blob for a chunk (reused as a KNN query so we
    never re-embed when computing related contents). None if vec unavailable."""
    conn = _reader()
    if conn is None or not VEC_OK:
        return None
    try:
        row = conn.execute("SELECT embedding FROM vec_chunks WHERE chunk_id = ?", (chunk_id,)).fetchone()
    except Exception:  # noqa: BLE001
        return None
    return row[0] if row and row[0] is not None else None


# --- Related-contents cache ------------------------------------------------
def related_cache_get(content_id: str, version: int) -> str | None:
    """Cached related payload for a content, only if still fresh (matching the
    current index version). Returns the JSON string, or None on miss/stale."""
    conn = _reader()
    if conn is None:
        return None
    row = conn.execute(
        "SELECT payload FROM related_cache WHERE content_id = ? AND index_version = ?",
        (content_id, version),
    ).fetchone()
    return row[0] if row else None


def related_cache_set(content_id: str, version: int, payload: str) -> None:
    if _conn is None:
        return
    with _LOCK:
        _conn.execute(
            "INSERT OR REPLACE INTO related_cache (content_id, index_version, payload) "
            "VALUES (?, ?, ?)",
            (content_id, version, payload),
        )
        _conn.commit()


# --- North-star instrumentation (LOCAL only) -------------------------------
def search_event_insert(query_hash: str, results_count: int) -> None:
    """Record one search. `clicked` stays 0 until a result is opened."""
    if _conn is None:
        return
    with _LOCK:
        _conn.execute(
            "INSERT INTO search_events (ts, query_hash, results_count, clicked) VALUES (?, ?, ?, 0)",
            (time.time(), query_hash, int(results_count)),
        )
        _conn.commit()


def search_event_mark_clicked(query_hash: str) -> None:
    """Flip the most recent (recent = last hour) search for this query to a
    'retrouvaille'. Idempotent-ish: only the latest matching row is marked."""
    if _conn is None:
        return
    with _LOCK:
        row = _conn.execute(
            "SELECT id FROM search_events WHERE query_hash = ? AND clicked = 0 "
            "AND ts >= ? ORDER BY ts DESC LIMIT 1",
            (query_hash, time.time() - 3600),
        ).fetchone()
        if row:
            _conn.execute("UPDATE search_events SET clicked = 1 WHERE id = ?", (row[0],))
            _conn.commit()


def search_metrics(window_days: int = 7) -> dict[str, Any]:
    """Aggregate local usage for the 'Votre mémoire travaille' card. A
    'retrouvaille' = a search that led to opening a result."""
    conn = _reader()
    if conn is None:
        return {"retrievals_week": 0, "searches_week": 0, "retrievals_total": 0}
    since = time.time() - window_days * 86400
    searches_week = conn.execute(
        "SELECT COUNT(*) FROM search_events WHERE ts >= ?", (since,)
    ).fetchone()[0]
    retrievals_week = conn.execute(
        "SELECT COUNT(*) FROM search_events WHERE clicked = 1 AND ts >= ?", (since,)
    ).fetchone()[0]
    retrievals_total = conn.execute(
        "SELECT COUNT(*) FROM search_events WHERE clicked = 1"
    ).fetchone()[0]
    return {
        "retrievals_week": retrievals_week,
        "searches_week": searches_week,
        "retrievals_total": retrievals_total,
        "window_days": window_days,
    }


def index_stats() -> dict[str, Any]:
    conn = _reader()
    if conn is None:
        return {}
    total = conn.execute("SELECT COUNT(*) FROM contents").fetchone()[0]
    indexed = conn.execute("SELECT COUNT(*) FROM contents WHERE index_status = 'done'").fetchone()[0]
    chunks = conn.execute("SELECT COUNT(*) FROM transcript_chunks").fetchone()[0]
    try:
        page_count = conn.execute("PRAGMA page_count").fetchone()[0]
        page_size = conn.execute("PRAGMA page_size").fetchone()[0]
        db_bytes = page_count * page_size
    except Exception:  # noqa: BLE001
        db_bytes = 0
    return {"total": total, "indexed": indexed, "chunks": chunks, "db_bytes": db_bytes, "vec_ok": VEC_OK}


def index_rebuild_drop() -> None:
    """Drop all chunks + vectors + mark every content for reindex."""
    if _conn is None:
        return
    with _LOCK:
        if VEC_OK:
            _conn.execute("DELETE FROM vec_chunks")
        _conn.execute("DELETE FROM transcript_chunks")
        _conn.execute("UPDATE contents SET index_status = 'none'")
        _conn.commit()


def record_pipeline_run(
    job_id: str, plugin_id: str, stage: str, status: str,
    duration: float, error: str = "",
) -> None:
    """Log one pipeline step (processor/output) for observability."""
    if _conn is None:
        return
    with _LOCK:
        _conn.execute(
            "INSERT INTO pipeline_runs (job_id, plugin_id, stage, status, duration, error, at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (job_id, plugin_id, stage, status, duration, error, time.time()),
        )
        _conn.commit()


def recent_pipeline_runs(limit: int = 100) -> list[dict[str, Any]]:
    if _conn is None:
        return []
    cols = ["job_id", "plugin_id", "stage", "status", "duration", "error", "at"]
    with _LOCK:
        cur = _conn.execute(
            f"SELECT {', '.join(cols)} FROM pipeline_runs ORDER BY id DESC LIMIT ?",
            (limit,),
        )
        return [dict(zip(cols, r)) for r in cur.fetchall()]


def upsert(row: dict[str, Any]) -> None:
    """Insert or replace a job row. Missing keys default to NULL / []."""
    if _conn is None:
        return
    data = dict(row)
    for col in _JSON_COLS:
        data[col] = json.dumps(data.get(col) or [])
    cols = ", ".join(COLUMNS)
    placeholders = ", ".join("?" for _ in COLUMNS)
    values = [data.get(col) for col in COLUMNS]
    with _LOCK:
        _conn.execute(
            f"INSERT OR REPLACE INTO jobs ({cols}) VALUES ({placeholders})", values
        )
        _conn.commit()


def delete(job_id: str) -> None:
    if _conn is None:
        return
    with _LOCK:
        _conn.execute("DELETE FROM jobs WHERE id = ?", (job_id,))
        _conn.commit()


def load_all() -> list[dict[str, Any]]:
    """Every persisted job as a dict, JSON columns decoded back to lists."""
    if _conn is None:
        return []
    with _LOCK:
        cur = _conn.execute(f"SELECT {', '.join(COLUMNS)} FROM jobs")
        rows = cur.fetchall()
    out: list[dict[str, Any]] = []
    for row in rows:
        d = dict(zip(COLUMNS, row))
        for col in _JSON_COLS:
            try:
                d[col] = json.loads(d[col]) if d[col] else []
            except (TypeError, json.JSONDecodeError):
                d[col] = []
        out.append(d)
    return out
