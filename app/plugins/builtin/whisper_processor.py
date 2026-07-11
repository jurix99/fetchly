"""Builtin ProcessorPlugin: local transcription via faster-whisper.

On each download it enqueues the content into the dedicated transcription queue
(app/transcribe.py) — which runs entirely off the download path, so a slow or
failing transcription never blocks a download or the pipeline.
"""

from __future__ import annotations

from typing import Any

from ... import db
from ..base import (
    DownloadResult,
    PluginAction,
    PluginContext,
    PluginManifest,
    ProcessorPlugin,
    SettingField,
)

_LANGS = ["auto", "fr", "en", "es", "de", "it", "pt", "nl", "ru", "ja", "ko", "zh", "ar"]


class WhisperProcessor(ProcessorPlugin):
    MANIFEST = PluginManifest(
        id="whisper",
        name="Transcription (Whisper)",
        version="1.0.0",
        type="processor",
        description="Transcrit chaque contenu localement (faster-whisper) : sous-titres .srt/.vtt et transcript horodaté cherchable.",
        settings_schema=[
            SettingField(
                key="model", type="select", label="Modèle",
                help="tiny/base = rapides, moins précis · small = équilibré (~480 Mo) · medium/large-v3 = précis mais lents et lourds.",
                default="small", options=["tiny", "base", "small", "medium", "large-v3"],
            ),
            SettingField(
                key="language", type="select", label="Langue",
                help="« auto » détecte la langue par contenu.", default="auto", options=_LANGS,
            ),
            SettingField(
                key="compute", type="select", label="Matériel",
                help="auto : GPU si disponible, sinon CPU (int8).", default="auto",
                options=["auto", "cpu", "gpu"],
            ),
            SettingField(
                key="vad_filter", type="bool", label="Filtre de silences (VAD)",
                help="Ignore les silences — plus rapide et plus propre.", default=True,
            ),
            SettingField(
                key="schedule", type="select", label="Cadence",
                help="Transcrire en continu, ou seulement pendant une fenêtre nocturne.",
                default="en continu", options=["en continu", "fenêtre nocturne"],
            ),
            SettingField(
                key="night_window", type="str", label="Fenêtre nocturne",
                help="Plage horaire (HH:MM-HH:MM) si cadence nocturne.", default="22:00-07:00",
            ),
            SettingField(
                key="max_concurrent", type="int", label="Transcriptions simultanées",
                help="Gardé à 1 pour préserver la RAM (un seul modèle chargé).", default=1,
            ),
            SettingField(
                key="skip_if_captions", type="bool", label="Ignorer si sous-titres source",
                help="Si des .srt/.vtt existent déjà à côté du média, marquer « ignoré » au lieu de transcrire.",
                default=False,
            ),
        ],
        actions=[
            PluginAction(
                id="backfill", kind="backfill", confirm=True,
                label="Transcrire toute la bibliothèque",
            ),
        ],
    )

    def on_content_downloaded(self, result: DownloadResult, ctx: PluginContext) -> DownloadResult:
        from ... import transcribe
        for item in getattr(result, "items", None) or []:
            if not item.filepath:
                continue
            row = db.content_by_filepath(item.filepath)
            if row:
                transcribe.enqueue(row["id"], row.get("title"))
        return result

    def action(self, name: str, payload: dict[str, Any], ctx: PluginContext):
        from ... import transcribe
        if name == "backfill":
            n = transcribe.backfill(only_missing=bool(payload.get("only_missing", True)))
            return {"queued": n, "status": "started"}, 200
        return {"error": f"Action inconnue : {name}"}, 400
