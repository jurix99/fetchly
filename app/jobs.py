"""Download job engine: the Job model, in-memory cache, SQLite persistence,
restore-on-restart, pause/cancel/retry control, and the run loop that drives a
job's status while delegating the actual download to the resolved SourcePlugin.

No yt_dlp here — that lives entirely in app/plugins/builtin/ytdlp_source.py.
"""

from __future__ import annotations

import threading
import time
import uuid
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import db, pipeline
from .plugins.registry import registry
from .runtime import _GB, _disk_info, _disk_too_full, _check_disk_alert, _release_memory


@dataclass
class Job:
    id: str
    url: str
    quality: str
    kind: str = "manual"  # manual | watch
    # queued | running | paused | done | error | canceled
    status: str = "queued"
    phase: str = "downloading"  # downloading | processing (ffmpeg merge/convert)
    total: int = 0
    completed: int = 0
    downloaded: int = 0
    failed: int = 0
    current_title: str = ""
    current_thumbnail: str = ""
    current_percent: float = 0.0
    current_speed: str = ""
    files: list[str] = field(default_factory=list)
    error: str = ""
    log: list[str] = field(default_factory=list)
    use_archive: bool = False
    watch_id: str | None = None
    dest: str = ""
    date_after: str = ""
    fmt: str = "MP4"
    playlist_title: str = ""
    created_at: float = field(default_factory=time.time)
    done_ids: list[str] = field(default_factory=list)
    paused_at: float | None = None
    canceled_at: float | None = None
    finished_at: float | None = None
    # --- transient runtime state (never persisted) ---
    pause_event: threading.Event = field(default_factory=threading.Event, repr=False)
    cancel_event: threading.Event = field(default_factory=threading.Event, repr=False)
    partials: set[str] = field(default_factory=set, repr=False)
    _last_write: float = field(default=0.0, repr=False)
    filters: dict[str, Any] = field(default_factory=dict, repr=False)
    output_dir: str = field(default="", repr=False)
    # Per-plugin pipeline outcomes surfaced on the download card (transient).
    reports: list[dict[str, Any]] = field(default_factory=list, repr=False)


JOBS: dict[str, Job] = {}
JOBS_LOCK = threading.Lock()

_RESTORED: dict[str, Any] = {"count": 0, "at": time.time()}
_TERMINAL = ("done", "error", "canceled")
_MAX_JOBS = 300

# The pool that runs watch downloads, plus a resizable gate so a watch can fetch
# several videos at once without ever exceeding the configured concurrency.
_DOWNLOAD_POOL = ThreadPoolExecutor(max_workers=12, thread_name_prefix="dl")
_DL_GATE = threading.Semaphore(3)
_DL_GATE_LOCK = threading.Lock()


def set_concurrency(n: int) -> None:
    global _DL_GATE
    with _DL_GATE_LOCK:
        _DL_GATE = threading.Semaphore(max(1, min(int(n), 10)))


# --- Persistence -----------------------------------------------------------
def _job_to_row(job: Job) -> dict[str, Any]:
    return {
        "id": job.id, "url": job.url, "quality": job.quality, "fmt": job.fmt,
        "kind": job.kind, "status": job.status, "phase": job.phase,
        "total": job.total, "completed": job.completed,
        "downloaded": job.downloaded, "failed": job.failed,
        "current_title": job.current_title, "current_thumbnail": job.current_thumbnail,
        "current_percent": round(job.current_percent, 1),
        "current_speed": job.current_speed, "files": job.files,
        "error": job.error, "log": job.log[-50:], "done_ids": job.done_ids,
        "use_archive": int(job.use_archive), "watch_id": job.watch_id,
        "dest": job.dest, "date_after": job.date_after,
        "playlist_title": job.playlist_title, "created_at": job.created_at,
        "paused_at": job.paused_at, "canceled_at": job.canceled_at,
        "finished_at": job.finished_at,
    }


def _row_to_job(r: dict[str, Any]) -> Job:
    job = Job(id=r["id"], url=r["url"] or "", quality=r["quality"] or "",
              kind=r["kind"] or "manual")
    job.fmt = r["fmt"] or "MP4"
    job.status = r["status"] or "queued"
    job.phase = r["phase"] or "downloading"
    job.total = r["total"] or 0
    job.completed = r["completed"] or 0
    job.downloaded = r["downloaded"] or 0
    job.failed = r["failed"] or 0
    job.current_title = r["current_title"] or ""
    job.current_thumbnail = r["current_thumbnail"] or ""
    job.current_percent = r["current_percent"] or 0.0
    job.current_speed = r["current_speed"] or ""
    job.files = list(r.get("files") or [])
    job.error = r["error"] or ""
    job.log = list(r.get("log") or [])
    job.done_ids = list(r.get("done_ids") or [])
    job.use_archive = bool(r["use_archive"])
    job.watch_id = r["watch_id"]
    job.dest = r["dest"] or ""
    job.date_after = r["date_after"] or ""
    job.playlist_title = r["playlist_title"] or ""
    job.created_at = r["created_at"] or time.time()
    job.paused_at = r["paused_at"]
    job.canceled_at = r["canceled_at"]
    job.finished_at = r["finished_at"]
    return job


def _persist(job: Job) -> None:
    try:
        db.upsert(_job_to_row(job))
    except Exception as exc:  # noqa: BLE001
        print(f"[db] persist {job.id}: {exc}", flush=True)


def _persist_progress(job: Job) -> None:
    now = time.time()
    if now - job._last_write >= 2.0:
        job._last_write = now
        _persist(job)


# --- Control primitives ----------------------------------------------------
def _delete_partials(job: Job) -> None:
    """Remove the incomplete files of the video(s) that were downloading — used
    on cancel. Completed files are already renamed off .part, so kept."""
    dirs: set[Path] = set()
    for part in list(job.partials):
        dirs.add(Path(part).parent)
    for d in dirs:
        try:
            for pattern in ("*.part", "*.ytdl", "*.part-Frag*"):
                for f in d.glob(pattern):
                    try:
                        f.unlink(missing_ok=True)
                    except OSError:
                        pass
        except OSError:
            pass
    job.partials.clear()


def _finalize_canceled(job: Job) -> None:
    _delete_partials(job)
    job.status = "canceled"
    job.canceled_at = time.time()
    job.current_speed = ""
    job.log.append("Annulé — fichiers incomplets supprimés.")
    _persist(job)


def _job_summary(job: Job) -> None:
    from . import notify
    if job.total > 1:
        notify.notify_job_summary(job.playlist_title or job.url, job.downloaded, job.failed)


def _finalize_run(job: Job) -> None:
    if job.cancel_event.is_set():
        _finalize_canceled(job)
        return
    if job.pause_event.is_set():
        job.status = "paused"
        job.paused_at = time.time()
        job.current_speed = ""
        job.log.append("En pause — fichiers partiels conservés.")
        _persist(job)
        return
    job.status = "done"
    job.finished_at = time.time()
    job.current_speed = ""
    job.log.append(f"Terminé. {job.downloaded} nouveau(x) fichier(s).")
    _persist(job)
    _job_summary(job)


def _spawn(job: Job) -> None:
    """(Re)start a job. Watch jobs go through the gated pool (shared concurrency
    limit); manual jobs run in their own thread."""
    _persist(job)
    if job.kind == "watch":
        _DOWNLOAD_POOL.submit(_run_job_gated, job)
    else:
        threading.Thread(target=run_job, args=(job,), daemon=True).start()


def submit_watch_job(job: Job) -> Future:
    """Store + persist a watch job and submit it to the gated pool."""
    with JOBS_LOCK:
        JOBS[job.id] = job
    _persist(job)
    return _DOWNLOAD_POOL.submit(_run_job_gated, job)


def _run_job_gated(job: Job) -> None:
    with _DL_GATE_LOCK:
        gate = _DL_GATE
    gate.acquire()
    try:
        run_job(job)
    finally:
        gate.release()


def run_job(job: Job) -> None:
    """Drive a job's lifecycle; delegate the download to the resolved source."""
    if job.cancel_event.is_set():
        _finalize_canceled(job)
        return
    if job.pause_event.is_set():
        job.status = "paused"
        job.paused_at = time.time()
        _persist(job)
        return
    if _disk_too_full():
        job.status = "error"
        job.error = f"Espace disque insuffisant ({round(_disk_info()['free'] / _GB, 1)} Go libres)."
        job.finished_at = time.time()
        job.log.append(job.error)
        _persist(job)
        _check_disk_alert()
        return

    source = registry.get_source(job.url) or registry.default_source()
    if source is None:
        job.status = "error"
        job.error = "Aucune source ne peut traiter cette URL."
        job.finished_at = time.time()
        job.log.append(job.error)
        _persist(job)
        return

    job.status = "running"
    # Recount progress from scratch: a resumed job re-lists everything and skips
    # already-done videos (done_ids / archive), so completed must start at 0.
    job.completed = 0
    job.current_percent = 0.0
    _persist(job)

    try:
        result = source.download(job, {"on_progress": _persist_progress})
    except Exception as exc:  # noqa: BLE001
        # A pause/cancel that surfaced as an interrupt is not an error.
        if job.cancel_event.is_set() or job.pause_event.is_set():
            _finalize_run(job)
            return
        job.status = "error"
        job.error = str(exc)
        job.finished_at = time.time()
        job.log.append(f"Error: {exc}")
        _persist(job)
        return

    _finalize_run(job)

    if job.status == "done" and result is not None:
        # Index into the library (source of truth for the Bibliothèque view).
        # Always runs, independent of plugins; never fails the download.
        try:
            from . import library
            library.index_download(job, result)
        except Exception as exc:  # noqa: BLE001
            job.log.append(f"library: {exc}")

        # Post-download pipeline: processors then outputs. Never fails the DL.
        if pipeline.has_consumers():
            try:
                result = pipeline.run(job.id, result)
                job.reports = list(result.reports)
                if job.reports:
                    _persist(job)
            except Exception as exc:  # noqa: BLE001
                job.log.append(f"pipeline: {exc}")


def _prune_jobs() -> None:
    with JOBS_LOCK:
        excess = len(JOBS) - _MAX_JOBS
        if excess <= 0:
            return
        finished = sorted(
            (j for j in JOBS.values() if j.status in _TERMINAL),
            key=lambda j: j.created_at,
        )
        dropped = [j.id for j in finished[:excess]]
        for jid in dropped:
            JOBS.pop(jid, None)
    for jid in dropped:
        db.delete(jid)


# --- Startup restore -------------------------------------------------------
def restore() -> int:
    """Rebuild JOBS from the DB and re-queue anything a restart interrupted."""
    try:
        rows = db.load_all()
    except Exception as exc:  # noqa: BLE001
        print(f"[db] load failed: {exc}", flush=True)
        return 0
    to_resume: list[Job] = []
    with JOBS_LOCK:
        for r in rows:
            job = _row_to_job(r)
            if job.status in ("running", "queued"):
                job.status = "interrupted"
                to_resume.append(job)
            JOBS[job.id] = job
    for job in to_resume:
        job.log.append("Interrompu par un redémarrage — remis en file.")
        job.status = "queued"
        job.pause_event.clear()
        job.cancel_event.clear()
        _spawn(job)
    if to_resume:
        print(f"[startup] resumed {len(to_resume)} interrupted job(s)", flush=True)
    _RESTORED["count"] = len(to_resume)
    _RESTORED["at"] = time.time()
    return len(to_resume)


def restored_state() -> dict[str, Any]:
    return {"count": _RESTORED["count"], "at": _RESTORED["at"]}


# --- High-level operations used by the routes ------------------------------
def create_download(url: str, quality: str, fmt: str, subfolder: str, use_archive: bool) -> str:
    job = Job(
        id=str(uuid.uuid4()),
        url=url.strip(),
        quality=quality,
        fmt=fmt or "MP4",
        dest=(subfolder or "").strip(),
        use_archive=use_archive,
    )
    with JOBS_LOCK:
        JOBS[job.id] = job
    _persist(job)
    _prune_jobs()
    threading.Thread(target=run_job, args=(job,), daemon=True).start()
    return job.id


def persist(job: Job) -> None:
    """Public persistence hook for non-download tasks (e.g. plugin backfill)."""
    _persist(job)


def create_task(title: str, total: int = 0) -> Job:
    """A non-download background task shown in the downloads list (kind='task',
    e.g. a plugin's library backfill). The caller drives total/completed/status."""
    job = Job(id=str(uuid.uuid4()), url="", quality="", kind="task")
    job.status = "running"
    job.current_title = title
    job.total = total
    with JOBS_LOCK:
        JOBS[job.id] = job
    _persist(job)
    return job


def new_watch_job(url: str, quality: str, dest: str, watch_id: str, filters: dict[str, Any],
                  title: str, thumbnail: str) -> Job:
    job = Job(
        id=str(uuid.uuid4()),
        url=url,
        quality=quality,
        kind="watch",
        use_archive=True,
        watch_id=watch_id,
        dest=dest,
    )
    job.total = 1
    job.current_title = title
    job.current_thumbnail = thumbnail
    job.filters = filters
    return job


def status_payload(job_id: str) -> dict[str, Any] | None:
    job = JOBS.get(job_id)
    if not job:
        return None
    return {
        "status": job.status,
        "phase": job.phase,
        "total": job.total,
        "completed": job.completed,
        "downloaded": job.downloaded,
        "current_title": job.current_title,
        "current_percent": round(job.current_percent, 1),
        "current_speed": job.current_speed,
        "files": job.files,
        "error": job.error,
        "log": job.log[-50:],
    }


def list_payload() -> list[dict[str, Any]]:
    with JOBS_LOCK:
        jobs = sorted(JOBS.values(), key=lambda j: j.created_at, reverse=True)
    return [
        {
            "id": j.id, "url": j.url, "kind": j.kind, "quality": j.quality,
            "status": j.status, "phase": j.phase, "total": j.total,
            "completed": j.completed, "downloaded": j.downloaded,
            "current_title": j.current_title, "current_thumbnail": j.current_thumbnail,
            "current_percent": round(j.current_percent, 1), "current_speed": j.current_speed,
            "files": j.files, "error": j.error, "playlist_title": j.playlist_title,
            "watch_id": j.watch_id, "created_at": j.created_at,
            "paused_at": j.paused_at, "canceled_at": j.canceled_at, "finished_at": j.finished_at,
            "reports": j.reports,
        }
        for j in jobs[:60]
    ]


# --- Control actions (return (body, http_status)) --------------------------
def pause(job_id: str) -> tuple[dict[str, Any], int]:
    job = JOBS.get(job_id)
    if not job:
        return {"error": "Unknown job"}, 404
    if job.status not in ("queued", "running"):
        return {"error": f"Impossible de mettre en pause un téléchargement « {job.status} »."}, 409
    job.pause_event.set()
    if job.status == "queued":
        job.status = "paused"
        job.paused_at = time.time()
        _persist(job)
        return {"status": "paused"}, 200
    return {"status": "pausing"}, 200


def resume(job_id: str) -> tuple[dict[str, Any], int]:
    job = JOBS.get(job_id)
    if not job:
        return {"error": "Unknown job"}, 404
    if job.status != "paused":
        return {"error": f"Impossible de reprendre un téléchargement « {job.status} »."}, 409
    job.pause_event.clear()
    job.status = "queued"
    job.paused_at = None
    _spawn(job)
    return {"status": "queued"}, 200


def cancel(job_id: str) -> tuple[dict[str, Any], int]:
    job = JOBS.get(job_id)
    if not job:
        return {"error": "Unknown job"}, 404
    if job.status not in ("queued", "running", "paused"):
        return {"error": f"Impossible d'annuler un téléchargement « {job.status} »."}, 409
    job.cancel_event.set()
    job.pause_event.clear()
    if job.status in ("queued", "paused"):
        _finalize_canceled(job)
        return {"status": "canceled"}, 200
    return {"status": "canceling"}, 200


def retry(job_id: str) -> tuple[dict[str, Any], int]:
    job = JOBS.get(job_id)
    if not job:
        return {"error": "Unknown job"}, 404
    if job.status not in ("error", "canceled"):
        return {"error": f"Seuls les téléchargements en échec ou annulés peuvent être relancés (« {job.status} »)."}, 409
    job.cancel_event.clear()
    job.pause_event.clear()
    job.partials.clear()
    job.status = "queued"
    job.error = ""
    job.canceled_at = None
    job.finished_at = None
    job.completed = 0
    job.current_percent = 0.0
    _spawn(job)
    return {"status": "queued"}, 200


def pause_all() -> dict[str, Any]:
    with JOBS_LOCK:
        jobs = list(JOBS.values())
    paused = 0
    for job in jobs:
        if job.status in ("queued", "running"):
            job.pause_event.set()
            if job.status == "queued":
                job.status = "paused"
                job.paused_at = time.time()
                _persist(job)
            paused += 1
    return {"paused": paused}


def resume_all() -> dict[str, Any]:
    with JOBS_LOCK:
        jobs = list(JOBS.values())
    resumed = 0
    for job in jobs:
        if job.status == "paused":
            job.pause_event.clear()
            job.status = "queued"
            job.paused_at = None
            _spawn(job)
            resumed += 1
    return {"resumed": resumed}
