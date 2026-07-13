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
        description="Transcrit chaque contenu (local par défaut, moteur Cloud en option) : sous-titres .srt/.vtt et transcript horodaté cherchable.",
        settings_schema=[
            # --- Engine selector (local by default; cloud is opt-in) ---
            SettingField(
                key="engine", type="select", label="Moteur",
                help="Local (par défaut) : 100 % sur votre machine. Cloud : envoie l'AUDIO à un fournisseur (rapide sur NAS/CPU modeste).",
                default="local", options=["local", "cloud"],
            ),
            # --- Cloud engine (OpenAI-compatible /audio/transcriptions) ---
            SettingField(
                key="cloud_preset", type="select", label="Fournisseur cloud",
                help="Préremplit l'URL et un modèle. « custom » = tout éditable.",
                default="groq", options=["openai", "groq", "mistral", "custom"],
            ),
            SettingField(
                key="cloud_base_url", type="str", label="URL de base (cloud)",
                help="Endpoint compatible OpenAI (ex. https://api.groq.com/openai/v1).",
                default="https://api.groq.com/openai/v1",
            ),
            SettingField(
                key="cloud_model", type="str", label="Modèle (cloud)",
                help="ex. whisper-large-v3-turbo (Groq), whisper-1 (OpenAI), voxtral-mini-latest (Mistral).",
                default="whisper-large-v3-turbo",
            ),
            SettingField(
                key="cloud_api_key", type="str", label="Clé API (cloud)", secret=True,
                help="⚠️ En mode Cloud, l'audio de vos contenus est envoyé au fournisseur choisi pour être transcrit. Stockée localement, jamais renvoyée par l'API.",
                default="",
            ),
            SettingField(
                key="model", type="select", label="Modèle (local)",
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
                id="test_cloud", kind="test",
                label="Tester la connexion cloud",
            ),
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
        if name == "test_cloud":
            # ctx.settings already carries the form's current (possibly unsaved)
            # values merged over the stored ones (see registry.run_action), so it
            # includes the cloud URL/model/key to test against.
            from ... import cloud_stt
            ok, message = cloud_stt.test_connection(dict(ctx.settings or {}))
            return {"ok": ok, "message": message}, 200
        return {"error": f"Action inconnue : {name}"}, 400
