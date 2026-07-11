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


# --- Key/value meta --------------------------------------------------------
def meta_get(key: str) -> str | None:
    if _conn is None:
        return None
    with _LOCK:
        cur = _conn.execute("SELECT value FROM meta WHERE key = ?", (key,))
        row = cur.fetchone()
    return row[0] if row else None


def meta_set(key: str, value: str) -> None:
    if _conn is None:
        return
    with _LOCK:
        _conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", (key, value))
        _conn.commit()


# --- Contents (library) ----------------------------------------------------
CONTENT_COLUMNS = [
    "id", "source", "source_id", "url", "title", "description", "channel",
    "channel_url", "duration_seconds", "uploaded_at", "downloaded_at",
    "filepath", "filesize", "thumbnail_path", "watch_id", "kind",
    "transcript_status", "index_status", "language",
]
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
    # a re-download must not wipe a detected language or transcript status).
    updatable = [
        c for c in CONTENT_COLUMNS
        if c not in ("id", "filepath", "transcript_status", "index_status", "language")
    ]
    set_clause = ", ".join(f"{c}=excluded.{c}" for c in updatable)
    with _LOCK:
        _conn.execute(
            f"INSERT INTO contents ({cols}) VALUES ({placeholders}) "
            f"ON CONFLICT(filepath) DO UPDATE SET {set_clause}",
            values,
        )
        _conn.commit()


def content_get(content_id: str) -> dict[str, Any] | None:
    if _conn is None:
        return None
    with _LOCK:
        cur = _conn.execute(
            f"SELECT {', '.join(CONTENT_COLUMNS)} FROM contents WHERE id = ?", (content_id,)
        )
        row = cur.fetchone()
    return dict(zip(CONTENT_COLUMNS, row)) if row else None


def content_by_filepath(filepath: str) -> dict[str, Any] | None:
    if _conn is None:
        return None
    with _LOCK:
        cur = _conn.execute(
            f"SELECT {', '.join(CONTENT_COLUMNS)} FROM contents WHERE filepath = ?", (filepath,)
        )
        row = cur.fetchone()
    return dict(zip(CONTENT_COLUMNS, row)) if row else None


def content_filepaths() -> set[str]:
    if _conn is None:
        return set()
    with _LOCK:
        cur = _conn.execute("SELECT filepath FROM contents")
        return {r[0] for r in cur.fetchall() if r[0]}


def content_delete(content_id: str) -> str | None:
    """Remove a content row; returns its filepath so the caller can optionally
    delete the file too."""
    if _conn is None:
        return None
    with _LOCK:
        cur = _conn.execute("SELECT filepath FROM contents WHERE id = ?", (content_id,))
        row = cur.fetchone()
        if not row:
            return None
        _conn.execute("DELETE FROM contents WHERE id = ?", (content_id,))
        _conn.commit()
    return row[0]


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
    with _LOCK:
        total = _conn.execute(f"SELECT COUNT(*) FROM contents{clause}", params).fetchone()[0]
        cur = _conn.execute(
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
    if _conn is None:
        return []
    with _LOCK:
        cur = _conn.execute(
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
        _conn.commit()


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
    if _conn is None:
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
    with _LOCK:
        try:
            cur = _conn.execute(
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
    if _conn is None:
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
    with _LOCK:
        try:
            cur = _conn.execute(
                f"SELECT content_id, bm25(contents_fts) AS rank "
                f"FROM contents_fts WHERE {where} ORDER BY rank LIMIT ?",
                params,
            )
            return [{"content_id": r[0], "rank": r[1]} for r in cur.fetchall()]
        except Exception:  # noqa: BLE001
            return []


def vec_knn(embedding_blob: bytes, k: int) -> list[dict[str, Any]]:
    if _conn is None or not VEC_OK:
        return []
    with _LOCK:
        try:
            # The LIMIT/k constraint must sit directly on the vec0 scan, so run
            # the KNN in a subquery and join chunk metadata around it.
            cur = _conn.execute(
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


def index_stats() -> dict[str, Any]:
    if _conn is None:
        return {}
    with _LOCK:
        total = _conn.execute("SELECT COUNT(*) FROM contents").fetchone()[0]
        indexed = _conn.execute("SELECT COUNT(*) FROM contents WHERE index_status = 'done'").fetchone()[0]
        chunks = _conn.execute("SELECT COUNT(*) FROM transcript_chunks").fetchone()[0]
        try:
            page_count = _conn.execute("PRAGMA page_count").fetchone()[0]
            page_size = _conn.execute("PRAGMA page_size").fetchone()[0]
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
