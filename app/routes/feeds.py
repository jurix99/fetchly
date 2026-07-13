"""Podcast feed routes.

Public (token-gated): the RSS XML and the prepared audio media (served with HTTP
Range — required by podcast apps — and NEVER transcoded on demand). Management
(/api/feeds/*): config, token regeneration, per-watch status, backfill.

All public URLs are absolute via public_base_url; without it the routes 409 with
a clear message. The token is compared in constant time and never logged.
"""

from __future__ import annotations

import hmac
import mimetypes
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from .. import db, library, podcast, store
from ..plugins.registry import registry
from ..runtime import DOWNLOAD_DIR
from ..schemas import FeedsBackfillRequest, FeedsConfigRequest

router = APIRouter()

_CHUNK = 256 * 1024


def _valid_token(token: str) -> bool:
    expected = store.feeds_token()
    return bool(token) and hmac.compare_digest(token, expected)


# --- public feeds ----------------------------------------------------------
@router.get("/feeds/{feed_id}.xml")
async def feed(feed_id: str, token: str = "") -> Response:
    if not _valid_token(token):
        return JSONResponse({"error": "Jeton invalide"}, status_code=401)
    base = store.public_base_url()
    if not base:
        return JSONResponse(
            {"error": "URL publique non configurée (Réglages → Digest / Flux podcast)."},
            status_code=409,
        )
    xml = podcast.build_feed(feed_id, base, store.feeds_token())
    if xml is None:
        return JSONResponse({"error": "Abonnement inconnu"}, status_code=404)
    return Response(content=xml, media_type="application/rss+xml; charset=utf-8")


@router.get("/feeds/media/{content_id}.{ext}")
async def feed_media(content_id: str, ext: str, request: Request, token: str = ""):
    if not _valid_token(token):
        return JSONResponse({"error": "Jeton invalide"}, status_code=401)
    content = db.content_get(content_id)
    if not content:
        return JSONResponse({"error": "Contenu inconnu"}, status_code=404)
    audio_path = content.get("audio_path")
    # No on-demand transcoding: if the audio isn't prepared, it isn't in the feed.
    if not audio_path:
        return JSONResponse({"error": "Audio non préparé"}, status_code=404)
    path = Path(audio_path)
    if not library.is_within(path, DOWNLOAD_DIR) or not path.is_file():
        return JSONResponse({"error": "Fichier introuvable"}, status_code=404)

    file_size = path.stat().st_size
    ctype = mimetypes.guess_type(str(path))[0] or "audio/mpeg"
    rng = library.parse_byte_range(request.headers.get("range"), file_size)
    if rng:
        start, end = rng
        length = end - start + 1

        def iter_range():
            with open(path, "rb") as f:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = f.read(min(_CHUNK, remaining))
                    if not chunk:
                        break
                    remaining -= len(chunk)
                    yield chunk

        return StreamingResponse(
            iter_range(), status_code=206,
            headers={
                "Content-Range": f"bytes {start}-{end}/{file_size}",
                "Accept-Ranges": "bytes",
                "Content-Length": str(length),
                "Content-Type": ctype,
            },
        )

    def iter_full():
        with open(path, "rb") as f:
            while True:
                chunk = f.read(_CHUNK)
                if not chunk:
                    break
                yield chunk

    return StreamingResponse(
        iter_full(),
        headers={"Content-Length": str(file_size), "Accept-Ranges": "bytes", "Content-Type": ctype},
    )


# --- management API --------------------------------------------------------
def _config_payload() -> dict:
    s = registry.settings_of("podcast")
    base = store.public_base_url()
    return {
        "enabled": bool(s.get("enabled")),
        "audio_format": s.get("audio_format", "m4a"),
        "bitrate": s.get("bitrate", "96k"),
        "token": store.feeds_token(),
        "public_base_url": base,
        "all_feed_url": f"{base.rstrip('/')}/feeds/all.xml?token={store.feeds_token()}" if base else "",
        "stats": podcast.stats(),
    }


@router.get("/api/feeds/config")
async def get_config() -> JSONResponse:
    return JSONResponse(_config_payload())


@router.post("/api/feeds/config")
async def save_config(req: FeedsConfigRequest) -> JSONResponse:
    patch = {k: v for k, v in req.model_dump().items() if v is not None}
    if patch:
        registry.update_settings("podcast", patch)
    return JSONResponse(_config_payload())


@router.post("/api/feeds/token/regenerate")
async def regenerate_token() -> JSONResponse:
    return JSONResponse({"token": store.regenerate_feeds_token()})


@router.get("/api/feeds/watch/{watch_id}")
async def watch_feed_status(watch_id: str) -> JSONResponse:
    watch = store.get_watch(watch_id)
    if not watch:
        return JSONResponse({"error": "Abonnement inconnu"}, status_code=404)
    base = store.public_base_url()
    token = store.feeds_token()
    return JSONResponse({
        "watch_id": watch_id,
        "podcast_feed": bool(watch.get("podcast_feed")),
        "has_base": bool(base),
        "url": f"{base.rstrip('/')}/feeds/{watch_id}.xml?token={token}" if base else "",
        "episodes_ready": len(db.podcast_items([watch_id], 1000)),
        "missing_count": db.podcast_missing_count(watch_id),
    })


@router.post("/api/feeds/backfill")
async def backfill(req: FeedsBackfillRequest) -> JSONResponse:
    if not registry.settings_of("podcast").get("enabled"):
        return JSONResponse({"error": "Activez d'abord les flux podcast."}, status_code=409)
    return JSONResponse({"job_id": podcast.backfill(req.watch_id)})
