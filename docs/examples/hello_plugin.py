"""Example ProcessorPlugin: writes a small .txt sidecar next to each download.

Drop this file into /config/plugins/ (the folder Fetchly watches for user
plugins). It appears in Réglages → Plugins, can be enabled/disabled live, and on
the next download writes "<video>.hello.txt" beside the media file.

This is the minimal complete plugin: a MANIFEST (with a settings_schema that
drives the UI) + one hook. See docs/PLUGINS.md for the full reference.
"""

from __future__ import annotations

from pathlib import Path

from app.plugins.base import (
    DownloadResult,
    PluginContext,
    PluginManifest,
    ProcessorPlugin,
    SettingField,
)


class HelloProcessor(ProcessorPlugin):
    MANIFEST = PluginManifest(
        id="hello",
        name="Hello sidecar",
        version="1.0.0",
        type="processor",
        description="Écrit un fichier .txt à côté de chaque vidéo téléchargée (exemple).",
        settings_schema=[
            SettingField(key="enabled_note", type="bool", label="Inclure une note",
                         help="Ajoute une ligne de note dans le sidecar.", default=True),
            SettingField(key="greeting", type="str", label="Message",
                         help="Texte écrit en tête du fichier.", default="Bonjour depuis Fetchly !"),
            SettingField(key="repeat", type="int", label="Répétitions",
                         help="Combien de fois répéter le message.", default=1),
            SettingField(key="extension", type="select", label="Extension du sidecar",
                         help="Extension du fichier généré.", default="hello.txt",
                         options=["hello.txt", "note.txt", "info.txt"]),
        ],
    )

    def on_content_downloaded(self, result: DownloadResult, ctx: PluginContext) -> DownloadResult:
        greeting = ctx.settings.get("greeting", "Bonjour depuis Fetchly !")
        repeat = max(1, int(ctx.settings.get("repeat", 1) or 1))
        ext = ctx.settings.get("extension", "hello.txt")
        note = ctx.settings.get("enabled_note", True)

        for filepath in result.filepaths:
            media = Path(filepath)
            sidecar = media.with_suffix("." + ext)
            lines = [greeting] * repeat
            if note:
                lines.append(f"(sidecar généré pour : {media.name})")
            try:
                sidecar.write_text("\n".join(lines) + "\n", encoding="utf-8")
                result.sidecars["hello"] = str(sidecar)
                ctx.emit_event("hello.sidecar_written", {"path": str(sidecar)})
            except OSError as exc:
                ctx.logger.warning("hello: could not write sidecar: %s", exc)
        return result
