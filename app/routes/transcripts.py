"""Transcription routes: the dedicated queue, per-content transcript + actions."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from .. import db, library, transcribe
from ..schemas import BackfillRequest

router = APIRouter()


@router.get("/api/transcripts/status")
async def transcripts_status() -> JSONResponse:
    return JSONResponse(transcribe.status())


@router.post("/api/transcripts/backfill")
async def transcripts_backfill(req: BackfillRequest) -> JSONResponse:
    n = transcribe.backfill(only_missing=req.only_missing)
    return JSONResponse({"queued": n})


@router.get("/api/transcript-jobs")
async def list_transcript_jobs() -> JSONResponse:
    return JSONResponse(transcribe.list_jobs())


@router.post("/api/transcript-jobs/{job_id}/cancel")
async def cancel_transcript_job(job_id: str) -> JSONResponse:
    if not transcribe.cancel(job_id):
        return JSONResponse({"error": "Tâche inconnue ou déjà terminée"}, status_code=409)
    return JSONResponse({"status": "canceled"})


@router.post("/api/library/{content_id}/transcribe")
async def transcribe_content(content_id: str) -> JSONResponse:
    if not db.content_get(content_id):
        return JSONResponse({"error": "Contenu inconnu"}, status_code=404)
    job_id = transcribe.enqueue(content_id, force=True)
    return JSONResponse({"job_id": job_id, "status": "queued"})


@router.get("/api/library/{content_id}/transcript")
async def get_transcript(content_id: str) -> JSONResponse:
    content = db.content_get(content_id)
    if not content:
        return JSONResponse({"error": "Contenu inconnu"}, status_code=404)
    segments = db.segments_get(content_id)
    fp = content.get("filepath") or ""
    # For 'skipped' content we didn't produce our own segments — surface the
    # existing source captions so the Transcript tab still shows something.
    source_subs = False
    if not segments and fp:
        parsed = transcribe.source_captions(Path(fp))
        if parsed:
            segments = parsed
            source_subs = True
    srt = Path(fp).with_suffix(".srt") if fp else None
    vtt = Path(fp).with_suffix(".vtt") if fp else None
    # Latest transcription job for this content (in-progress / error surfacing).
    job = next((j for j in transcribe.list_jobs() if j["content_id"] == content_id), None)
    return JSONResponse(
        {
            "status": content.get("transcript_status") or "none",
            "language": content.get("language"),
            "segments": segments,
            "source_subs": source_subs,
            "srt_url": library._media_url(str(srt)) if srt and srt.exists() else None,
            "vtt_url": library._media_url(str(vtt)) if vtt and vtt.exists() else None,
            "job": job,
        }
    )
