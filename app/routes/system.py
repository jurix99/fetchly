"""System routes (disk usage)."""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from .. import store
from ..runtime import _GB, _disk_info, _min_free_bytes

router = APIRouter()


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
