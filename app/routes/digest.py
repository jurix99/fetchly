"""Digest routes: the Bibliothèque "since your last visit" payload, visit-state
actions, and the optional weekly-e-mail settings + preview."""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from .. import db, digest, store
from ..schemas import DigestSeenRequest, DigestSettingsRequest

router = APIRouter()


@router.get("/api/digest")
async def get_digest() -> JSONResponse:
    return JSONResponse(digest.build())


@router.get("/api/digest/new-count")
async def new_count() -> JSONResponse:
    return JSONResponse({"count": digest.new_count()})


@router.post("/api/digest/seen")
async def mark_seen(req: DigestSeenRequest) -> JSONResponse:
    if req.all:
        digest.mark_all_seen()
        return JSONResponse({"ok": True, "all": True})
    ids = [c for c in (req.content_ids or []) if c]
    db.content_mark_seen(ids)
    return JSONResponse({"ok": True, "count": len(ids)})


@router.get("/api/digest/settings")
async def get_settings() -> JSONResponse:
    return JSONResponse(store.get_digest())


@router.post("/api/digest/settings")
async def save_settings(req: DigestSettingsRequest) -> JSONResponse:
    patch = {k: v for k, v in req.model_dump().items() if v is not None}
    return JSONResponse(store.update_digest(patch))


@router.post("/api/digest/email-preview")
async def email_preview() -> JSONResponse:
    ok, message = digest.send_email_now()
    return JSONResponse({"ok": ok, "message": message})
