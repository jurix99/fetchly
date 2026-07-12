"""Library routes: browse the `contents` table, stream media (with HTTP Range
for instant seek), delete entries (± file), and trigger a rescan."""

from __future__ import annotations

import mimetypes
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

from .. import db, indexer, library
from ..runtime import DOWNLOAD_DIR

router = APIRouter()

_CHUNK = 256 * 1024


@router.get("/api/library")
async def list_library(
    limit: int = 40, offset: int = 0, sort: str = "downloaded_at", order: str = "desc",
    source: str | None = None, watch_id: str | None = None,
    kind: str | None = None, q: str | None = None, transcribed: str | None = None,
) -> JSONResponse:
    rows, total = db.content_list(
        limit=limit, offset=offset, sort=sort, order=order,
        source=source, watch_id=watch_id, kind=kind, q=q, transcribed=transcribed,
    )
    return JSONResponse(
        {
            "items": [library.to_public(r) for r in rows],
            "total": total,
            "limit": limit,
            "offset": offset,
        }
    )


@router.post("/api/library/rescan")
async def rescan_library() -> JSONResponse:
    return JSONResponse({"job_id": library.rescan(), "status": "started"})


@router.get("/api/library/{content_id}")
async def get_content(content_id: str) -> JSONResponse:
    row = db.content_get(content_id)
    if not row:
        return JSONResponse({"error": "Contenu inconnu"}, status_code=404)
    return JSONResponse(library.to_public(row))


@router.get("/api/library/{content_id}/related")
async def related_content(content_id: str, limit: int = 5) -> JSONResponse:
    """Contents in the user's own library close to this one (the first crossing of
    the memory). Cached per content, invalidated when either side re-indexes."""
    row = db.content_get(content_id)
    if not row:
        return JSONResponse({"error": "Contenu inconnu"}, status_code=404)
    return JSONResponse(indexer.related(content_id, limit=max(1, min(limit, 10))))


@router.delete("/api/library/{content_id}")
async def delete_content(content_id: str, delete_file: bool = False) -> JSONResponse:
    row = db.content_get(content_id)
    if not row:
        return JSONResponse({"error": "Contenu inconnu"}, status_code=404)

    removed_file = False
    if delete_file:
        removed_file = _delete_files(row)
    db.content_delete(content_id)
    return JSONResponse({"removed": True, "file_removed": removed_file})


def _within_downloads(path: Path) -> bool:
    return library.is_within(path, DOWNLOAD_DIR)


def _delete_files(row: dict) -> bool:
    """Delete the media file + its known sidecars — only inside the downloads
    dir (path-traversal guard). Never raises."""
    removed = False
    fp = row.get("filepath")
    if fp:
        media = Path(fp)
        if _within_downloads(media):
            stem = media.with_suffix("")
            candidates = [
                media,
                Path(str(stem) + ".jpg"),
                Path(str(stem) + "-thumb.jpg"),
                Path(str(stem) + ".nfo"),
                Path(str(stem) + ".info.json"),
            ]
            for c in candidates:
                try:
                    if c.exists() and _within_downloads(c):
                        c.unlink()
                        if c == media:
                            removed = True
                except OSError:
                    pass
    thumb = row.get("thumbnail_path")
    if thumb:
        tp = Path(thumb)
        try:
            if tp.exists() and _within_downloads(tp):
                tp.unlink()
        except OSError:
            pass
    return removed


@router.get("/api/library/{content_id}/stream")
async def stream_content(content_id: str, request: Request):
    path = library.resolve_media(content_id)
    if path is None:
        return JSONResponse({"error": "Fichier introuvable"}, status_code=404)
    file_size = path.stat().st_size
    ctype = mimetypes.guess_type(str(path))[0] or "application/octet-stream"

    rng = library.parse_byte_range(request.headers.get("range"), file_size)
    if rng:
        start, end = rng
        length = end - start + 1

        def iter_range():
            with open(path, "rb") as f:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = f.read(min(_CHUNK, remaining))
                    if not chunk:
                        break
                    remaining -= len(chunk)
                    yield chunk

        return StreamingResponse(
            iter_range(),
            status_code=206,
            headers={
                "Content-Range": f"bytes {start}-{end}/{file_size}",
                "Accept-Ranges": "bytes",
                "Content-Length": str(length),
                "Content-Type": ctype,
            },
        )

    def iter_full():
        with open(path, "rb") as f:
            while True:
                chunk = f.read(_CHUNK)
                if not chunk:
                    break
                yield chunk

    return StreamingResponse(
        iter_full(),
        headers={
            "Content-Length": str(file_size),
            "Accept-Ranges": "bytes",
            "Content-Type": ctype,
        },
    )
