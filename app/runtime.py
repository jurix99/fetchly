"""Shared runtime constants and host-level helpers (disk space, memory, paths).

Extracted from the former monolith so every module (jobs, routes, the yt-dlp
plugin) can share them without importing FastAPI or yt_dlp.
"""

from __future__ import annotations

import ctypes
import ctypes.util
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path

from . import notify, store

BASE_DIR = Path(__file__).resolve().parent
# Mounted as a volume in Docker; override with DOWNLOAD_DIR for custom NAS shares.
DOWNLOAD_DIR = Path(os.environ.get("DOWNLOAD_DIR", "/downloads"))
DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)

WEB_DIR = BASE_DIR / "web"  # built SPA (Next.js static export, copied in Docker)
WEB_DIR.mkdir(exist_ok=True)

# bgutil PO-token provider (sidecar container). YouTube increasingly requires a
# proof-of-origin token; the bgutil-ytdlp-pot-provider plugin fetches one here.
POT_PROVIDER_URL = os.environ.get("POT_PROVIDER_URL", "http://bgutil-provider:4416")

# Extensions shown in the Library (video + extracted audio).
MEDIA_EXTS = ("mp4", "mkv", "webm", "mp3", "m4a")

_GB = 1024 ** 3


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# --- Memory ----------------------------------------------------------------
_LIBC = None
try:
    _LIBC = ctypes.CDLL(ctypes.util.find_library("c") or "libc.so.6", use_errno=False)
except Exception:  # noqa: BLE001
    _LIBC = None


def _release_memory() -> None:
    """Hand freed heap back to the OS. After a big extraction/download CPython
    keeps the arena, so the container's RSS stays inflated (looks like a leak)
    even when idle. malloc_trim() returns the unused pages to the kernel."""
    if _LIBC is not None:
        try:
            _LIBC.malloc_trim(0)
        except Exception:  # noqa: BLE001
            pass


def _drop_file_cache(path: str) -> None:
    """Evict a just-downloaded file from the page cache. Writing big videos fills
    the kernel cache, which the NAS reports as (reclaimable) container memory and
    which lingers as long as there's free RAM. We won't re-read the file, so tell
    the kernel to drop it — keeps reported memory from staying inflated."""
    try:
        fd = os.open(path, os.O_RDONLY)
        try:
            os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED)
        finally:
            os.close(fd)
    except (OSError, AttributeError):  # AttributeError: non-Linux (no fadvise)
        pass


# --- Disk space ------------------------------------------------------------
_disk_low_notified = False  # debounce so the "low disk" alert fires once


def _disk_info() -> dict[str, float]:
    """Free/total/used bytes for the downloads volume, plus a percent used."""
    try:
        usage = shutil.disk_usage(DOWNLOAD_DIR)
        pct = (usage.used / usage.total * 100) if usage.total else 0.0
        return {"free": usage.free, "total": usage.total, "used": usage.used, "percent": round(pct, 1)}
    except OSError:
        return {"free": 0, "total": 0, "used": 0, "percent": 0.0}


def _min_free_bytes() -> int:
    try:
        return int(float(store.get_settings().get("min_free_gb") or 0) * _GB)
    except (TypeError, ValueError):
        return 0


def _disk_too_full() -> bool:
    """True when free space is under the configured floor (download should be
    refused). A floor of 0 disables the guard."""
    floor = _min_free_bytes()
    return floor > 0 and _disk_info()["free"] < floor


def _check_disk_alert() -> None:
    """Fire a one-shot notification when free space drops below the floor, and
    re-arm once it recovers comfortably (1.5×) so we don't spam."""
    global _disk_low_notified
    floor = _min_free_bytes()
    if floor <= 0:
        return
    free = _disk_info()["free"]
    if free < floor and not _disk_low_notified:
        _disk_low_notified = True
        notify.notify_disk_low(round(free / _GB, 1), round(floor / _GB, 1))
    elif free > floor * 1.5:
        _disk_low_notified = False
