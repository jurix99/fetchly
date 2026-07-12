"""Generation queue: turns a transcribed content into a summary + chapters via
the configured LLM (app/llm.py). Same shape as app/transcribe.py — a dedicated,
single-worker FIFO queue, persisted, resumable across restarts, honouring the
shared "deferred processing" night window.

Everything is optional and asynchronous: with no provider configured, nothing is
enqueued and no network call is ever made. Guardrails cap cost per content.
"""

from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from . import db, llm, store
from .plugins.registry import registry

# --- Guardrails ------------------------------------------------------------
_SHORT_TOKENS = 6000        # transcript ≤ this (est.) → single pass, else map-reduce
_MAX_MAP_CALLS = 40         # hard cap on per-content map calls (bounded cost)
# Budgets are generous because "thinking" models (e.g. gemini-2.5-flash) spend
# part of max_tokens on internal reasoning before emitting the answer.
_MAP_MAX_TOKENS = 512       # a chunk summary is 1–2 sentences (+ thinking headroom)
_REDUCE_MAX_TOKENS = 4096   # final summary_long + chapters (+ thinking headroom)
_CALL_TIMEOUT = 120.0       # per-call wall clock


@dataclass
class GJob:
    id: str
    content_id: str
    title: str
    task: str = "summary"  # the combined summary+chapters pass
    status: str = "queued"  # queued | running | done | error | canceled
    error: str = ""
    model: str = ""
    calls: int = 0
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    cancel_event: threading.Event = field(default_factory=threading.Event, repr=False)


_JOBS: dict[str, GJob] = {}
_LOCK = threading.Lock()
_COND = threading.Condition(_LOCK)


class _Canceled(Exception):
    pass


# --- persistence -----------------------------------------------------------
def _row(job: GJob) -> dict[str, Any]:
    return {
        "id": job.id, "content_id": job.content_id, "task": job.task,
        "title": job.title, "status": job.status, "error": job.error,
        "model": job.model, "calls": job.calls, "created_at": job.created_at,
        "started_at": job.started_at, "finished_at": job.finished_at,
    }


def _persist(job: GJob) -> None:
    try:
        db.gjob_upsert(_row(job))
    except Exception as exc:  # noqa: BLE001
        print(f"[generate] persist {job.id}: {exc}", flush=True)


def public(job: GJob) -> dict[str, Any]:
    return {
        "id": job.id, "content_id": job.content_id, "task": job.task,
        "title": job.title, "status": job.status, "error": job.error,
        "model": job.model, "calls": job.calls, "created_at": job.created_at,
    }


# --- prompt building -------------------------------------------------------
def _est_tokens(text: str) -> int:
    return max(1, len(text) // 4)


def _lang_line(output_language: str, content_language: str | None) -> str:
    if output_language and output_language != "auto":
        return f"Rédige la réponse en {output_language}."
    if content_language:
        return f"Rédige la réponse dans la langue du contenu ({content_language})."
    return "Rédige la réponse dans la langue du contenu."


def _style_line(style: str) -> str:
    return (
        "Style détaillé : développe et structure."
        if style == "détaillé"
        else "Style concis : va à l'essentiel."
    )


def _chapter_range(duration_s: float | None) -> tuple[int, int]:
    if not duration_s:
        return 3, 6
    target = int(round(duration_s / 480))  # ~1 chapter / 8 min
    lo = max(3, min(target - 1, 11))
    hi = max(lo + 1, min(target + 1, 12))
    return lo, min(hi, 12)


_SCHEMA = {
    "summary_short": "2 à 3 phrases",
    "summary_long": "3 à 6 paragraphes séparés par des doubles sauts de ligne",
    "chapters": "liste d'objets {start_ms, title}",
}


def _system(cfg: dict[str, Any], content_language: str | None) -> str:
    return (
        "Tu es un assistant qui analyse une transcription (vidéo/podcast) et produit "
        "un résumé et des chapitres fidèles au contenu. "
        + _lang_line(cfg.get("output_language", "auto"), content_language) + " "
        + _style_line(cfg.get("style", "concis"))
    )


def _final_instructions(lo: int, hi: int, extra_note: str = "") -> str:
    return (
        "Produis un objet JSON avec exactement ces clés :\n"
        '  "summary_short": ' + _SCHEMA["summary_short"] + "\n"
        '  "summary_long": ' + _SCHEMA["summary_long"] + "\n"
        '  "chapters": ' + _SCHEMA["chapters"] + "\n\n"
        f"Contraintes : entre {lo} et {hi} chapitres, dans l'ordre chronologique ; "
        "le champ start_ms de CHAQUE chapitre DOIT être exactement l'une des valeurs "
        "start_ms fournies ci-dessus (n'invente aucun horodatage) ; titres courts "
        "(≈ 3 à 7 mots)." + (f"\n{extra_note}" if extra_note else "")
    )


# --- generation ------------------------------------------------------------
def _gen_short(job: GJob, content: dict[str, Any], segments: list[dict[str, Any]], cfg: dict[str, Any]) -> dict[str, Any]:
    """Single pass over the full timestamped transcript (short content)."""
    lo, hi = _chapter_range(content.get("duration_seconds"))
    lines = "\n".join(f"{s['start_ms']} | {s['text']}" for s in segments)
    prompt = (
        "Transcription horodatée (chaque ligne : start_ms | texte) :\n"
        f"{lines}\n\n{_final_instructions(lo, hi)}"
    )
    job.calls += 1
    return llm.generate(
        _system(cfg, content.get("language")), prompt,
        json_schema=_SCHEMA, max_tokens=_REDUCE_MAX_TOKENS, timeout=_CALL_TIMEOUT,
    )


def _gen_mapreduce(job: GJob, content: dict[str, Any], chunks: list[dict[str, Any]], cfg: dict[str, Any]) -> dict[str, Any]:
    """Long content: summarize each chunk (map), then synthesize (reduce)."""
    system = _system(cfg, content.get("language"))
    truncated = len(chunks) > _MAX_MAP_CALLS
    used = chunks[:_MAX_MAP_CALLS]
    map_summaries: list[tuple[int, str]] = []
    for ch in used:
        if job.cancel_event.is_set():
            raise _Canceled()
        job.calls += 1
        summary = llm.generate(
            system + " Résume le passage suivant en 1 à 2 phrases, sans préambule.",
            ch["text"], json_schema=None, max_tokens=_MAP_MAX_TOKENS, timeout=_CALL_TIMEOUT,
        )
        map_summaries.append((ch["start_ms"], (summary or "").strip()))

    lo, hi = _chapter_range(content.get("duration_seconds"))
    joined = "\n".join(f"{ms} | {summ}" for ms, summ in map_summaries if summ)
    note = ""
    if truncated:
        covered = used[-1]["end_ms"] // 60000
        note = (
            "Note : le contenu est long ; ce résumé couvre les "
            f"~{covered} premières minutes. Mentionne-le dans summary_long."
        )
    prompt = (
        "Résumés successifs des passages (chaque ligne : start_ms | résumé) :\n"
        f"{joined}\n\n{_final_instructions(lo, hi, note)}"
    )
    if job.cancel_event.is_set():
        raise _Canceled()
    job.calls += 1
    return llm.generate(
        system, prompt, json_schema=_SCHEMA, max_tokens=_REDUCE_MAX_TOKENS, timeout=_CALL_TIMEOUT,
    )


def _finalize(content_id: str, data: Any, seg_starts: list[int], cfg: dict[str, Any], duration_s: float | None) -> None:
    """Coerce, snap chapter timestamps to real segment starts, clamp count, store."""
    if not isinstance(data, dict):
        raise llm.LLMError("Réponse du modèle inattendue (pas un objet)")
    short = str(data.get("summary_short") or "").strip()
    long = str(data.get("summary_long") or "").strip()
    if not short and not long:
        raise llm.LLMError("Le modèle n'a produit aucun résumé")

    _lo, hi = _chapter_range(duration_s)
    raw = data.get("chapters")
    chapters: list[tuple[int, str]] = []
    seen: set[int] = set()
    if isinstance(raw, list):
        for item in raw:
            if not isinstance(item, dict):
                continue
            try:
                start = int(item.get("start_ms"))
            except (TypeError, ValueError):
                continue
            title = str(item.get("title") or "").strip()
            if not title:
                continue
            snapped = min(seg_starts, key=lambda s: abs(s - start)) if seg_starts else max(0, start)
            if snapped in seen:
                continue
            seen.add(snapped)
            chapters.append((snapped, title))
    chapters.sort(key=lambda c: c[0])
    chapters = chapters[:hi]

    model = cfg.get("model", "")
    db.content_set_summary(content_id, short, long, model, time.time())
    db.chapters_replace(content_id, chapters)


def _generate(job: GJob) -> None:
    content = db.content_get(job.content_id)
    if not content:
        raise llm.LLMError("Contenu introuvable")
    segments = db.segments_get(job.content_id)
    if not segments:
        raise llm.LLMError("Pas de transcription à résumer")
    cfg = store.get_intelligence()
    job.model = cfg.get("model", "")

    seg_starts = [s["start_ms"] for s in segments]
    full_text = " ".join(s["text"] for s in segments)
    if _est_tokens(full_text) <= _SHORT_TOKENS:
        data = _gen_short(job, content, segments, cfg)
    else:
        chunks = db.chunks_of(job.content_id) or [
            {"start_ms": s["start_ms"], "end_ms": s["end_ms"], "text": s["text"]} for s in segments
        ]
        data = _gen_mapreduce(job, content, chunks, cfg)
    _finalize(job.content_id, data, seg_starts, cfg, content.get("duration_seconds"))


def _run_job(job: GJob) -> None:
    job.status = "running"
    job.started_at = time.time()
    db.content_set_generation(job.content_id, "running")
    _persist(job)
    try:
        _generate(job)
        job.status = "done"
    except _Canceled:
        job.status = "canceled"
        db.content_set_generation(job.content_id, "none")
    except Exception as exc:  # noqa: BLE001 — never crashes the worker
        job.status = "error"
        job.error = str(exc)
        db.content_set_generation(job.content_id, "error")
        print(f"[generate] job {job.id} error: {exc}", flush=True)
    finally:
        job.finished_at = time.time()
        print(f"[generate] job {job.id} {job.status} — {job.calls} appel(s) LLM", flush=True)
        _persist(job)


# --- worker ----------------------------------------------------------------
def _window_open() -> bool:
    # Shared "deferred processing" window with transcription (whisper settings).
    from . import transcribe
    return transcribe._window_open(registry.settings_of("whisper"))


def _next_queued() -> GJob | None:
    queued = [j for j in _JOBS.values() if j.status == "queued"]
    queued.sort(key=lambda j: j.created_at)
    return queued[0] if queued else None


def _worker() -> None:
    while True:
        with _COND:
            while True:
                job = _next_queued()
                if job is not None and _window_open():
                    break
                _COND.wait(timeout=30)
        if job.cancel_event.is_set():
            job.status = "canceled"
            _persist(job)
            continue
        _run_job(job)


# --- public API ------------------------------------------------------------
def enqueue(content_id: str, title: str | None = None, force: bool = False) -> str | None:
    content = db.content_get(content_id)
    if not content:
        return None
    with _COND:
        for j in _JOBS.values():
            if j.content_id == content_id and j.status in ("queued", "running"):
                return j.id  # dedup
        job = GJob(
            id=str(uuid.uuid4()),
            content_id=content_id,
            title=title or content.get("title") or "",
            model=store.get_intelligence().get("model", ""),
        )
        _JOBS[job.id] = job
        _persist(job)
        db.content_set_generation(content_id, "queued")
        _COND.notify_all()
    return job.id


def on_transcribed(content_id: str) -> None:
    """Trigger hook called from the transcription worker on success. No-op unless
    a provider is configured; skips content that already has a summary."""
    if not llm.configured():
        return
    row = db.content_get(content_id)
    if not row:
        return
    if row.get("summary_generated_at"):  # already summarized — don't auto-redo
        return
    enqueue(content_id, row.get("title"))


def backfill(only_missing: bool = True) -> int:
    if not llm.configured():
        return 0
    rows = db.contents_without_summary() if only_missing else db.content_list(limit=100000)[0]
    n = 0
    for row in rows:
        if row.get("transcript_status") not in ("done", "skipped"):
            continue
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
            db.content_set_generation(job.content_id, "none")
        _COND.notify_all()
    return True


def list_jobs() -> list[dict[str, Any]]:
    with _LOCK:
        jobs = sorted(_JOBS.values(), key=lambda j: j.created_at, reverse=True)
    return [public(j) for j in jobs[:100]]


def active_count() -> int:
    return sum(1 for j in _JOBS.values() if j.status in ("queued", "running"))


def restore_and_start() -> None:
    """Rebuild the queue from the DB (running → re-queued) and start the worker."""
    for row in db.gjob_all():
        st = row.get("status") or "queued"
        job = GJob(
            id=row["id"], content_id=row["content_id"], title=row.get("title") or "",
            task=row.get("task") or "summary",
            status="queued" if st in ("running", "queued") else st,
            error=row.get("error") or "", model=row.get("model") or "",
            calls=row.get("calls") or 0, created_at=row.get("created_at") or time.time(),
            started_at=row.get("started_at"), finished_at=row.get("finished_at"),
        )
        _JOBS[job.id] = job
        if st == "running":
            _persist(job)
    threading.Thread(target=_worker, daemon=True, name="generate").start()
    n = active_count()
    if n:
        print(f"[startup] generation queue restored ({n} pending)", flush=True)
