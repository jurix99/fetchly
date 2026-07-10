"""Settings, notifications and cookies routes."""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from .. import cookies, jobs, notify, store
from ..plugins.builtin.ytdlp_source import QUALITY_FORMATS
from ..runtime import DOWNLOAD_DIR
from ..schemas import CookiesRequest, NotificationsRequest, SettingsRequest

router = APIRouter()

_MEDIA_SETTING_KEYS = (
    "subtitles", "subtitle_langs", "embed_subtitles", "embed_thumbnail",
    "embed_metadata", "embed_chapters", "sponsorblock", "sponsorblock_mode",
    "bandwidth_limit", "download_archive", "min_free_gb", "nfo_export",
)


def _settings_payload() -> dict:
    data = store.get_settings()
    data["download_dir"] = str(DOWNLOAD_DIR)
    data["qualities"] = list(QUALITY_FORMATS.keys())
    return data


@router.get("/api/settings")
async def get_settings() -> JSONResponse:
    return JSONResponse(_settings_payload())


@router.post("/api/settings")
async def set_settings(req: SettingsRequest) -> JSONResponse:
    media = {k: getattr(req, k) for k in _MEDIA_SETTING_KEYS if getattr(req, k) is not None}
    cfg = store.update_settings(
        req.default_quality,
        req.watch_interval_minutes,
        req.organize,
        req.max_concurrent,
        media=media or None,
    )
    jobs.set_concurrency(cfg.get("max_concurrent", 3))
    return JSONResponse(_settings_payload())


@router.get("/api/notifications")
async def get_notifications() -> JSONResponse:
    data = store.get_notifications()
    data["available"] = notify.available()
    return JSONResponse(data)


@router.post("/api/notifications")
async def set_notifications(req: NotificationsRequest) -> JSONResponse:
    events = {"on_video": req.on_video, "on_error": req.on_error, "on_summary": req.on_summary}
    cfg = store.update_notifications(req.enabled, req.urls, events=events)
    return JSONResponse(cfg)


@router.post("/api/notifications/test")
async def test_notifications(req: NotificationsRequest) -> JSONResponse:
    urls = req.urls if req.urls is not None else store.get_notifications()["urls"]
    ok, message = notify.send_test(urls)
    return JSONResponse({"ok": ok, "message": message}, status_code=200 if ok else 400)


@router.get("/api/cookies")
async def get_cookies() -> JSONResponse:
    return JSONResponse(cookies.status())


@router.post("/api/cookies")
async def set_cookies(req: CookiesRequest) -> JSONResponse:
    ok, message = cookies.save(req.content or "")
    if not ok:
        return JSONResponse({"ok": False, "message": message}, status_code=400)
    return JSONResponse({"ok": True, "message": message, **cookies.status()})


@router.delete("/api/cookies")
async def delete_cookies() -> JSONResponse:
    return JSONResponse({"removed": cookies.clear(), **cookies.status()})
