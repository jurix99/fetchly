"""Library (downloaded media) routes."""

from __future__ import annotations

from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from ..runtime import DOWNLOAD_DIR, MEDIA_EXTS

router = APIRouter()


def _media_url(path: Path) -> str:
    rel = path.relative_to(DOWNLOAD_DIR).as_posix()
    return "/media/" + quote(rel)


@router.get("/api/files")
async def list_files() -> JSONResponse:
    """Downloaded media for the Library view, newest first, each paired with its
    .jpg thumbnail if one was saved."""
    items = []
    for p in DOWNLOAD_DIR.rglob("*"):
        if p.suffix.lstrip(".").lower() not in MEDIA_EXTS or not p.is_file():
            continue
        try:
            st = p.stat()
        except OSError:
            continue
        thumb = p.with_suffix(".jpg")
        rel = p.relative_to(DOWNLOAD_DIR)
        items.append(
            {
                "name": p.stem,
                "folder": rel.parent.as_posix() if rel.parent.as_posix() != "." else "",
                "url": _media_url(p),
                "thumb": _media_url(thumb) if thumb.exists() else None,
                "size": st.st_size,
                "mtime": st.st_mtime,
            }
        )
    items.sort(key=lambda x: x["mtime"], reverse=True)
    return JSONResponse(items)
