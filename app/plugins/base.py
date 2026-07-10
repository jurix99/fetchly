"""Plugin contracts and the dataclasses exchanged along the pipeline.

Three plugin kinds:
  - SourcePlugin    : extracts metadata and downloads media (e.g. yt-dlp).
  - ProcessorPlugin : enriches a finished download (adds sidecars).
  - OutputPlugin    : publishes a ready item to an external system.

A plugin declares a `MANIFEST` (id/name/version/type + a settings_schema that
drives the UI). See docs/PLUGINS.md for a complete example.
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

# --- Exchange dataclasses --------------------------------------------------


@dataclass
class MediaItem:
    """A single piece of media, source-agnostic."""
    id: str
    source: str
    url: str
    title: str = ""
    duration: float | None = None
    uploaded_at: str = ""  # "YYYYMMDD" as yt-dlp reports it
    is_short: bool = False
    is_live: bool = False
    thumbnail: str = ""
    description: str = ""
    channel: str = ""
    channel_url: str = ""
    filepath: str = ""  # where this item's media landed (per-file items)
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class DownloadResult:
    """The outcome of downloading one job: the files on disk + rich per-file
    items, plus any sidecars processors add and per-plugin `reports` surfaced on
    the download card. `item` is the primary/summary item (single-video jobs)."""
    item: MediaItem | None
    filepaths: list[str] = field(default_factory=list)
    sidecars: dict[str, str] = field(default_factory=dict)
    items: list[MediaItem] = field(default_factory=list)
    job_id: str = ""
    reports: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class PluginContext:
    """Everything a plugin is handed at runtime. `emit_event` lets a plugin push
    a named event onto the pipeline log; `config_dir` is a private per-plugin
    directory under /config it may read/write."""
    settings: dict[str, Any]
    logger: logging.Logger
    db: Any
    config_dir: Path
    emit_event: Callable[[str, dict[str, Any]], None]


# --- Manifest / settings schema (drives the UI) ----------------------------

# Field types the settings UI knows how to render.
FIELD_TYPES = ("bool", "str", "int", "select")


@dataclass
class SettingField:
    key: str
    type: str  # one of FIELD_TYPES
    label: str  # FR label shown in the UI
    help: str = ""
    default: Any = None
    options: list[str] | None = None  # for type == "select"
    secret: bool = False  # render as a password input (token/API key)

    def to_dict(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "type": self.type,
            "label": self.label,
            "help": self.help,
            "default": self.default,
            "options": self.options,
            "secret": self.secret,
        }


@dataclass
class PluginAction:
    """A button the UI renders in a plugin's settings panel, calling
    POST /api/plugins/<id>/actions/<id>. `kind` lets the UI specialise the
    interaction (a "test" shows an inline result; others may confirm first)."""
    id: str
    label: str
    kind: str = "generic"  # generic | test | backfill
    confirm: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "label": self.label, "kind": self.kind, "confirm": self.confirm}


@dataclass
class PluginManifest:
    id: str
    name: str
    version: str
    type: str  # source | processor | output
    description: str = ""
    settings_schema: list[SettingField] = field(default_factory=list)
    # Critical builtins (the yt-dlp source) cannot be disabled from the UI.
    critical: bool = False
    # Buttons shown in the settings panel (test connection, backfill…).
    actions: list["PluginAction"] = field(default_factory=list)

    def defaults(self) -> dict[str, Any]:
        return {f.key: f.default for f in self.settings_schema}

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "version": self.version,
            "type": self.type,
            "description": self.description,
            "critical": self.critical,
            "settings_schema": [f.to_dict() for f in self.settings_schema],
            "actions": [a.to_dict() for a in self.actions],
        }


# --- Plugin base classes ---------------------------------------------------


class Plugin(ABC):
    """Base for all plugins. Subclasses set a class attribute `MANIFEST`."""

    MANIFEST: PluginManifest

    def setup(self, ctx: PluginContext) -> None:
        """Called once when the plugin is loaded/enabled. Optional."""
        self.ctx = ctx

    def action(self, name: str, payload: dict[str, Any], ctx: PluginContext):
        """Handle a UI-triggered action (see MANIFEST.actions). Returns
        (body_dict, http_status). Default: unknown action."""
        return {"error": f"Action inconnue : {name}"}, 400


class SourcePlugin(Plugin):
    """Extracts and downloads media from some source (a site, a service…)."""

    @abstractmethod
    def capabilities(self) -> dict[str, Any]:
        """Declare what this source supports (search, channels, watches…)."""

    @abstractmethod
    def can_handle(self, url: str) -> bool:
        """Whether this source recognises `url`. The registry resolves the
        highest-priority source whose can_handle() returns True."""

    @abstractmethod
    def extract(self, url: str) -> MediaItem | list[MediaItem]:
        """Metadata only (no download) for a URL."""

    @abstractmethod
    def list_new(self, watch: dict[str, Any]) -> list[MediaItem]:
        """New (not-yet-downloaded) items for a subscription/watch, filtered."""

    @abstractmethod
    def download(self, job: Any, hooks: dict[str, Callable]) -> DownloadResult:
        """Download the job's target(s). `job` carries the request + mutable
        progress fields; `hooks` provides at least `on_progress(job)`. Interrupts
        are signalled via job.pause_event / job.cancel_event."""


class ProcessorPlugin(Plugin):
    """Enriches a finished download in place (adds sidecars, metadata…)."""

    @abstractmethod
    def on_content_downloaded(self, result: DownloadResult, ctx: PluginContext) -> DownloadResult:
        ...


class OutputPlugin(Plugin):
    """Publishes a ready item to an external system (library, webhook…)."""

    @abstractmethod
    def on_content_ready(self, result: DownloadResult, ctx: PluginContext) -> None:
        ...
