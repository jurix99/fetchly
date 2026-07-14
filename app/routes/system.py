"""System routes (disk usage)."""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from .. import db, store
from ..runtime import _GB, _disk_info, _min_free_bytes

router = APIRouter()


@router.get("/api/system/celebration")
async def get_celebration() -> JSONResponse:
    """The one-time first-transcript "aha" callout: show it once the instance has
    ever produced a transcript, until the user uses search or dismisses it."""
    at = db.meta_get("first_transcript_at")
    celebrated = db.meta_get("first_transcript_celebrated") == "1"
    return JSONResponse({
        "show": bool(at) and not celebrated,
        "content_id": db.meta_get("first_transcript_content") or None,
    })


@router.post("/api/system/celebration/dismiss")
async def dismiss_celebration() -> JSONResponse:
    db.meta_set("first_transcript_celebrated", "1")
    return JSONResponse({"ok": True})


@router.get("/api/disk")
async def get_disk() -> JSONResponse:
    info = _disk_info()
    floor = _min_free_bytes()
    return JSONResponse(
        {
            **info,
            "free_gb": round(info["free"] / _GB, 1),
            "total_gb": round(info["total"] / _GB, 1),
            "min_free_gb": store.get_settings().get("min_free_gb", 0),
            "low": floor > 0 and info["free"] < floor,
        }
    )
