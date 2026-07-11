"""Hybrid search + index management routes."""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from .. import indexer

router = APIRouter()


@router.get("/api/search")
async def search(q: str = "", scope: str = "all", limit: int = 20) -> JSONResponse:
    if not q.strip():
        return JSONResponse({"query": q, "took_ms": 0, "count": 0, "results": []})
    return JSONResponse(indexer.search(q, scope=scope, limit=max(1, min(limit, 50))))


@router.get("/api/index/stats")
async def index_stats() -> JSONResponse:
    return JSONResponse(indexer.stats())


@router.post("/api/index/backfill")
async def index_backfill() -> JSONResponse:
    return JSONResponse({"job_id": indexer.backfill(), "status": "started"})


@router.post("/api/index/rebuild")
async def index_rebuild() -> JSONResponse:
    return JSONResponse({"job_id": indexer.rebuild(), "status": "started"})
