"""Subscription (watch) orchestration: the background scheduler, per-watch
checks, keepLastN retention and startup partial cleanup.

Listing/seeding/filtering is delegated to the source plugin (yt-dlp builtin);
downloads run as one job per new video via the jobs engine.
"""

from __future__ import annotations

import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from . import jobs, store
from .plugins.builtin import ytdlp_source as ytsrc
from .runtime import (
    DOWNLOAD_DIR,
    MEDIA_EXTS,
    _check_disk_alert,
    _now_iso,
    _release_memory,
)

# Watch IDs currently being checked, so a manual "Check now" and the scheduler
# can never download the same playlist at once.
_ACTIVE_WATCHES: set[str] = set()
_ACTIVE_WATCHES_LOCK = threading.Lock()


def _enforce_keep_last(folder: Path, n: int, log: list[str]) -> None:
    """Keep only the N newest media files (by mtime) directly inside `folder`,
    deleting older ones plus their sidecars. Never recurses into subfolders."""
    if n <= 0 or not folder.exists() or not folder.is_dir():
        return
    media = [
        p for p in folder.iterdir()
        if p.is_file() and p.suffix.lstrip(".").lower() in MEDIA_EXTS
    ]
    if len(media) <= n:
        return
    media.sort(key=lambda p: p.stat().st_mtime)
    for p in media[: len(media) - n]:
        stem = p.name.rsplit(".", 1)[0]
        removed = False
        for sc in list(folder.iterdir()):
            if sc.is_file() and sc.name.startswith(stem):
                try:
                    sc.unlink()
                    removed = True
                except OSError:
                    pass
        if removed:
            log.append(f"keepLastN: fichier ancien supprimé « {p.name} »")


def run_check(watch: dict[str, Any]) -> None:
    """Check a single watch once, guarded so it never runs concurrently."""
    wid = watch["id"]
    with _ACTIVE_WATCHES_LOCK:
        if wid in _ACTIVE_WATCHES:
            return
        _ACTIVE_WATCHES.add(wid)
    try:
        _do_check(watch)
    finally:
        with _ACTIVE_WATCHES_LOCK:
            _ACTIVE_WATCHES.discard(wid)


def _do_check(watch: dict[str, Any]) -> None:
    store.CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    quality = watch.get("quality") or store.get_settings()["default_quality"]
    log: list[str] = []

    # First run with backfill disabled: just mark existing videos as seen.
    if not watch.get("backfill", True) and not watch.get("seeded"):
        try:
            entries = ytsrc.seed_archive(watch, log)
            videos = [
                {"id": e.get("id"), "title": e.get("title") or e.get("id") or "", "synced": True}
                for e in entries
                if e
            ]
            store.save_watch_videos(watch["id"], videos)
            store.update_watch(
                watch["id"],
                seeded=True,
                thumbnail=ytsrc.fetch_channel_avatar(watch["url"], log) or watch.get("thumbnail", ""),
                synced=len(videos),
                total=len(videos),
                last_checked=_now_iso(),
                last_result=f"Seeded {len(videos)} existing (new only from now)",
            )
        except Exception as exc:  # noqa: BLE001
            store.update_watch(
                watch["id"], last_checked=_now_iso(), last_result=f"Seed error: {exc}"
            )
        return

    filters = ytsrc.watch_filters(watch)
    try:
        to_dl, stats = ytsrc.collect_new(watch, log, filters)
    except Exception as exc:  # noqa: BLE001
        store.update_watch(
            watch["id"], last_checked=_now_iso(), last_result=f"Check error: {exc}"
        )
        return

    job_list: list[jobs.Job] = []
    for entry in to_dl:
        vurl = entry.get("webpage_url") or entry.get("url") or entry.get("id")
        if not vurl:
            continue
        job = jobs.new_watch_job(
            url=vurl,
            quality=quality,
            dest=watch.get("subfolder", ""),
            watch_id=watch["id"],
            filters=filters,
            title=entry.get("title", ""),
            thumbnail=ytsrc._entry_thumb(entry),
        )
        job_list.append(job)
    jobs._prune_jobs()

    futures = [jobs.submit_watch_job(j) for j in job_list]
    for future in futures:
        try:
            future.result()
        except Exception:  # noqa: BLE001
            pass

    downloaded = sum(j.downloaded for j in job_list)
    net_rejected = sum(1 for j in job_list if j.downloaded == 0 and j.failed == 0)
    last_check = {
        "listed": stats["listed"],
        "matched": max(0, len(job_list) - net_rejected),
        "rejected_by_filters": stats["rejected"] + net_rejected,
        "downloaded": downloaded,
        "at": _now_iso(),
    }

    # keepLastN: prune the watch's folder to the N newest files.
    keep_n = filters.get("keep_last_n")
    output_dir = watch.get("output_dir") or ""
    for j in job_list:
        if j.output_dir:
            output_dir = j.output_dir
    if keep_n:
        folders: set[Path] = set()
        if watch.get("subfolder"):
            folders.add(DOWNLOAD_DIR / watch["subfolder"])
        if output_dir:
            folders.add(Path(output_dir))
        for folder in folders:
            try:
                _enforce_keep_last(folder, int(keep_n), log)
            except Exception as exc:  # noqa: BLE001
                log.append(f"keepLastN error: {exc}")

    store.update_watch(
        watch["id"],
        seeded=True,
        last_checked=_now_iso(),
        thumbnail=ytsrc.fetch_channel_avatar(watch["url"], log) or watch.get("thumbnail", ""),
        last_result=f"{downloaded} new" if downloaded else "up to date",
        last_check=last_check,
        output_dir=output_dir or watch.get("output_dir", ""),
    )
    _release_memory()


def _scheduler_loop() -> None:
    """Wake once a minute and check any watch whose interval has elapsed."""
    while True:
        try:
            _check_disk_alert()
            interval = store.get_settings()["watch_interval_minutes"]
            cutoff = datetime.now(timezone.utc) - timedelta(minutes=interval)
            for watch in store.list_watches():
                if not watch.get("enabled", True):
                    continue
                last = watch.get("last_checked")
                due = True
                if last:
                    try:
                        due = datetime.fromisoformat(last) <= cutoff
                    except ValueError:
                        due = True
                if due:
                    run_check(watch)
        except Exception as exc:  # noqa: BLE001
            print(f"[scheduler] error: {exc}", flush=True)
        time.sleep(60)


def start_scheduler() -> None:
    threading.Thread(target=_scheduler_loop, daemon=True).start()


def cleanup_partials() -> None:
    """Remove leftover .part/.ytdl fragments and orphan .webp thumbnails on
    startup (only called when there are no interrupted jobs to resume)."""
    removed = 0
    for pattern in ("*.part", "*.ytdl", "*.part-Frag*"):
        for p in DOWNLOAD_DIR.rglob(pattern):
            try:
                p.unlink()
                removed += 1
            except OSError:
                pass
    for p in DOWNLOAD_DIR.rglob("*.webp"):
        if not any(p.with_suffix("." + ext).exists() for ext in MEDIA_EXTS):
            try:
                p.unlink()
                removed += 1
            except OSError:
                pass
    if removed:
        print(f"[startup] cleaned {removed} leftover partial file(s)", flush=True)
