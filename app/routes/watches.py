"""Subscription (watch) + preview-filters + YouTube-subscriptions routes."""

from __future__ import annotations

import threading
from typing import Any

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from .. import cookies, store, watches
from ..plugins.builtin import ytdlp_source as ytsrc
from ..schemas import (
    DEFAULT_FILTERS,
    FollowSubsRequest,
    PreviewFiltersRequest,
    SubscriptionFiltersModel,
    WatchRequest,
    WatchUpdate,
)

router = APIRouter()


def _filters_from_request(
    model: SubscriptionFiltersModel | None,
    legacy_shorts: bool = False,
    legacy_lives: bool = False,
) -> dict[str, Any]:
    if model is not None:
        f = dict(DEFAULT_FILTERS)
        f.update(model.model_dump())
        return f
    f = dict(DEFAULT_FILTERS)
    f["exclude_shorts"] = bool(legacy_shorts)
    f["exclude_lives"] = bool(legacy_lives)
    return f


def _watch_public(watch: dict[str, Any]) -> dict[str, Any]:
    return {**watch, "filters": ytsrc.watch_filters(watch), "last_check": watch.get("last_check")}


@router.get("/api/watches")
async def get_watches() -> JSONResponse:
    return JSONResponse([_watch_public(w) for w in store.list_watches()])


@router.post("/api/watches")
async def add_watch(req: WatchRequest) -> JSONResponse:
    url = req.url.strip()
    if not url:
        return JSONResponse({"error": "URL is required"}, status_code=400)
    if any(w.get("url", "").strip() == url for w in store.list_watches()):
        return JSONResponse({"error": "Déjà abonné à cette chaîne"}, status_code=409)
    filters = _filters_from_request(req.filters, req.exclude_shorts, req.exclude_lives)
    watch = store.add_watch(
        req.url.strip(),
        req.quality or None,
        req.backfill,
        req.subfolder.strip(),
        req.date_after.strip(),
        req.title.strip(),
        req.thumbnail.strip(),
        filters["exclude_shorts"],
        filters["exclude_lives"],
        filters=filters,
    )
    threading.Thread(target=watches.run_check, args=(watch,), daemon=True).start()
    return JSONResponse(_watch_public(watch))


@router.post("/api/watches/preview-filters")
async def preview_filters(req: PreviewFiltersRequest) -> JSONResponse:
    """Dry-run the filters against a channel/playlist's ~30 most recent videos."""
    url = req.url.strip()
    if not url:
        return JSONResponse({"error": "URL requise"}, status_code=400)
    f = dict(DEFAULT_FILTERS)
    f.update(req.filters.model_dump())
    log: list[str] = []
    entries: list[dict[str, Any]] = []
    seen: set[str] = set()
    for src in ytsrc._watch_sources(url, exclude_shorts=False):
        for e in ytsrc._flat_list(src, log):
            if e.get("id") and e["id"] not in seen:
                seen.add(e["id"])
                entries.append(e)
            if len(entries) >= 30:
                break
        if len(entries) >= 30:
            break
    entries = entries[:30]
    kept = 0
    rejections: list[dict[str, str]] = []
    for e in entries:
        ok, reason = ytsrc.passes_filters(e, f)
        if ok:
            kept += 1
        elif len(rejections) < 5:
            rejections.append({"title": e.get("title") or e.get("id") or "", "reason": reason})
    return JSONResponse(
        {"listed": len(entries), "kept": kept, "rejected": len(entries) - kept, "rejections": rejections}
    )


@router.delete("/api/watches/{watch_id}")
async def delete_watch(watch_id: str) -> JSONResponse:
    store.delete_watch_videos(watch_id)
    return JSONResponse({"removed": store.remove_watch(watch_id)})


@router.get("/api/watches/{watch_id}/videos")
async def watch_videos(watch_id: str) -> JSONResponse:
    watch = store.get_watch(watch_id)
    if watch is None:
        return JSONResponse({"error": "Unknown watch"}, status_code=404)
    videos = store.load_watch_videos(watch_id)
    return JSONResponse(
        {
            "synced": sum(1 for v in videos if v.get("synced")),
            "total": len(videos),
            "videos": videos,
        }
    )


@router.post("/api/watches/{watch_id}/check")
async def check_watch_now(watch_id: str) -> JSONResponse:
    for watch in store.list_watches():
        if watch["id"] == watch_id:
            threading.Thread(target=watches.run_check, args=(watch,), daemon=True).start()
            return JSONResponse({"status": "checking"})
    return JSONResponse({"error": "Unknown watch"}, status_code=404)


@router.patch("/api/watches/{watch_id}")
async def update_watch(watch_id: str, req: WatchUpdate) -> JSONResponse:
    fields: dict[str, Any] = {}
    if req.enabled is not None:
        fields["enabled"] = req.enabled
    if req.quality is not None:
        fields["quality"] = req.quality or None
    if req.subfolder is not None:
        fields["subfolder"] = req.subfolder.strip()
    if req.date_after is not None:
        fields["date_after"] = req.date_after.strip()
    if req.exclude_shorts is not None:
        fields["exclude_shorts"] = req.exclude_shorts
    if req.exclude_lives is not None:
        fields["exclude_lives"] = req.exclude_lives
    if req.filters is not None:
        f = dict(DEFAULT_FILTERS)
        f.update(req.filters.model_dump())
        fields["filters"] = f
        fields["exclude_shorts"] = f["exclude_shorts"]
        fields["exclude_lives"] = f["exclude_lives"]
    watch = store.update_watch(watch_id, **fields)
    if watch is None:
        return JSONResponse({"error": "Unknown watch"}, status_code=404)
    return JSONResponse(_watch_public(watch))


@router.get("/api/youtube/subscriptions")
async def list_subscriptions() -> JSONResponse:
    if not cookies.status()["present"]:
        return JSONResponse({"error": "Cookies YouTube requis (Réglages → Cookies)."}, status_code=400)
    log: list[str] = []
    channels = ytsrc.list_subscribed_channels(log)
    if not channels:
        return JSONResponse({"error": "Aucun abonnement trouvé — cookies expirés ?"}, status_code=400)
    followed = {w.get("url", "").strip() for w in store.list_watches()}
    return JSONResponse(
        {"channels": [{**c, "followed": c["url"].strip() in followed} for c in channels]}
    )


@router.post("/api/youtube/subscriptions/follow")
async def follow_subscriptions(req: FollowSubsRequest) -> JSONResponse:
    existing = {w.get("url", "").strip() for w in store.list_watches()}
    added = 0
    for ch in req.channels:
        url = (ch.url or "").strip()
        if not url or url in existing:
            continue
        store.add_watch(url, None, req.backfill, "", "", (ch.title or url).strip(), ch.avatar or "")
        existing.add(url)
        added += 1
    return JSONResponse({"added": added})
