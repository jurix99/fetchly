"""Cookie jar management for yt-dlp.

YouTube needs a logged-in cookies.txt to reach Watch Later / Liked / private
playlists and to clear the "confirm you're not a bot" check. Two pain points
this module solves:

1. Re-uploading without touching the container — cookies live in the writable
   /config volume and can be set from the web UI (paste / upload), with no file
   remount or container restart.

2. Sessions going stale fast — YouTube rotates a token (``__Secure-3PSIDTS``) on
   each use. We let yt-dlp write the refreshed jar back to /config so the
   session auto-renews and you rarely have to re-deposit cookies.

Each yt-dlp run gets its OWN writable temp copy (yt-dlp rewrites the jar on
close and would otherwise clobber a shared/read-only file). After a run the copy
is either committed back to the store (sequential, session-refreshing paths) or
discarded (parallel workers / interactive browsing) so two concurrent runs never
race each other's rotated token.
"""

from __future__ import annotations

import os
import shutil
import tempfile
import threading
from pathlib import Path

from . import store

# Persisted, writable copy in the config volume (survives restarts).
STORE_FILE = store.CONFIG_DIR / "cookies.txt"
# Legacy read-only mount (docker-compose: ./cookies/cookies.txt). Seeds the
# writable store on first run so existing setups keep working unchanged.
MOUNTED_FILE = os.environ.get("COOKIES_FILE", "/cookies/cookies.txt")

_LOCK = threading.Lock()


def _looks_like_netscape(text: str) -> bool:
    """Loosely validate an uploaded jar: a Netscape cookies.txt is tab-separated
    data lines, optionally with the standard header comment."""
    for line in text.splitlines():
        s = line.strip()
        if not s:
            continue
        if s.startswith("#"):
            if "Netscape HTTP Cookie File" in s or "HTTP Cookie File" in s:
                return True
            continue
        if "\t" in s:
            return True
    return False


def active_path() -> str | None:
    """The cookies file yt-dlp should read, or None if none configured. Seeds the
    writable store from a legacy mounted file on first use."""
    with _LOCK:
        if STORE_FILE.exists() and STORE_FILE.stat().st_size > 0:
            return str(STORE_FILE)
        if os.path.isfile(MOUNTED_FILE) and os.path.getsize(MOUNTED_FILE) > 0:
            try:
                store.CONFIG_DIR.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(MOUNTED_FILE, STORE_FILE)
                return str(STORE_FILE)
            except OSError:
                return MOUNTED_FILE
        return None


def prepare() -> str | None:
    """A private writable temp copy of the active cookies for one yt-dlp run."""
    src = active_path()
    if not src:
        return None
    fd, tmp = tempfile.mkstemp(suffix=".txt", prefix="cookies-")
    os.close(fd)
    try:
        shutil.copyfile(src, tmp)
    except OSError:
        discard(tmp)
        return None
    return tmp


def discard(tmp: str | None) -> None:
    """Drop a temp copy WITHOUT persisting (parallel workers / browsing)."""
    if tmp and os.path.exists(tmp):
        try:
            os.remove(tmp)
        except OSError:
            pass


def commit(tmp: str | None) -> None:
    """Persist a run's refreshed jar back to the store, then drop the temp.
    Last-writer-wins under a lock; only persists a non-empty file so a failed or
    blank run never wipes working cookies."""
    if not tmp or not os.path.exists(tmp):
        return
    try:
        if os.path.getsize(tmp) > 0:
            with _LOCK:
                store.CONFIG_DIR.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(tmp, STORE_FILE)
    except OSError:
        pass
    finally:
        discard(tmp)


def save(content: str) -> tuple[bool, str]:
    """Store cookies pasted/uploaded from the UI. Returns (ok, message)."""
    text = (content or "").strip()
    if not text:
        return False, "Contenu vide."
    if not _looks_like_netscape(text):
        return False, "Format invalide — exporte un cookies.txt au format Netscape."
    try:
        with _LOCK:
            store.CONFIG_DIR.mkdir(parents=True, exist_ok=True)
            tmp = STORE_FILE.with_suffix(".txt.tmp")
            tmp.write_text(text + "\n", encoding="utf-8")
            tmp.replace(STORE_FILE)
    except OSError as exc:  # noqa: BLE001
        return False, f"Échec d'écriture : {exc}"
    return True, "Cookies enregistrés."


def clear() -> bool:
    """Remove the stored cookies. Returns whether a file was actually deleted."""
    with _LOCK:
        existed = STORE_FILE.exists()
        try:
            STORE_FILE.unlink(missing_ok=True)
        except OSError:
            return False
        return existed


def status() -> dict:
    """Lightweight status for the UI: present?, how many auth lines, where from,
    and when last updated (so a stale jar is visible)."""
    path = active_path()
    if not path:
        return {"present": False, "count": 0, "source": None, "updated_at": None}
    source = "uploaded" if Path(path) == STORE_FILE else "mounted"
    count = 0
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                s = line.strip()
                if s and not s.startswith("#") and "\t" in s:
                    count += 1
    except OSError:
        pass
    try:
        updated_at = os.path.getmtime(path)
    except OSError:
        updated_at = None
    return {"present": True, "count": count, "source": source, "updated_at": updated_at}
