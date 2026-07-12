"""Generation (summary + chapters) routes — drive the queue in app/generate.py."""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from .. import db, generate, llm
from ..schemas import BackfillRequest

router = APIRouter()


@router.post("/api/library/{content_id}/generate")
async def generate_content(content_id: str) -> JSONResponse:
    """Force (re)generation for one content — overwrites any existing summary."""
    if not db.content_get(content_id):
        return JSONResponse({"error": "Contenu inconnu"}, status_code=404)
    if not llm.configured():
        return JSONResponse({"error": "Aucun fournisseur IA configuré"}, status_code=409)
    job_id = generate.enqueue(content_id, force=True)
    return JSONResponse({"job_id": job_id, "status": "queued"})


@router.post("/api/generate/backfill")
async def generate_backfill(req: BackfillRequest) -> JSONResponse:
    if not llm.configured():
        return JSONResponse({"error": "Aucun fournisseur IA configuré"}, status_code=409)
    return JSONResponse({"queued": generate.backfill(only_missing=req.only_missing)})


@router.get("/api/generation-jobs")
async def generation_jobs() -> JSONResponse:
    return JSONResponse(generate.list_jobs())


@router.post("/api/generation-jobs/{job_id}/cancel")
async def cancel_generation(job_id: str) -> JSONResponse:
    ok = generate.cancel(job_id)
    return JSONResponse({"status": "canceled" if ok else "noop"})
