"""Plugin management routes: list, enable/disable, update settings."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..plugins.registry import registry
from ..schemas import PluginSettingsRequest

router = APIRouter()


@router.get("/api/plugins")
async def list_plugins() -> JSONResponse:
    # Re-discover on read so a plugin dropped into /config/plugins shows up
    # without a restart (and a fixed one clears its error).
    registry.discover()
    return JSONResponse(registry.public_list())


@router.post("/api/plugins/{plugin_id}/enable")
async def enable_plugin(plugin_id: str) -> JSONResponse:
    lp = registry.get(plugin_id)
    if not lp:
        return JSONResponse({"error": "Unknown plugin"}, status_code=404)
    if not registry.enable(plugin_id, True):
        return JSONResponse({"error": "Ce plugin ne peut pas être activé."}, status_code=409)
    return JSONResponse({"id": plugin_id, "enabled": True})


@router.post("/api/plugins/{plugin_id}/disable")
async def disable_plugin(plugin_id: str) -> JSONResponse:
    lp = registry.get(plugin_id)
    if not lp:
        return JSONResponse({"error": "Unknown plugin"}, status_code=404)
    if lp.critical:
        return JSONResponse(
            {"error": "Ce plugin est essentiel et ne peut pas être désactivé."}, status_code=409
        )
    if not registry.enable(plugin_id, False):
        return JSONResponse({"error": "Impossible de désactiver ce plugin."}, status_code=409)
    return JSONResponse({"id": plugin_id, "enabled": False})


@router.post("/api/plugins/{plugin_id}/actions/{action}")
async def run_plugin_action(plugin_id: str, action: str, request: Request) -> JSONResponse:
    payload: dict[str, Any] = {}
    try:
        payload = await request.json()
    except Exception:  # noqa: BLE001 — empty/invalid body is fine
        payload = {}
    body, code = registry.run_action(plugin_id, action, payload)
    return JSONResponse(body, status_code=code)


@router.patch("/api/plugins/{plugin_id}/settings")
async def update_plugin_settings(plugin_id: str, req: PluginSettingsRequest) -> JSONResponse:
    lp = registry.get(plugin_id)
    if not lp:
        return JSONResponse({"error": "Unknown plugin"}, status_code=404)
    settings = registry.update_settings(plugin_id, req.settings or {})
    if settings is None:
        return JSONResponse({"error": "Réglages invalides."}, status_code=400)
    return JSONResponse({"id": plugin_id, "settings": settings})
