"""Builtin OutputPlugin: prepare the audio rendition for podcast-enabled
subscriptions, so each feed serves ready files (never transcoded on demand).

Best-effort: an extraction failure is logged to pipeline_runs and never blocks a
download. The actual feed routes live in app/routes/feeds.py.
"""

from __future__ import annotations

import threading
import time
from typing import Any

from ... import db
from ..base import (
    DownloadResult,
    OutputPlugin,
    PluginAction,
    PluginContext,
    PluginManifest,
    SettingField,
)


class PodcastOutput(OutputPlugin):
    MANIFEST = PluginManifest(
        id="podcast",
        name="Flux podcast (RSS)",
        version="1.0.0",
        type="output",
        description="Prépare une version audio des abonnements marqués « Flux podcast » pour les apps de podcast.",
        settings_schema=[
            SettingField(
                key="enabled", type="bool", label="Activer les flux podcast",
                help="Prépare l'audio des abonnements dont le flux podcast est activé.",
                default=False,
            ),
            SettingField(
                key="audio_format", type="select", label="Format audio",
                help="m4a/AAC : compatible partout. opus : plus léger, moins universel.",
                default="m4a", options=["m4a", "opus"],
            ),
            SettingField(
                key="bitrate", type="select", label="Débit audio",
                help="96k suffit pour de la parole ; 128k pour de la musique.",
                default="96k", options=["64k", "96k", "128k"],
            ),
        ],
        actions=[
            PluginAction(
                id="backfill", kind="backfill", confirm=True,
                label="Préparer l'audio des épisodes existants",
            ),
        ],
    )

    def on_content_ready(self, result: DownloadResult, ctx: PluginContext) -> None:
        if not ctx.settings.get("enabled"):
            return
        from ... import podcast, store
        for item in getattr(result, "items", None) or []:
            if not item.filepath:
                continue
            row = db.content_by_filepath(item.filepath)
            if not row:
                continue
            watch = store.get_watch(row.get("watch_id") or "") or {}
            if not watch.get("podcast_feed"):
                continue
            t0 = time.time()
            try:
                podcast.prepare_audio(row["id"])
                db.record_pipeline_run(result.job_id, "podcast", "audio", "ok", time.time() - t0)
                result.reports.append(
                    {"plugin": "podcast", "label": "Podcast", "ok": True, "detail": "audio prêt"}
                )
            except Exception as exc:  # noqa: BLE001 — never blocks the download
                db.record_pipeline_run(result.job_id, "podcast", "audio", "error", time.time() - t0, str(exc))
                result.reports.append(
                    {"plugin": "podcast", "label": "Podcast", "ok": False, "detail": str(exc)[:120]}
                )

    def action(self, name: str, payload: dict[str, Any], ctx: PluginContext):
        if name == "backfill":
            from ... import podcast
            job_id = podcast.backfill(None)
            return {"job_id": job_id, "status": "started"}, 200
        return {"error": f"Action inconnue : {name}"}, 400
