"""Clip extraction — pull a short video/audio excerpt of a transcript passage
with ffmpeg. Runs on the existing background-task queue (jobs.create_task) so a
slow or failing extraction never affects the source content.

Clips are files under /downloads/.fetchly/clips tracked in the `clips` table —
they are excerpts, NOT library contents (no `contents` row). Precision is
favoured over speed (short clips): we seek+re-encode for frame-accurate bounds.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path

from . import db, jobs
from .runtime import DOWNLOAD_DIR

CLIPS_DIR = DOWNLOAD_DIR / ".fetchly" / "clips"
MAX_CLIP_S = 300          # 5 min hard cap (413 above)
_MARGIN_S = 1.0           # 1 s of air before/after the passage


class ClipError(Exception):
    pass


def _ffmpeg() -> str:
    return shutil.which("ffmpeg") or "ffmpeg"


def _slug(title: str) -> str:
    s = re.sub(r"[^A-Za-z0-9]+", "-", (title or "clip")).strip("-").lower()
    return (s[:40].rstrip("-")) or "clip"


def _mmss(ms: int) -> str:
    s = max(0, int(ms // 1000))
    return f"{s // 60:02d}{s % 60:02d}"


def duration_error(start_ms: int, end_ms: int) -> str | None:
    """Validation message, or None if the [start, end] span is acceptable."""
    if end_ms <= start_ms:
        return "Bornes invalides (fin ≤ début)."
    if (end_ms - start_ms) > MAX_CLIP_S * 1000:
        return f"Clip trop long (max {MAX_CLIP_S // 60} min)."
    return None


def _build_clip(src: Path, start_ms: int, end_ms: int, fmt: str, title: str) -> Path:
    CLIPS_DIR.mkdir(parents=True, exist_ok=True)
    s0 = max(0.0, start_ms / 1000 - _MARGIN_S)
    s1 = end_ms / 1000 + _MARGIN_S
    ext = "m4a" if fmt == "audio" else "mp4"
    name = f"{_slug(title)}_{_mmss(start_ms)}-{_mmss(end_ms)}.{ext}"
    out = CLIPS_DIR / name
    if out.exists():
        name = f"{_slug(title)}_{_mmss(start_ms)}-{_mmss(end_ms)}_{uuid.uuid4().hex[:6]}.{ext}"
        out = CLIPS_DIR / name

    base = [_ffmpeg(), "-nostdin", "-y", "-i", str(src), "-ss", f"{s0:.3f}", "-to", f"{s1:.3f}"]
    if fmt == "audio":
        cmd = [*base, "-vn", "-c:a", "aac", "-b:a", "192k", str(out)]
    else:
        # Re-encode for frame-accurate bounds (precision > speed for short clips).
        cmd = [
            *base, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
            "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(out)
        ]
    proc = subprocess.run(cmd, capture_output=True, timeout=900, check=False)
    if proc.returncode != 0 or not out.exists() or out.stat().st_size == 0:
        tail = proc.stderr.decode("utf-8", "replace")[-300:] if proc.stderr else ""
        raise ClipError(f"Extraction ffmpeg échouée. {tail}")
    return out


def _run(job, content: dict, start_ms: int, end_ms: int, fmt: str) -> None:
    src = Path(content.get("filepath") or "")
    try:
        if not src.is_file():
            raise ClipError("Fichier média introuvable sur le disque")
        out = _build_clip(src, start_ms, end_ms, fmt, content.get("title") or "clip")
        db.clip_create(str(uuid.uuid4()), content["id"], str(out), fmt, start_ms, end_ms)
        job.status = "done"
        job.completed = 1
        job.files = [str(out)]
        job.log.append(f"Clip créé : {out.name}")
    except Exception as exc:  # noqa: BLE001 — a clip failure never affects the content
        job.status = "error"
        job.error = str(exc)
        print(f"[clips] job {job.id} error: {exc}", flush=True)
    finally:
        job.finished_at = time.time()
        jobs.persist(job)


def start(content_id: str, start_ms: int, end_ms: int, fmt: str) -> str | None:
    """Enqueue a clip job (assumes bounds already validated). Returns the job id."""
    content = db.content_get(content_id)
    if not content:
        return None
    fmt = "audio" if fmt == "audio" else "video"
    job = jobs.create_task(f"Clip · {content.get('title') or ''}".strip(), total=1)
    threading.Thread(
        target=_run, args=(job, content, start_ms, end_ms, fmt), daemon=True, name="clip",
    ).start()
    return job.id
