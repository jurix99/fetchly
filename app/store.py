"""Persistent config + watch list, stored as JSON under /config so it survives
container restarts. yt-dlp's download archive lives here too, which is how
watches avoid re-downloading videos that are already on disk."""

from __future__ import annotations

import json
import os
import threading
import uuid
from pathlib import Path
from typing import Any

CONFIG_DIR = Path(os.environ.get("CONFIG_DIR", "/config"))
CONFIG_FILE = CONFIG_DIR / "config.json"
ARCHIVE_FILE = CONFIG_DIR / "download-archive.txt"
WATCH_VIDEOS_DIR = CONFIG_DIR / "watch-videos"

_LOCK = threading.Lock()
_VIDEOS_LOCK = threading.Lock()

# organize: how downloaded files are foldered under /downloads
#   "uploader" -> <uploader>/<title>      "playlist" -> <playlist or uploader>/<title>
#   "flat"     -> <title>
DEFAULTS: dict[str, Any] = {
    "default_quality": "1080",
    "watch_interval_minutes": 30,
    "organize": "playlist",
    "max_concurrent": 3,  # how many videos a backfill downloads in parallel
    "watches": [],
}


def _read() -> dict[str, Any]:
    try:
        with CONFIG_FILE.open(encoding="utf-8") as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        data = {}
    for key, value in DEFAULTS.items():
        data.setdefault(key, list(value) if isinstance(value, list) else value)
    return data


def _write(data: dict[str, Any]) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    tmp = CONFIG_FILE.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    tmp.replace(CONFIG_FILE)


def get_config() -> dict[str, Any]:
    with _LOCK:
        return _read()


def get_settings() -> dict[str, Any]:
    cfg = get_config()
    return {
        "default_quality": cfg["default_quality"],
        "watch_interval_minutes": cfg["watch_interval_minutes"],
        "organize": cfg["organize"],
        "max_concurrent": cfg.get("max_concurrent", 3),
    }


def update_settings(
    default_quality: str | None = None,
    watch_interval_minutes: int | None = None,
    organize: str | None = None,
    max_concurrent: int | None = None,
) -> dict[str, Any]:
    with _LOCK:
        cfg = _read()
        if default_quality:
            cfg["default_quality"] = default_quality
        if watch_interval_minutes is not None:
            cfg["watch_interval_minutes"] = max(1, int(watch_interval_minutes))
        if organize in ("uploader", "playlist", "flat"):
            cfg["organize"] = organize
        if max_concurrent is not None:
            cfg["max_concurrent"] = max(1, min(int(max_concurrent), 10))
        _write(cfg)
        return cfg


def list_watches() -> list[dict[str, Any]]:
    return get_config()["watches"]


def add_watch(
    url: str,
    quality: str | None = None,
    backfill: bool = True,
    subfolder: str = "",
    date_after: str = "",
    title: str = "",
    thumbnail: str = "",
) -> dict[str, Any]:
    with _LOCK:
        cfg = _read()
        watch = {
            "id": str(uuid.uuid4()),
            "url": url,
            "quality": quality,  # None -> resolve to default at check time
            "subfolder": subfolder,  # optional destination folder under /downloads
            "date_after": date_after,  # ISO date; only sync newer uploads
            "title": title,  # known channel name (refreshed on first sync)
            "thumbnail": thumbnail,  # known channel avatar (refreshed on sync)
            "enabled": True,
            "backfill": bool(backfill),
            "seeded": False,
            "synced": 0,
            "total": 0,
            "last_checked": None,
            "last_result": "Never checked",
        }
        cfg["watches"].append(watch)
        _write(cfg)
        return watch


def remove_watch(watch_id: str) -> bool:
    with _LOCK:
        cfg = _read()
        before = len(cfg["watches"])
        cfg["watches"] = [w for w in cfg["watches"] if w["id"] != watch_id]
        _write(cfg)
        return len(cfg["watches"]) < before


def update_watch(watch_id: str, **fields: Any) -> dict[str, Any] | None:
    with _LOCK:
        cfg = _read()
        for watch in cfg["watches"]:
            if watch["id"] == watch_id:
                watch.update(fields)
                _write(cfg)
                return watch
        return None


def get_watch(watch_id: str) -> dict[str, Any] | None:
    for watch in get_config()["watches"]:
        if watch["id"] == watch_id:
            return watch
    return None


# --- Per-watch sync memory -------------------------------------------------
# For each watch we remember the list of videos and whether each is downloaded
# ("synced"), so the UI can show what's in sync without re-extracting.
def save_watch_videos(watch_id: str, videos: list[dict[str, Any]]) -> None:
    with _VIDEOS_LOCK:
        WATCH_VIDEOS_DIR.mkdir(parents=True, exist_ok=True)
        path = WATCH_VIDEOS_DIR / f"{watch_id}.json"
        tmp = path.with_suffix(".json.tmp")
        with tmp.open("w", encoding="utf-8") as f:
            json.dump(videos, f, ensure_ascii=False)
        tmp.replace(path)


def load_watch_videos(watch_id: str) -> list[dict[str, Any]]:
    path = WATCH_VIDEOS_DIR / f"{watch_id}.json"
    try:
        with path.open(encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def delete_watch_videos(watch_id: str) -> None:
    with _VIDEOS_LOCK:
        (WATCH_VIDEOS_DIR / f"{watch_id}.json").unlink(missing_ok=True)
