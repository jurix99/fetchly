"""Library: the `contents` table is the source of truth for downloaded media
(no per-request disk scan). Rows are created by the pipeline on each download
and by an explicit (re)scan of the existing library.
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import threading
import time
import urllib.request
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import quote

from . import db
from .runtime import DOWNLOAD_DIR, MEDIA_EXTS

_ID_RE = re.compile(r"\[([A-Za-z0-9_-]{6,})\]\s*$")
_AUDIO_EXTS = {"mp3", "m4a", "opus", "flac", "wav", "aac", "ogg"}
THUMBS_DIR = DOWNLOAD_DIR / ".fetchly" / "thumbs"
_HIDDEN = ".fetchly"


def _kind_for(path: Path) -> str:
    return "audio" if path.suffix.lstrip(".").lower() in _AUDIO_EXTS else "video"


def _thumb_key(source: str, source_id: str, filepath: str) -> str:
    sid = source_id or hashlib.md5(filepath.encode("utf-8")).hexdigest()[:12]
    safe = re.sub(r"[^A-Za-z0-9_-]", "", f"{source}_{sid}") or "thumb"
    return safe


def _store_thumb(local_jpg: Path, thumb_url: str, key: str) -> str:
    """Copy the already-downloaded jpg (no network) into the served thumbs dir,
    falling back to fetching the URL. Returns the stored path, or ""."""
    try:
        THUMBS_DIR.mkdir(parents=True, exist_ok=True)
    except OSError:
        return ""
    dest = THUMBS_DIR / f"{key}.jpg"
    try:
        if local_jpg and local_jpg.exists():
            shutil.copyfile(local_jpg, dest)
            return str(dest)
    except OSError:
        pass
    if thumb_url:
        try:
            req = urllib.request.Request(thumb_url, headers={"User-Agent": "Fetchly"})
            with urllib.request.urlopen(req, timeout=10) as r:
                data = r.read()
            if data:
                dest.write_bytes(data)
                return str(dest)
        except Exception:  # noqa: BLE001
            pass
    return ""


def _media_url(abspath: str | None) -> str | None:
    if not abspath:
        return None
    try:
        rel = Path(abspath).resolve().relative_to(DOWNLOAD_DIR.resolve()).as_posix()
        return "/media/" + quote(rel)
    except ValueError:
        return None


def to_public(row: dict[str, Any]) -> dict[str, Any]:
    """A content row as the API exposes it: adds thumbnail/stream URLs + whether
    the file is still on disk."""
    d = dict(row)
    d["thumbnail_url"] = _media_url(row.get("thumbnail_path"))
    d["stream_url"] = f"/api/library/{row['id']}/stream"
    fp = row.get("filepath")
    d["file_exists"] = bool(fp and Path(fp).exists())
    return d


# --- Indexing from a fresh download ---------------------------------------
def index_download(job: Any, result: Any) -> None:
    """Create/upsert a content row per media file produced by a download."""
    watch_id = job.watch_id if getattr(job, "kind", "") == "watch" else None
    for item in getattr(result, "items", None) or []:
        fp = item.filepath
        if not fp or not Path(fp).exists():
            continue
        try:
            _index_item(item, watch_id, downloaded_at=time.time())
        except Exception as exc:  # noqa: BLE001 — library indexing never fails a DL
            print(f"[library] index {fp}: {exc}", flush=True)


def _index_item(item: Any, watch_id: str | None, downloaded_at: float) -> None:
    path = Path(item.filepath)
    source = item.source or "youtube"
    key = _thumb_key(source, item.id or "", str(path))
    thumb = _store_thumb(path.with_suffix(".jpg"), item.thumbnail or "", key)
    db.content_upsert({
        "id": str(uuid.uuid4()),
        "source": source,
        "source_id": item.id or "",
        "url": item.url or "",
        "title": item.title or path.stem,
        "description": item.description or "",
        "channel": item.channel or path.parent.name,
        "channel_url": item.channel_url or "",
        "duration_seconds": item.duration,
        "uploaded_at": item.uploaded_at or "",
        "downloaded_at": downloaded_at,
        "filepath": str(path),
        "filesize": _safe_size(path),
        "thumbnail_path": thumb,
        "watch_id": watch_id,
        "kind": _kind_for(path),
        "transcript_status": "none",
        "index_status": "none",
    })


def _safe_size(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


# --- (Re)scan of the existing library -------------------------------------
def _media_files() -> list[Path]:
    out: list[Path] = []
    for p in DOWNLOAD_DIR.rglob("*"):
        if _HIDDEN in p.parts:
            continue
        if p.is_file() and p.suffix.lstrip(".").lower() in MEDIA_EXTS:
            out.append(p)
    return out


def _index_from_file(path: Path) -> None:
    info: dict[str, Any] = {}
    infojson = path.with_suffix(".info.json")
    if infojson.exists():
        try:
            info = json.loads(infojson.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            info = {}
    stem = path.stem
    m = _ID_RE.search(stem)
    sid = info.get("id") or (m.group(1) if m else "")
    title = info.get("title") or (stem[: m.start()].strip() if m else stem)
    source = (info.get("extractor_key") or info.get("extractor") or "youtube").lower()
    url = info.get("webpage_url") or (f"https://www.youtube.com/watch?v={sid}" if sid else "")
    key = _thumb_key(source, sid, str(path))
    thumb = _store_thumb(path.with_suffix(".jpg"), info.get("thumbnail") or "", key)
    db.content_upsert({
        "id": str(uuid.uuid4()),
        "source": source,
        "source_id": sid,
        "url": url,
        "title": title,
        "description": info.get("description") or "",
        "channel": info.get("uploader") or info.get("channel") or path.parent.name,
        "channel_url": info.get("channel_url") or info.get("uploader_url") or "",
        "duration_seconds": info.get("duration"),
        "uploaded_at": str(info.get("upload_date") or ""),
        "downloaded_at": path.stat().st_mtime if path.exists() else time.time(),
        "filepath": str(path),
        "filesize": _safe_size(path),
        "thumbnail_path": thumb,
        "watch_id": None,
        "kind": _kind_for(path),
        "transcript_status": "none",
        "index_status": "none",
    })


def _scan(job: Any = None) -> int:
    """Index every media file not already in the library. Optionally drive a
    task job's progress. Returns how many were newly indexed."""
    existing = db.content_filepaths()
    files = _media_files()
    if job is not None:
        job.total = len(files)
        _persist_job(job)
    indexed = 0
    last = 0.0
    for i, path in enumerate(files):
        if str(path) not in existing:
            try:
                _index_from_file(path)
                indexed += 1
            except Exception as exc:  # noqa: BLE001
                print(f"[library] scan {path}: {exc}", flush=True)
        if job is not None:
            job.completed = i + 1
            now = time.time()
            if now - last >= 1.0:
                last = now
                job.current_title = path.name
                _persist_job(job)
    return indexed


def _persist_job(job: Any) -> None:
    from . import jobs as jobs_mod
    jobs_mod.persist(job)


def migrate_existing() -> None:
    """One-time backfill of the library from disk, guarded by a DB flag. Runs in
    a background thread so startup isn't blocked on a large library."""
    if db.meta_get("library_migrated") == "1":
        return

    def run() -> None:
        try:
            n = _scan()
            db.meta_set("library_migrated", "1")
            if n:
                print(f"[startup] library migration indexed {n} file(s)", flush=True)
        except Exception as exc:  # noqa: BLE001
            print(f"[startup] library migration failed: {exc}", flush=True)

    threading.Thread(target=run, daemon=True).start()


def rescan() -> str:
    """Re-index the library as a visible background task. Returns the job id."""
    from . import jobs as jobs_mod
    job = jobs_mod.create_task("Analyse de la bibliothèque")
    def run() -> None:
        try:
            n = _scan(job)
            job.status = "done"
            job.finished_at = time.time()
            job.log.append(f"Bibliothèque analysée — {n} nouveau(x) contenu(s) indexé(s).")
        except Exception as exc:  # noqa: BLE001
            job.status = "error"
            job.error = str(exc)
            job.finished_at = time.time()
        _persist_job(job)
    threading.Thread(target=run, daemon=True).start()
    return job.id


# --- Streaming resolution (path-traversal safe) ---------------------------
def resolve_media(content_id: str) -> Path | None:
    """Absolute path of a content's media file, verified to live inside the
    downloads dir. None if unknown, escaping, or missing on disk."""
    row = db.content_get(content_id)
    if not row or not row.get("filepath"):
        return None
    try:
        path = Path(row["filepath"]).resolve()
        path.relative_to(DOWNLOAD_DIR.resolve())  # raises if outside
    except (ValueError, OSError):
        return None
    return path if path.is_file() else None
