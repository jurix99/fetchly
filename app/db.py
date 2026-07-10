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
    global _conn
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    _conn = sqlite3.connect(str(DB_FILE), check_same_thread=False)
    _conn.execute("PRAGMA journal_mode=WAL")
    _conn.execute("PRAGMA synchronous=NORMAL")
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
    # Small key/value store for one-shot flags (e.g. library migration done).
    _conn.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)")
    _conn.commit()


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
    "transcript_status", "index_status",
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
    # Update everything except id + the processing statuses (owned by later phases).
    updatable = [c for c in CONTENT_COLUMNS if c not in ("id", "filepath", "transcript_status", "index_status")]
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
    kind: str | None = None, q: str | None = None,
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
