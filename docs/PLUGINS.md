# Fetchly Plugins

Fetchly is built around a small plugin system so features (transcription,
summaries, library integrations…) plug into the download pipeline without
touching the core. YouTube/yt-dlp is itself the first plugin (a **source**).

> **Trust model (v1):** plugins run **in-process, with no sandbox**. Only drop
> code you trust into `/config/plugins`. There is no remote/marketplace install.

---

## The three kinds of plugin

| Kind | Contract | Role |
| --- | --- | --- |
| **SourcePlugin** | `capabilities`, `can_handle`, `extract`, `list_new`, `download` | Extract metadata and download media. |
| **ProcessorPlugin** | `on_content_downloaded(result, ctx) -> result` | Enrich a finished download (add sidecars, metadata). |
| **OutputPlugin** | `on_content_ready(result, ctx) -> None` | Publish a ready item to an external system. |

All contracts live in [`app/plugins/base.py`](../app/plugins/base.py).

### Exchange objects

- **`MediaItem`** — `id, source, url, title, duration, uploaded_at, is_short, is_live, thumbnail, extra`.
- **`DownloadResult`** — `item`, `filepaths: list[str]`, `sidecars: dict[str, str]`.
- **`PluginContext`** — `settings`, `logger`, `db`, `config_dir` (a private
  `/config/plugin-data/<id>` folder), `emit_event(name, payload)`.

### Manifest & settings schema (drives the UI)

Every plugin sets a class attribute `MANIFEST = PluginManifest(...)`:

```python
PluginManifest(
    id="hello", name="Hello sidecar", version="1.0.0", type="processor",
    description="…",
    settings_schema=[
        SettingField(key="greeting", type="str", label="Message", default="Salut", help="…"),
        SettingField(key="repeat",   type="int", label="Répétitions", default=1),
        SettingField(key="enabled_note", type="bool", label="Inclure une note", default=True),
        SettingField(key="extension", type="select", label="Extension",
                     default="hello.txt", options=["hello.txt", "note.txt"]),
    ],
)
```

`type` ∈ `bool | str | int | select`. The Réglages → **Plugins** tab renders each
field automatically (bool→switch, select→dropdown, str→input, int→number input)
with its label and help text. `critical=True` marks a builtin that cannot be
disabled (the yt-dlp source).

---

## Lifecycle

1. **Discovery** (startup): the registry loads builtin plugins
   (`app/plugins/builtin/*.py`) then user plugins (`/config/plugins/*.py`).
   A plugin that raises at import/instantiation is isolated: it is recorded as
   **failed** (shown with its error in the UI) and never blocks startup.
2. **Enable/disable & settings** are persisted in `config.json` under `plugins`.
   Toggling or editing settings takes effect **without a restart**.
3. **Resolution**: for a download, the registry returns the highest-priority
   enabled source whose `can_handle(url)` is true (builtins first).
4. **Pipeline** ([`app/pipeline.py`](../app/pipeline.py)): after a successful
   download,

   ```
   content_downloaded → each ProcessorPlugin (in order) → content_ready → each OutputPlugin
   ```

   Every step is timed and written to the `pipeline_runs` table
   (`job_id, plugin_id, stage, status, duration, error`). A processor/output
   that raises is logged and marked **partial** — it never fails the download.

---

## Writing your first plugin

A complete, minimal ProcessorPlugin that writes a `.txt` sidecar next to each
downloaded file lives at
[`docs/examples/hello_plugin.py`](examples/hello_plugin.py):

```python
from pathlib import Path
from app.plugins.base import (
    DownloadResult, PluginContext, PluginManifest, ProcessorPlugin, SettingField,
)

class HelloProcessor(ProcessorPlugin):
    MANIFEST = PluginManifest(
        id="hello", name="Hello sidecar", version="1.0.0", type="processor",
        description="Écrit un .txt à côté de chaque vidéo (exemple).",
        settings_schema=[
            SettingField(key="greeting", type="str", label="Message",
                         default="Bonjour depuis Fetchly !"),
        ],
    )

    def on_content_downloaded(self, result: DownloadResult, ctx: PluginContext) -> DownloadResult:
        for filepath in result.filepaths:
            sidecar = Path(filepath).with_suffix(".hello.txt")
            sidecar.write_text(ctx.settings.get("greeting", "") + "\n", encoding="utf-8")
            result.sidecars["hello"] = str(sidecar)
        return result
```

### Installing it

1. Copy the file into your host `./config/plugins/` folder (mounted at
   `/config/plugins` in the container). Create the folder if needed.
2. Open **Réglages → Plugins**: the plugin appears. Toggle it on.
3. Trigger a download — a `…​.hello.txt` file appears next to the video.
4. Toggle it off any time (no restart).

A file that fails to import (e.g. a `SyntaxError`) still shows up in the tab
with a red **error** badge and the traceback, and the rest of the app keeps
working.

---

## Notes & limits (v1)

- No sandboxing: user plugins run with the app's privileges.
- No remote install / marketplace.
- No external queue or microservices — the pipeline is a simple in-process,
  sequential bus.
- One source (yt-dlp) ships builtin; the abstraction is ready for more.
