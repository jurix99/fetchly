"""Persistent config + watch list, stored as JSON under /config so it survives
container restarts. yt-dlp's download archive lives here too, which is how
watches avoid re-downloading videos that are already on disk."""

from __future__ import annotations

import copy
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
    # Apprise notification settings: a list of service URLs (discord://…,
    # tgram://…, mailto://…, ntfy://…) pinged whenever a video finishes.
    "notifications": {
        "enabled": False,
        "urls": [],
        "on_video": True,    # a video finished downloading
        "on_error": True,    # a download failed
        "on_summary": False, # one digest at the end of a playlist/batch
    },
    # --- Media options (applied to yt-dlp downloads) ---
    "subtitles": False,             # download subtitles
    "subtitle_langs": "fr,en",      # comma list; also accepts "all"
    "embed_subtitles": False,       # mux subs into the file
    "embed_thumbnail": True,        # embed cover art into the file
    "embed_metadata": False,        # write title/artist/etc. tags
    "embed_chapters": False,        # write chapter markers
    "sponsorblock": False,          # SponsorBlock segments
    "sponsorblock_mode": "skip",    # "skip" (cut) | "mark" (chapter only)
    "bandwidth_limit": 0,           # MB/s, 0 = unlimited
    "download_archive": False,      # manual downloads skip already-downloaded
    "min_free_gb": 2,               # refuse to start a download below this free space
    "nfo_export": False,            # write Jellyfin/Plex .nfo + poster sidecars
}

# Media keys that are plain on/off toggles.
_MEDIA_BOOL_KEYS = {
    "subtitles", "embed_subtitles", "embed_thumbnail", "embed_metadata",
    "embed_chapters", "sponsorblock", "download_archive", "nfo_export",
}


def _read() -> dict[str, Any]:
    try:
        with CONFIG_FILE.open(encoding="utf-8") as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        data = {}
    for key, value in DEFAULTS.items():
        # deepcopy so a missing key never aliases (and later mutates) DEFAULTS.
        data.setdefault(key, copy.deepcopy(value))
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
    keys = [
        "default_quality", "watch_interval_minutes", "organize", "max_concurrent",
        "subtitles", "subtitle_langs", "embed_subtitles", "embed_thumbnail",
        "embed_metadata", "embed_chapters", "sponsorblock", "sponsorblock_mode",
        "bandwidth_limit", "download_archive", "min_free_gb", "nfo_export",
    ]
    return {k: cfg.get(k, DEFAULTS.get(k)) for k in keys}


def update_settings(
    default_quality: str | None = None,
    watch_interval_minutes: int | None = None,
    organize: str | None = None,
    max_concurrent: int | None = None,
    media: dict[str, Any] | None = None,
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
        # Validated media options (whitelisted keys, coerced types).
        for key, value in (media or {}).items():
            if key in _MEDIA_BOOL_KEYS:
                cfg[key] = bool(value)
            elif key == "subtitle_langs":
                cfg[key] = str(value or "fr,en")
            elif key == "sponsorblock_mode":
                cfg[key] = value if value in ("skip", "mark") else "skip"
            elif key in ("bandwidth_limit", "min_free_gb"):
                try:
                    cfg[key] = max(0.0, float(value))
                except (TypeError, ValueError):
                    cfg[key] = DEFAULTS[key]
        _write(cfg)
        return cfg


# --- Notifications ---------------------------------------------------------
_NOTIFY_EVENT_KEYS = ("on_video", "on_error", "on_summary")


def get_notifications() -> dict[str, Any]:
    cfg = get_config()
    n = cfg.get("notifications") or {}
    defaults = DEFAULTS["notifications"]
    out: dict[str, Any] = {
        "enabled": bool(n.get("enabled", False)),
        "urls": [u for u in n.get("urls", []) if isinstance(u, str)],
    }
    for key in _NOTIFY_EVENT_KEYS:
        out[key] = bool(n.get(key, defaults[key]))
    return out


def update_notifications(
    enabled: bool | None = None,
    urls: list[str] | None = None,
    events: dict[str, Any] | None = None,
) -> dict[str, Any]:
    with _LOCK:
        cfg = _read()
        n = cfg.get("notifications") or dict(DEFAULTS["notifications"])
        if enabled is not None:
            n["enabled"] = bool(enabled)
        if urls is not None:
            # Drop blanks/whitespace; one service URL per entry.
            n["urls"] = [u.strip() for u in urls if isinstance(u, str) and u.strip()]
        for key in _NOTIFY_EVENT_KEYS:
            if events and key in events and events[key] is not None:
                n[key] = bool(events[key])
        cfg["notifications"] = n
        _write(cfg)
    return get_notifications()


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
