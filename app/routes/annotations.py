"""Highlights, notes and clips — the "attention capteurs" that weight the memory
and produce the first shareable objects (citations, clips)."""

from __future__ import annotations

import mimetypes
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter
from fastapi.responses import FileResponse, JSONResponse

from .. import clips, db, library
from ..schemas import ClipRequest, HighlightCreateRequest, HighlightNoteRequest

router = APIRouter()


# --- highlights ------------------------------------------------------------
@router.post("/api/library/{content_id}/highlights")
async def create_highlight(content_id: str, req: HighlightCreateRequest) -> JSONResponse:
    if not db.content_get(content_id):
        return JSONResponse({"error": "Contenu inconnu"}, status_code=404)
    span = library.rebuild_span(content_id, req.start_ms, req.end_ms)
    if span is None:
        return JSONResponse({"error": "Aucun segment de transcript sur cette sélection."}, status_code=400)
    start, end, text = span
    hl = db.highlight_create(content_id, start, end, text, color="amber")
    return JSONResponse(hl, status_code=201)


@router.patch("/api/highlights/{highlight_id}")
async def update_highlight(highlight_id: int, req: HighlightNoteRequest) -> JSONResponse:
    hl = db.highlight_set_note(highlight_id, req.note)
    if hl is None:
        return JSONResponse({"error": "Surlignage inconnu"}, status_code=404)
    return JSONResponse(hl)


@router.delete("/api/highlights/{highlight_id}")
async def delete_highlight(highlight_id: int) -> JSONResponse:
    cid = db.highlight_delete(highlight_id)
    if cid is None:
        return JSONResponse({"error": "Surlignage inconnu"}, status_code=404)
    return JSONResponse({"removed": True, "content_id": cid})


@router.get("/api/highlights")
async def list_highlights(
    content_id: str | None = None, limit: int = 50, offset: int = 0, sort: str = "recent",
) -> JSONResponse:
    items, total = db.highlights_all(limit=limit, offset=offset, sort=sort, content_id=content_id)
    # Enrich with a light source card for the global "Citations" view.
    cache: dict[str, dict] = {}
    for h in items:
        cid = h["content_id"]
        row = cache.get(cid) or db.content_get(cid) or {}
        cache[cid] = row
        h["content_title"] = row.get("title") or ""
        h["content_channel"] = row.get("channel") or ""
        h["content_thumbnail_url"] = library._media_url(row.get("thumbnail_path"))
    return JSONResponse({"items": items, "total": total, "limit": limit, "offset": offset})


# --- clips -----------------------------------------------------------------
def _clip_public(clip: dict) -> dict:
    name = Path(clip["path"]).name
    return {
        **clip,
        "name": name,
        "url": f"/api/clips/{clip['id']}/download",
        "exists": Path(clip["path"]).exists(),
    }


@router.post("/api/library/{content_id}/clip")
async def create_clip(content_id: str, req: ClipRequest) -> JSONResponse:
    if not db.content_get(content_id):
        return JSONResponse({"error": "Contenu inconnu"}, status_code=404)
    err = clips.duration_error(req.start_ms, req.end_ms)
    if err:
        code = 413 if "trop long" in err else 400
        return JSONResponse({"error": err}, status_code=code)
    job_id = clips.start(content_id, req.start_ms, req.end_ms, req.format)
    return JSONResponse({"job_id": job_id, "status": "started"})


@router.get("/api/library/{content_id}/clips")
async def list_clips(content_id: str) -> JSONResponse:
    return JSONResponse({"content_id": content_id, "clips": [_clip_public(c) for c in db.clips_get(content_id)]})


@router.get("/api/clips/{clip_id}/download")
async def download_clip(clip_id: str):
    clip = db.clip_get(clip_id)
    if not clip:
        return JSONResponse({"error": "Clip inconnu"}, status_code=404)
    path = Path(clip["path"])
    # Path-traversal guard: the file must live under the clips dir.
    if not library.is_within(path, clips.CLIPS_DIR) or not path.is_file():
        return JSONResponse({"error": "Fichier introuvable"}, status_code=404)
    ctype = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
    headers = {"Content-Disposition": f"attachment; filename*=UTF-8''{quote(path.name)}"}
    return FileResponse(str(path), media_type=ctype, headers=headers, filename=path.name)
