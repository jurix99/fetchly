"""Podcast feeds — turn each podcast-enabled subscription into a self-hosted RSS
feed playable in any podcast app. Reliability first: audio is prepared AHEAD OF
TIME (at download / via backfill), never transcoded on demand in the media route.

Audio renditions live under /downloads/.fetchly/audio/{content_id}.{ext} and are
tracked on `contents` (audio_path/audio_bytes) — they are NOT `contents` rows and
are removed by the parent content's delete cascade.
"""

from __future__ import annotations

import shutil
import subprocess
import threading
import time
import xml.etree.ElementTree as ET
from email.utils import formatdate
from pathlib import Path
from typing import Any

from . import db, store
from .plugins.registry import registry
from .runtime import DOWNLOAD_DIR

AUDIO_DIR = DOWNLOAD_DIR / ".fetchly" / "audio"
_ITUNES = "http://www.itunes.com/dtds/podcast-1.0.dtd"
_FEED_LIMIT = 100


class PodcastError(Exception):
    pass


def _settings() -> dict[str, Any]:
    return registry.settings_of("podcast")


def _codec(fmt: str) -> tuple[str, str]:
    return (".opus", "libopus") if fmt == "opus" else (".m4a", "aac")


def _media_type(ext: str) -> str:
    return {".m4a": "audio/mp4", ".aac": "audio/aac", ".opus": "audio/ogg", ".mp3": "audio/mpeg"}.get(
        ext.lower(), "audio/mpeg"
    )


def _ffmpeg() -> str:
    return shutil.which("ffmpeg") or "ffmpeg"


def _safe_size(p: Path) -> int:
    try:
        return p.stat().st_size
    except OSError:
        return 0


# --- audio preparation -----------------------------------------------------
def prepare_audio(content_id: str) -> bool:
    """Produce (or reference) the audio rendition for a content. Audio contents
    reference their own file; videos are extracted (ffmpeg -vn). Raises
    PodcastError on ffmpeg failure so the caller can log it (isolated)."""
    content = db.content_get(content_id)
    if not content:
        return False
    src = Path(content.get("filepath") or "")
    if not src.is_file():
        raise PodcastError("Fichier source introuvable sur le disque")

    if content.get("kind") == "audio":
        db.content_set_audio(content_id, str(src), _safe_size(src))
        return True

    s = _settings()
    ext, codec = _codec(s.get("audio_format", "m4a"))
    bitrate = s.get("bitrate", "96k")
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    out = AUDIO_DIR / f"{content_id}{ext}"
    cmd = [_ffmpeg(), "-nostdin", "-y", "-i", str(src), "-vn", "-c:a", codec, "-b:a", bitrate, str(out)]
    proc = subprocess.run(cmd, capture_output=True, timeout=1800, check=False)
    if proc.returncode != 0 or not out.exists() or out.stat().st_size == 0:
        tail = proc.stderr.decode("utf-8", "replace")[-300:] if proc.stderr else ""
        raise PodcastError(f"Extraction audio échouée (ffmpeg). {tail}")
    db.content_set_audio(content_id, str(out), out.stat().st_size)
    return True


def podcast_watch_ids() -> list[str]:
    return [w["id"] for w in store.list_watches() if w.get("podcast_feed")]


def _run_backfill(job: Any, watch_id: str | None) -> None:
    from . import jobs as jobs_mod
    ids = [watch_id] if watch_id else podcast_watch_ids()
    rows = db.contents_without_audio(ids)
    job.total = len(rows)
    jobs_mod.persist(job)
    done = 0
    last = 0.0
    for i, row in enumerate(rows):
        try:
            if prepare_audio(row["id"]):
                done += 1
        except Exception as exc:  # noqa: BLE001 — one failure never stops the batch
            job.log.append(f"audio {row['id']}: {exc}")
        job.completed = i + 1
        now = time.time()
        if now - last >= 1.0:
            last = now
            jobs_mod.persist(job)
    job.status = "done"
    job.finished_at = time.time()
    job.log.append(f"Audio préparé pour {done} épisode(s).")
    jobs_mod.persist(job)


def backfill(watch_id: str | None = None) -> str:
    from . import jobs as jobs_mod
    job = jobs_mod.create_task("Préparation de l'audio des épisodes")
    threading.Thread(target=_run_backfill, args=(job, watch_id), daemon=True).start()
    return job.id


# --- feed building ---------------------------------------------------------
def itunes_duration(seconds: float | None) -> str:
    s = int(seconds or 0)
    h, m, sec = s // 3600, (s % 3600) // 60, s % 60
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m}:{sec:02d}"


def _pub_date(content: dict[str, Any]) -> str:
    up = str(content.get("uploaded_at") or "")
    if len(up) == 8 and up.isdigit():
        try:
            ts = time.mktime((int(up[:4]), int(up[4:6]), int(up[6:8]), 12, 0, 0, 0, 0, -1))
            return formatdate(ts)
        except (ValueError, OverflowError):
            pass
    return formatdate(content.get("downloaded_at") or time.time())


def _desc(content: dict[str, Any]) -> str:
    text = content.get("summary_short") or content.get("description") or ""
    text = text.strip().replace("\n", " ")
    return text if len(text) <= 500 else text[:500].rstrip() + "…"


def build_feed(scope: str, base_url: str, token: str) -> str | None:
    """RSS 2.0 + itunes for one watch (scope=watch_id) or all podcast watches
    (scope='all'). Returns the XML string, or None if the watch is unknown."""
    base = base_url.rstrip("/")
    if scope == "all":
        title, description, artwork = "Fetchly — Tous les abonnements", "Vos abonnements Fetchly, en audio.", ""
        ids = podcast_watch_ids()
        items = db.podcast_items(ids, _FEED_LIMIT)
    else:
        watch = store.get_watch(scope)
        if not watch:
            return None
        title = watch.get("title") or "Abonnement"
        description = f"Épisodes de {title}, préparés par Fetchly."
        artwork = watch.get("thumbnail") or ""
        items = db.podcast_items([scope], _FEED_LIMIT)

    # register_namespace makes ElementTree emit `xmlns:itunes` on the root itself
    # (don't also set it manually — that yields a duplicate attribute).
    ET.register_namespace("itunes", _ITUNES)
    rss = ET.Element("rss", {"version": "2.0"})
    channel = ET.SubElement(rss, "channel")
    ET.SubElement(channel, "title").text = title
    ET.SubElement(channel, "link").text = base + "/"
    ET.SubElement(channel, "description").text = description
    ET.SubElement(channel, "language").text = "fr"
    ET.SubElement(channel, f"{{{_ITUNES}}}author").text = "Fetchly"
    ET.SubElement(channel, f"{{{_ITUNES}}}summary").text = description
    if artwork:
        ET.SubElement(channel, f"{{{_ITUNES}}}image", {"href": artwork})

    for c in items:
        ext = Path(c.get("audio_path") or "").suffix or ".m4a"
        item = ET.SubElement(channel, "item")
        ET.SubElement(item, "title").text = c.get("title") or "Épisode"
        guid = ET.SubElement(item, "guid", {"isPermaLink": "false"})
        guid.text = c["id"]
        ET.SubElement(item, "pubDate").text = _pub_date(c)
        ET.SubElement(item, "description").text = _desc(c)
        ET.SubElement(item, f"{{{_ITUNES}}}summary").text = _desc(c)
        if c.get("duration_seconds"):
            ET.SubElement(item, f"{{{_ITUNES}}}duration").text = itunes_duration(c["duration_seconds"])
        ET.SubElement(item, "link").text = f"{base}/?content={c['id']}"
        ET.SubElement(item, "enclosure", {
            "url": f"{base}/feeds/media/{c['id']}{ext}?token={token}",
            "length": str(c.get("audio_bytes") or 0),
            "type": _media_type(ext),
        })

    return '<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(rss, encoding="unicode")


# --- stats -----------------------------------------------------------------
def stats() -> dict[str, Any]:
    s = db.podcast_stats()
    return {
        "active_feeds": len(podcast_watch_ids()),
        "episodes_ready": s["episodes_ready"],
        "audio_bytes": s["audio_bytes"],
    }
