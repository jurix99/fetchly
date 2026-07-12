"""Hybrid search + index management routes."""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from .. import db, indexer
from ..schemas import SearchFeedbackRequest

router = APIRouter()


@router.get("/api/search")
async def search(
    q: str = "",
    scope: str = "all",
    limit: int = 20,
    passage_limit: int = 3,
    source: str | None = None,
    channel: str | None = None,
    period: str | None = None,
    min_duration: int | None = None,
    max_duration: int | None = None,
) -> JSONResponse:
    if not q.strip():
        stats = db.index_stats()
        return JSONResponse({
            "query": q, "query_hash": "", "took_ms": 0, "count": 0,
            "indexed": stats.get("indexed", 0), "total": stats.get("total", 0),
            "semantic": db.VEC_OK, "results": [],
        })
    return JSONResponse(indexer.search(
        q, scope=scope, limit=max(1, min(limit, 50)),
        passage_limit=max(1, min(passage_limit, 30)),
        source=source, channel=channel, period=period,
        min_duration=min_duration, max_duration=max_duration,
    ))


@router.post("/api/search/feedback")
async def search_feedback(req: SearchFeedbackRequest) -> JSONResponse:
    """LOCAL instrumentation only: flip a search to a 'retrouvaille' when the user
    opens one of its results. Nothing leaves this machine."""
    if req.clicked and req.query_hash:
        db.search_event_mark_clicked(req.query_hash)
    return JSONResponse({"ok": True})


@router.get("/api/search/metrics")
async def search_metrics() -> JSONResponse:
    return JSONResponse(db.search_metrics())


@router.get("/api/index/stats")
async def index_stats() -> JSONResponse:
    return JSONResponse(indexer.stats())


@router.post("/api/index/backfill")
async def index_backfill() -> JSONResponse:
    return JSONResponse({"job_id": indexer.backfill(), "status": "started"})


@router.post("/api/index/rebuild")
async def index_rebuild() -> JSONResponse:
    return JSONResponse({"job_id": indexer.rebuild(), "status": "started"})
