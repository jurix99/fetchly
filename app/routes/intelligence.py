"""Intelligence (LLM provider) settings routes. The api_key is never returned —
responses expose `has_key` instead. Testing uses the saved config."""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from .. import llm, store
from ..schemas import IntelligenceRequest

router = APIRouter()


@router.get("/api/intelligence")
async def get_intelligence() -> JSONResponse:
    return JSONResponse(store.public_intelligence())


@router.get("/api/intelligence/presets")
async def get_presets() -> JSONResponse:
    return JSONResponse({"presets": llm.presets_public()})


@router.post("/api/intelligence")
async def save_intelligence(req: IntelligenceRequest) -> JSONResponse:
    patch = {k: v for k, v in req.model_dump().items() if v is not None or k == "api_key"}
    # api_key None means "keep" (handled in store), so only forward it when the
    # client explicitly sent something (including "" to clear).
    if req.api_key is None:
        patch.pop("api_key", None)
    return JSONResponse(store.update_intelligence(patch))


@router.post("/api/intelligence/test")
async def test_intelligence() -> JSONResponse:
    return JSONResponse(llm.test_connection())
