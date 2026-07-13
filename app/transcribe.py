"""Local speech-to-text engine (faster-whisper / CTranslate2).

A DEDICATED, single-worker queue separate from the download pool, so
transcription never competes with or blocks downloads. FIFO, honours a nightly
window, resumes after a restart, and keeps at most one model resident in RAM
(unloaded after an idle period). Produces .srt + .vtt sidecars and persists
timestamped segments to the DB (substrate for search, prompt 7).

faster-whisper / ctranslate2 are imported lazily so a missing/slow import never
delays startup, and GPU is probed without ever crashing when CUDA is absent.
"""

from __future__ import annotations

import glob
import os
import threading
import time
import uuid
from contextlib import contextmanager, nullcontext
from dataclasses import dataclass, field
from datetime import datetime, time as dtime
from pathlib import Path
from typing import Any

from . import db, store
from .plugins.registry import registry
from .runtime import _release_memory

MODELS_DIR = store.CONFIG_DIR / "models"
_IDLE_UNLOAD_S = 300  # unload the model after 5 min idle
_MODEL_SIZES = {  # approximate on-disk size, for the UI
    "tiny": "~75 Mo", "base": "~145 Mo", "small": "~480 Mo",
    "medium": "~1.5 Go", "large-v3": "~3 Go",
}


@dataclass
class TJob:
    id: str
    content_id: str
    title: str
    status: str = "queued"  # queued | running | done | error | canceled
    progress: int = 0
    model: str = "small"
    engine: str = "local"  # local | cloud (for the discreet cloud icon on jobs)
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    duration_ms: int | None = None
    error: str = ""
    force: bool = field(default=False, repr=False)
    cancel_event: threading.Event = field(default_factory=threading.Event, repr=False)
    _last_write: float = field(default=0.0, repr=False)


_JOBS: dict[str, TJob] = {}
_LOCK = threading.Lock()
_COND = threading.Condition(_LOCK)

_model: Any = None
_model_key: tuple | None = None
_model_lock = threading.Lock()
_last_used = 0.0


class _Canceled(Exception):
    pass


# --- persistence -----------------------------------------------------------
def _row(job: TJob) -> dict[str, Any]:
    return {
        "id": job.id, "content_id": job.content_id, "title": job.title,
        "status": job.status, "progress": job.progress, "model": job.model,
        "created_at": job.created_at, "started_at": job.started_at,
        "duration_ms": job.duration_ms, "error": job.error,
    }


def _persist(job: TJob) -> None:
    try:
        db.tjob_upsert(_row(job))
    except Exception as exc:  # noqa: BLE001
        print(f"[transcribe] persist {job.id}: {exc}", flush=True)


def _persist_progress(job: TJob) -> None:
    now = time.time()
    if now - job._last_write >= 2.0:
        job._last_write = now
        _persist(job)


def public(job: TJob) -> dict[str, Any]:
    return {
        "id": job.id, "content_id": job.content_id, "title": job.title,
        "status": job.status, "progress": job.progress, "model": job.model,
        "engine": job.engine,
        "created_at": job.created_at, "duration_ms": job.duration_ms, "error": job.error,
    }


# --- device / model --------------------------------------------------------
def _cuda_available() -> bool:
    try:
        import ctranslate2
        return ctranslate2.get_cuda_device_count() > 0
    except Exception:  # noqa: BLE001
        return False


def _resolve_device(compute: str) -> tuple[str, str]:
    if compute == "cpu":
        return "cpu", "int8"
    if compute == "gpu":
        return "cuda", "float16"
    return ("cuda", "float16") if _cuda_available() else ("cpu", "int8")


def device_label() -> str:
    return "GPU (CUDA)" if _cuda_available() else "CPU (int8)"


def _model_download_ctx():
    """Context manager wrapping a model download. Relaxes TLS **only** when the
    user has explicitly opted in (``insecure_model_download`` / env), otherwise a
    no-op that keeps full certificate verification. Default is verification ON."""
    from . import store
    if store.insecure_model_download():
        return _relaxed_tls()
    return nullcontext()


@contextmanager
def _relaxed_tls():
    """Temporarily relax TLS verification for a model download behind a
    TLS-intercepting corporate proxy (mirrors yt-dlp's `nocheckcertificate`).

    OPT-IN only (see ``_model_download_ctx``). CAVEAT: huggingface_hub builds its
    SSL context from ssl.create_default_context, so the relaxation is **process
    wide** for the (multi-minute) duration of the download — any other outbound
    request in that window (e.g. Apprise, Jellyfin) is also unverified. Only
    enable on a trusted, TLS-intercepting network. Restored on exit."""
    import ssl
    orig_ctx = ssl.create_default_context
    orig_https = getattr(ssl, "_create_default_https_context", None)

    def _unverified(*args, **kwargs):
        ctx = orig_ctx(*args, **kwargs)
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return ctx

    try:
        import urllib3
        urllib3.disable_warnings()
    except Exception:  # noqa: BLE001
        pass
    ssl.create_default_context = _unverified
    if orig_https is not None:
        ssl._create_default_https_context = ssl._create_unverified_context
    try:
        yield
    finally:
        ssl.create_default_context = orig_ctx
        if orig_https is not None:
            ssl._create_default_https_context = orig_https


def _model_cached(name: str) -> bool:
    """Whether `name` is already downloaded under MODELS_DIR (skip the relaxed
    TLS download path when it is)."""
    import glob
    pattern = str(MODELS_DIR / f"models--*faster-whisper-{name}" / "snapshots" / "*")
    return any(Path(p).is_dir() for p in glob.glob(pattern))


def _build_model(name: str, device: str, ctype: str):
    from faster_whisper import WhisperModel
    if _model_cached(name):
        return WhisperModel(name, device=device, compute_type=ctype, download_root=str(MODELS_DIR))
    with _model_download_ctx():
        return WhisperModel(name, device=device, compute_type=ctype, download_root=str(MODELS_DIR))


def _load_model(name: str, compute: str):
    global _model, _model_key, _last_used
    device, ctype = _resolve_device(compute)
    key = (name, device, ctype)
    with _model_lock:
        if _model is not None and _model_key == key:
            _last_used = time.time()
            return _model
        _model = None  # drop the previous model first (one resident at a time)
        _release_memory()
        MODELS_DIR.mkdir(parents=True, exist_ok=True)
        print(f"[transcribe] loading model {name} on {device}/{ctype} (may download)…", flush=True)
        try:
            m = _build_model(name, device, ctype)
        except Exception as exc:  # noqa: BLE001 — CUDA missing/broken → CPU fallback
            if device == "cuda":
                print(f"[transcribe] CUDA unavailable ({exc}); falling back to CPU int8", flush=True)
                m = _build_model(name, "cpu", "int8")
                key = (name, "cpu", "int8")
            else:
                raise
        _model, _model_key, _last_used = m, key, time.time()
        print(f"[transcribe] model {name} ready ({key[1]})", flush=True)
        return _model


def _unload_model() -> None:
    global _model, _model_key
    with _model_lock:
        if _model is not None:
            _model = None
            _model_key = None
            _release_memory()
            print("[transcribe] model unloaded (idle)", flush=True)


def model_size_hint(name: str) -> str:
    return _MODEL_SIZES.get(name, "")


# --- night window ----------------------------------------------------------
def _parse_hhmm(s: str) -> dtime | None:
    try:
        h, m = s.strip().split(":")
        return dtime(int(h), int(m))
    except (ValueError, AttributeError):
        return None


def _window_open(settings: dict[str, Any]) -> bool:
    if settings.get("schedule") != "fenêtre nocturne":
        return True
    start = _parse_hhmm((settings.get("night_window") or "").split("-")[0])
    end = _parse_hhmm((settings.get("night_window") or "22:00-07:00").split("-")[-1])
    if not start or not end:
        return True
    now = datetime.now().time()
    if start <= end:
        return start <= now <= end
    return now >= start or now <= end  # wraps past midnight


# --- subtitle writers ------------------------------------------------------
def _ts(ms: int, sep: str) -> str:
    ms = max(0, int(ms))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def _write_srt(path: Path, segs: list[tuple[int, int, str]]) -> None:
    lines = []
    for i, (start, end, text) in enumerate(segs, 1):
        lines.append(str(i))
        lines.append(f"{_ts(start, ',')} --> {_ts(end, ',')}")
        lines.append(text)
        lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")


def _write_vtt(path: Path, segs: list[tuple[int, int, str]]) -> None:
    lines = ["WEBVTT", ""]
    for start, end, text in segs:
        lines.append(f"{_ts(start, '.')} --> {_ts(end, '.')}")
        lines.append(text)
        lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")


def _has_source_captions(path: Path) -> bool:
    for p in glob.glob(glob.escape(str(path.parent / path.stem)) + "*"):
        if p.lower().endswith((".srt", ".vtt")):
            return True
    return False


def _cue_ms(stamp: str) -> int:
    stamp = stamp.strip().replace(",", ".")
    parts = stamp.split(":")
    try:
        if len(parts) == 3:
            h, m, s = parts
        else:
            h, m, s = "0", parts[0], parts[1]
        sec, _, milli = s.partition(".")
        return ((int(h) * 60 + int(m)) * 60 + int(sec)) * 1000 + int((milli + "000")[:3])
    except (ValueError, IndexError):
        return 0


def parse_subs(path: Path) -> list[dict[str, Any]]:
    """Parse an .srt/.vtt into segments — used to display source captions for
    content marked 'skipped' (no DB segments of our own)."""
    try:
        raw = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    segs: list[dict[str, Any]] = []
    cur_start = cur_end = None
    buf: list[str] = []
    for line in raw.splitlines():
        s = line.strip()
        if "-->" in s:
            if cur_start is not None and buf:
                segs.append({"start_ms": cur_start, "end_ms": cur_end, "text": " ".join(buf).strip()})
            left, _, right = s.partition("-->")
            cur_start, cur_end, buf = _cue_ms(left), _cue_ms(right.split()[0] if right.split() else "0"), []
        elif s == "" :
            if cur_start is not None and buf:
                segs.append({"start_ms": cur_start, "end_ms": cur_end, "text": " ".join(buf).strip()})
                cur_start, cur_end, buf = None, None, []
        elif s.upper() == "WEBVTT" or s.isdigit():
            continue
        elif cur_start is not None:
            buf.append(s)
    if cur_start is not None and buf:
        segs.append({"start_ms": cur_start, "end_ms": cur_end, "text": " ".join(buf).strip()})
    return [seg for seg in segs if seg["text"]]


def source_captions(path: Path) -> list[dict[str, Any]]:
    """Segments from an existing source .srt/.vtt next to the media, if any."""
    for ext in (".srt", ".vtt"):
        candidate = path.with_suffix(ext)
        if candidate.exists():
            parsed = parse_subs(candidate)
            if parsed:
                return parsed
    # yt-dlp language-tagged subs (e.g. "<stem>.en.vtt").
    for p in sorted(glob.glob(glob.escape(str(path.parent / path.stem)) + "*")):
        if p.lower().endswith((".srt", ".vtt")):
            parsed = parse_subs(Path(p))
            if parsed:
                return parsed
    return []


# --- Transcriber interface -------------------------------------------------
# The core step is "produce timestamped segments from a media file". Two
# implementations sit behind it: local Whisper (default) and cloud STT. The rest
# of the pipeline (.srt/.vtt, indexing, generation, statuses, the queue) is
# identical for both — it only ever sees (language, segments).
def transcribe_media(
    path: Path,
    settings: dict[str, Any],
    on_progress: Any = None,
    cancel: Any = None,
) -> tuple[str, list[tuple[int, int, str]]]:
    if settings.get("engine", "local") == "cloud":
        from . import cloud_stt
        return cloud_stt.transcribe_media(path, settings, on_progress=on_progress, cancel=cancel)
    return _local_transcribe_media(path, settings, on_progress=on_progress, cancel=cancel)


def _local_transcribe_media(
    path: Path, settings: dict[str, Any], on_progress: Any = None, cancel: Any = None,
) -> tuple[str, list[tuple[int, int, str]]]:
    """LocalWhisper — the existing faster-whisper path, unchanged in behaviour."""
    global _last_used
    model = _load_model(settings.get("model", "small"), settings.get("compute", "auto"))
    lang_opt = settings.get("language", "auto")
    language = None if lang_opt == "auto" else lang_opt

    seg_iter, info = model.transcribe(
        str(path),
        word_timestamps=True,
        vad_filter=bool(settings.get("vad_filter", True)),
        language=language,
    )
    detected = getattr(info, "language", "") or ""
    duration = getattr(info, "duration", 0) or 0

    segs: list[tuple[int, int, str]] = []
    for seg in seg_iter:
        if cancel and cancel():
            raise _Canceled()
        segs.append((int(seg.start * 1000), int(seg.end * 1000), (seg.text or "").strip()))
        if duration and on_progress:
            on_progress(min(99, int(seg.end / duration * 100)))
        _last_used = time.time()
    return detected, segs


# --- transcription (queue-level: statuses, sidecars, indexing trigger) ------
def _transcribe(job: TJob, settings: dict[str, Any]) -> tuple[str, int, str]:
    content = db.content_get(job.content_id)
    if not content:
        raise RuntimeError("Contenu introuvable")
    path = Path(content.get("filepath") or "")
    if not path.is_file():
        raise RuntimeError("Fichier média introuvable sur le disque")

    # skip_if_captions: honour existing source subtitles on the auto path only.
    if not job.force and settings.get("skip_if_captions") and _has_source_captions(path):
        db.content_set_transcript(job.content_id, "skipped")
        return "", 0, "skipped"

    db.content_set_transcript(job.content_id, "running")

    def _on_progress(p: int) -> None:
        global _last_used
        job.progress = min(99, int(p))
        _persist_progress(job)
        _last_used = time.time()

    detected, segs = transcribe_media(
        path, settings, on_progress=_on_progress, cancel=job.cancel_event.is_set,
    )

    _write_srt(path.with_suffix(".srt"), segs)
    _write_vtt(path.with_suffix(".vtt"), segs)
    db.segments_replace(job.content_id, segs)
    db.content_set_transcript(job.content_id, "done", language=detected)
    # Light monthly cost journal for the cloud engine (minutes only, no price).
    if settings.get("engine") == "cloud":
        minutes = (content.get("duration_seconds") or 0) / 60
        if minutes > 0:
            db.cloud_stt_add_minutes(minutes)
    return detected, len(segs), "done"


def _run_job(job: TJob) -> None:
    job.status = "running"
    job.started_at = time.time()
    job.progress = 0
    _persist(job)
    try:
        _detected, _n, outcome = _transcribe(job, registry.settings_of("whisper"))
        job.status = "done"
        job.progress = 100
        job.duration_ms = int((time.time() - (job.started_at or time.time())) * 1000)
        _record_speed(job, outcome)
        # Search indexing runs right here in the processing worker (never on the
        # download path). Re-transcription rebuilds the chunks/vectors. Isolated:
        # an indexing failure marks index_status=error, transcript stays done.
        if outcome in ("done", "skipped"):
            try:
                from . import indexer
                indexer.index_content(job.content_id)
            except Exception as exc:  # noqa: BLE001
                print(f"[transcribe] indexing {job.content_id}: {exc}", flush=True)
            # Intelligence brick: enqueue summary+chapters generation if a provider
            # is configured (no-op otherwise). Never fails the transcription.
            try:
                from . import generate
                generate.on_transcribed(job.content_id)
            except Exception as exc:  # noqa: BLE001
                print(f"[transcribe] generation trigger {job.content_id}: {exc}", flush=True)
    except _Canceled:
        job.status = "canceled"
        db.content_set_transcript(job.content_id, "none")
    except Exception as exc:  # noqa: BLE001 — a failure never affects the download
        job.status = "error"
        job.error = str(exc)
        job.duration_ms = int((time.time() - (job.started_at or time.time())) * 1000)
        db.content_set_transcript(job.content_id, "error")
        print(f"[transcribe] job {job.id} error: {exc}", flush=True)
    finally:
        _persist(job)
        _release_memory()


def _record_speed(job: TJob, outcome: str) -> None:
    if outcome != "done" or not job.duration_ms:
        return
    content = db.content_get(job.content_id)
    media = (content or {}).get("duration_seconds") or 0
    elapsed = job.duration_ms / 1000
    if media and elapsed > 0:
        ratio = media / elapsed  # media-seconds transcribed per real second
        db.meta_set("whisper_last_speed", f"{ratio:.1f}")
        db.meta_set("whisper_last_model", job.model)


# --- worker ----------------------------------------------------------------
def _next_queued() -> TJob | None:
    queued = [j for j in _JOBS.values() if j.status == "queued"]
    queued.sort(key=lambda j: j.created_at)
    return queued[0] if queued else None


def _worker() -> None:
    try:
        os.nice(10)  # be gentle on the box; best-effort
    except (OSError, AttributeError):
        pass
    while True:
        with _COND:
            while True:
                job = _next_queued()
                if job is not None and _window_open(registry.settings_of("whisper")):
                    break
                # Wait for an enqueue or the window to open (periodic re-check).
                _COND.wait(timeout=30)
        if job.cancel_event.is_set():
            job.status = "canceled"
            _persist(job)
            continue
        _run_job(job)


def _reaper() -> None:
    while True:
        time.sleep(60)
        if _model is not None and time.time() - _last_used > _IDLE_UNLOAD_S:
            # Only unload when nothing is running.
            if not any(j.status == "running" for j in _JOBS.values()):
                _unload_model()


# --- public API ------------------------------------------------------------
def enqueue(content_id: str, title: str | None = None, force: bool = False) -> str | None:
    content = db.content_get(content_id)
    if not content:
        return None
    with _COND:
        for j in _JOBS.values():
            if j.content_id == content_id and j.status in ("queued", "running"):
                return j.id  # already queued/running — dedup
        wsettings = registry.settings_of("whisper")
        job = TJob(
            id=str(uuid.uuid4()),
            content_id=content_id,
            title=title or content.get("title") or "",
            model=wsettings.get("model", "small"),
            engine=wsettings.get("engine", "local"),
            force=force,
        )
        _JOBS[job.id] = job
        _persist(job)
        db.content_set_transcript(content_id, "queued")
        _COND.notify_all()
    return job.id


def backfill(only_missing: bool = True) -> int:
    rows = db.contents_without_transcript() if only_missing else db.content_list(limit=200)[0]
    n = 0
    for row in rows:
        if enqueue(row["id"], row.get("title")):
            n += 1
    return n


def cancel(job_id: str) -> bool:
    with _COND:
        job = _JOBS.get(job_id)
        if not job or job.status in ("done", "error", "canceled"):
            return False
        job.cancel_event.set()
        if job.status == "queued":
            job.status = "canceled"
            _persist(job)
            db.content_set_transcript(job.content_id, "none")
        _COND.notify_all()
    return True


def list_jobs() -> list[dict[str, Any]]:
    with _LOCK:
        jobs = sorted(_JOBS.values(), key=lambda j: j.created_at, reverse=True)
    return [public(j) for j in jobs[:100]]


def active_count() -> int:
    return sum(1 for j in _JOBS.values() if j.status in ("queued", "running"))


def status() -> dict[str, Any]:
    settings = registry.settings_of("whisper")
    model = settings.get("model", "small")
    engine = settings.get("engine", "local")
    cloud = db.cloud_stt_stats()
    return {
        "enabled": registry.is_enabled("whisper"),
        "device": device_label(),
        "model": model,
        "model_size": model_size_hint(model),
        "last_speed": db.meta_get("whisper_last_speed"),
        "active": active_count(),
        "schedule": settings.get("schedule", "en continu"),
        "window_open": _window_open(settings),
        # Cloud engine info for the settings card (default local).
        "engine": engine,
        "cloud_preset": settings.get("cloud_preset", ""),
        "cloud_minutes": cloud.get("minutes", 0),
        "cloud_month": cloud.get("month", ""),
    }


def restore_and_start() -> None:
    """Rebuild the queue from the DB (running → re-queued) and start the worker."""
    for row in db.tjob_all():
        status_ = row.get("status") or "queued"
        job = TJob(
            id=row["id"], content_id=row["content_id"], title=row.get("title") or "",
            status="queued" if status_ in ("running", "queued") else status_,
            progress=0 if status_ == "running" else (row.get("progress") or 0),
            model=row.get("model") or "small", created_at=row.get("created_at") or time.time(),
            started_at=row.get("started_at"), duration_ms=row.get("duration_ms"),
            error=row.get("error") or "",
        )
        _JOBS[job.id] = job
        if status_ == "running":
            _persist(job)  # write back the re-queued state
    threading.Thread(target=_worker, daemon=True, name="transcribe").start()
    threading.Thread(target=_reaper, daemon=True, name="transcribe-reaper").start()
    n = active_count()
    if n:
        print(f"[startup] transcription queue restored ({n} pending)", flush=True)
