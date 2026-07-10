"""Content-discovery routes (extract / channel / search) — delegate to the
source plugin's extraction helpers. Kept separate from downloads so the routes
stay thin and source-agnostic at the HTTP layer."""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from ..plugins.builtin import ytdlp_source as ytsrc
from ..schemas import ChannelVideosRequest, ExtractRequest, SearchRequest

router = APIRouter()


@router.post("/api/extract")
async def extract(req: ExtractRequest) -> JSONResponse:
    if not req.url.strip():
        return JSONResponse({"error": "URL requise"}, status_code=400)
    data = ytsrc.extract_url(req.url.strip(), req.limit)
    return JSONResponse(data, status_code=400 if data.get("error") else 200)


@router.post("/api/channel")
async def channel_info(req: ExtractRequest) -> JSONResponse:
    if not req.url.strip():
        return JSONResponse({"error": "URL requise"}, status_code=400)
    data = ytsrc.channel_info(req.url.strip())
    return JSONResponse(data, status_code=400 if data.get("error") else 200)


@router.post("/api/channel/videos")
async def channel_videos(req: ChannelVideosRequest) -> JSONResponse:
    if not req.url.strip():
        return JSONResponse({"error": "URL requise"}, status_code=400)
    data = ytsrc.channel_videos(req.url.strip(), req.offset, req.limit)
    return JSONResponse(data, status_code=400 if data.get("error") else 200)


@router.post("/api/search")
async def search(req: SearchRequest) -> JSONResponse:
    if not req.query.strip():
        return JSONResponse({"error": "Recherche vide"}, status_code=400)
    data = ytsrc.search(req.query.strip(), req.limit)
    return JSONResponse(data, status_code=400 if data.get("error") else 200)
