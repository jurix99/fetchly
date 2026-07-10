"""Plugin discovery, lifecycle and persisted state.

Loads builtin plugins (app/plugins/builtin/*.py) and user plugins dropped in
/config/plugins/*.py. Each plugin is loaded in isolation: one that raises at
import/instantiation is recorded as `failed` and never blocks startup. Enabled
state and settings are persisted via `store` (config.json → "plugins").

v1 is a LOCAL-TRUST model: user plugins run in-process with no sandbox. Only
drop code you trust into /config/plugins (documented in docs/PLUGINS.md).
"""

from __future__ import annotations

import importlib
import importlib.util
import inspect
import logging
import pkgutil
import threading
import traceback
from pathlib import Path
from typing import Any

from .. import db, store
from ..runtime import DOWNLOAD_DIR  # noqa: F401  (kept for parity/imports elsewhere)
from . import base, builtin
from .base import (
    OutputPlugin,
    Plugin,
    PluginContext,
    ProcessorPlugin,
    SourcePlugin,
)

log = logging.getLogger("plugins")

_USER_DIR = store.CONFIG_DIR / "plugins"
_DATA_DIR = store.CONFIG_DIR / "plugin-data"


class LoadedPlugin:
    def __init__(self, manifest_id: str, name: str, ptype: str, version: str,
                 description: str, critical: bool, builtin_: bool):
        self.id = manifest_id
        self.name = name
        self.type = ptype
        self.version = version
        self.description = description
        self.critical = critical
        self.builtin = builtin_
        self.instance: Plugin | None = None
        self.manifest = None  # base.PluginManifest
        self.status = "loaded"  # loaded | failed | disabled
        self.error = ""


class Registry:
    def __init__(self) -> None:
        self._plugins: dict[str, LoadedPlugin] = {}
        self._lock = threading.Lock()

    # --- discovery ---------------------------------------------------------
    def discover(self) -> None:
        """(Re)load every builtin and user plugin. Safe to call at startup."""
        with self._lock:
            self._plugins.clear()
            for module_name in self._builtin_modules():
                self._load_module(module_name, builtin_=True)
            self._load_user_plugins()

    def _builtin_modules(self) -> list[str]:
        return [
            f"{builtin.__name__}.{m.name}"
            for m in pkgutil.iter_modules(builtin.__path__)
        ]

    def _load_user_plugins(self) -> None:
        try:
            _USER_DIR.mkdir(parents=True, exist_ok=True)
        except OSError:
            return
        for path in sorted(_USER_DIR.glob("*.py")):
            if path.name.startswith("_"):
                continue
            self._load_file(path)

    def _load_module(self, module_name: str, builtin_: bool) -> None:
        try:
            module = importlib.import_module(module_name)
            importlib.reload(module)
            self._register_from_module(module, module_name.rsplit(".", 1)[-1], builtin_)
        except Exception:  # noqa: BLE001 — isolate: a bad plugin must not crash boot
            self._register_failed(module_name.rsplit(".", 1)[-1], builtin_)

    def _load_file(self, path: Path) -> None:
        name = path.stem
        try:
            spec = importlib.util.spec_from_file_location(f"fetchly_user_plugin_{name}", path)
            module = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
            spec.loader.exec_module(module)  # type: ignore[union-attr]
            self._register_from_module(module, name, builtin_=False)
        except Exception:  # noqa: BLE001
            self._register_failed(name, builtin_=False, source=str(path))

    def _register_from_module(self, module: Any, fallback_id: str, builtin_: bool) -> None:
        found = False
        for _, obj in inspect.getmembers(module, inspect.isclass):
            if not issubclass(obj, Plugin) or obj in (Plugin, SourcePlugin, ProcessorPlugin, OutputPlugin):
                continue
            manifest = getattr(obj, "MANIFEST", None)
            if manifest is None:
                continue
            found = True
            self._instantiate(obj, manifest, builtin_)
        if not found:
            # A module without a valid plugin class is recorded as failed so the
            # user sees why nothing showed up.
            lp = LoadedPlugin(fallback_id, fallback_id, "unknown", "", "", False, builtin_)
            lp.status = "failed"
            lp.error = "Aucune classe de plugin avec MANIFEST trouvée."
            self._plugins[fallback_id] = lp

    def _instantiate(self, cls: type, manifest: Any, builtin_: bool) -> None:
        lp = LoadedPlugin(
            manifest.id, manifest.name, manifest.type, manifest.version,
            manifest.description, manifest.critical, builtin_,
        )
        lp.manifest = manifest
        try:
            instance = cls()
            instance.setup(self._context(manifest))
            lp.instance = instance
            state = store.get_plugin_state(manifest.id)
            enabled = state.get("enabled")
            # Critical plugins are always on; others default to enabled.
            lp.status = "loaded" if (manifest.critical or enabled is not False) else "disabled"
        except Exception:  # noqa: BLE001
            lp.status = "failed"
            lp.error = traceback.format_exc(limit=4)
        self._plugins[manifest.id] = lp

    def _register_failed(self, pid: str, builtin_: bool, source: str = "") -> None:
        lp = LoadedPlugin(pid, pid, "unknown", "", source, False, builtin_)
        lp.status = "failed"
        lp.error = traceback.format_exc(limit=6)
        self._plugins[pid] = lp

    def _context(self, manifest: Any) -> PluginContext:
        settings = {**manifest.defaults(), **(store.get_plugin_state(manifest.id).get("settings") or {})}
        cfg_dir = _DATA_DIR / manifest.id
        try:
            cfg_dir.mkdir(parents=True, exist_ok=True)
        except OSError:
            pass
        pid = manifest.id
        return PluginContext(
            settings=settings,
            logger=logging.getLogger(f"plugin.{pid}"),
            db=db,
            config_dir=cfg_dir,
            emit_event=lambda name, payload=None: log.info("[%s] %s %s", pid, name, payload or {}),
        )

    # --- state helpers -----------------------------------------------------
    def is_enabled(self, pid: str) -> bool:
        lp = self._plugins.get(pid)
        if not lp or lp.status == "failed" or lp.instance is None:
            return False
        if lp.critical:
            return True
        state = store.get_plugin_state(pid)
        return state.get("enabled", True) is not False

    def settings_of(self, pid: str) -> dict[str, Any]:
        lp = self._plugins.get(pid)
        if not lp or lp.manifest is None:
            return {}
        return {**lp.manifest.defaults(), **(store.get_plugin_state(pid).get("settings") or {})}

    def enable(self, pid: str, enabled: bool) -> bool:
        lp = self._plugins.get(pid)
        if not lp or lp.status == "failed":
            return False
        if lp.critical and not enabled:
            return False  # critical plugins can't be disabled
        store.set_plugin_state(pid, enabled=enabled)
        return True

    def update_settings(self, pid: str, settings: dict[str, Any]) -> dict[str, Any] | None:
        lp = self._plugins.get(pid)
        if not lp or lp.manifest is None:
            return None
        # Coerce/validate against the schema; ignore unknown keys.
        schema = {f.key: f for f in lp.manifest.settings_schema}
        clean: dict[str, Any] = {}
        for key, val in (settings or {}).items():
            field = schema.get(key)
            if field is None:
                continue
            clean[key] = _coerce(field, val)
        store.set_plugin_state(pid, settings=clean)
        # Refresh the live instance's context settings.
        if lp.instance is not None:
            try:
                lp.instance.setup(self._context(lp.manifest))
            except Exception:  # noqa: BLE001
                pass
        return self.settings_of(pid)

    # --- resolution --------------------------------------------------------
    def get_source(self, url: str) -> SourcePlugin | None:
        """The enabled source plugin that handles `url` (builtins first)."""
        candidates = [
            lp for lp in self._plugins.values()
            if lp.type == "source" and self.is_enabled(lp.id) and lp.instance is not None
        ]
        candidates.sort(key=lambda lp: (not lp.builtin, lp.id))
        for lp in candidates:
            try:
                if lp.instance.can_handle(url):  # type: ignore[union-attr]
                    return lp.instance  # type: ignore[return-value]
            except Exception:  # noqa: BLE001
                continue
        return None

    def default_source(self) -> SourcePlugin | None:
        for lp in sorted(self._plugins.values(), key=lambda lp: (not lp.builtin, lp.id)):
            if lp.type == "source" and self.is_enabled(lp.id) and lp.instance is not None:
                return lp.instance  # type: ignore[return-value]
        return None

    def processors(self) -> list[tuple[str, ProcessorPlugin, PluginContext]]:
        return self._enabled_of("processor")

    def outputs(self) -> list[tuple[str, OutputPlugin, PluginContext]]:
        return self._enabled_of("output")

    def _enabled_of(self, ptype: str) -> list[tuple[str, Any, PluginContext]]:
        out = []
        for lp in sorted(self._plugins.values(), key=lambda lp: (not lp.builtin, lp.id)):
            if lp.type == ptype and self.is_enabled(lp.id) and lp.instance is not None and lp.manifest:
                out.append((lp.id, lp.instance, self._context(lp.manifest)))
        return out

    # --- API view ----------------------------------------------------------
    def public_list(self) -> list[dict[str, Any]]:
        out = []
        for lp in sorted(self._plugins.values(), key=lambda lp: (lp.type, not lp.builtin, lp.id)):
            status = "error" if lp.status == "failed" else ("active" if self.is_enabled(lp.id) else "disabled")
            out.append(
                {
                    "id": lp.id,
                    "name": lp.name,
                    "type": lp.type,
                    "version": lp.version,
                    "description": lp.description,
                    "builtin": lp.builtin,
                    "critical": lp.critical,
                    "enabled": self.is_enabled(lp.id),
                    "status": status,
                    "error": lp.error,
                    "settings_schema": (
                        [f.to_dict() for f in lp.manifest.settings_schema] if lp.manifest else []
                    ),
                    "actions": (
                        [a.to_dict() for a in lp.manifest.actions] if lp.manifest else []
                    ),
                    "settings": self.settings_of(lp.id),
                }
            )
        return out

    def run_action(self, pid: str, action: str, payload: dict[str, Any] | None):
        """Invoke a plugin's UI action. Returns (body, http_status)."""
        lp = self._plugins.get(pid)
        if not lp or lp.instance is None or lp.status == "failed" or lp.manifest is None:
            return {"error": "Unknown plugin"}, 404
        ctx = self._context(lp.manifest)
        # Let the action run against the form's current (possibly unsaved) values.
        override = (payload or {}).get("settings")
        if isinstance(override, dict):
            ctx.settings = {**ctx.settings, **override}
        try:
            return lp.instance.action(action, payload or {}, ctx)
        except Exception as exc:  # noqa: BLE001
            return {"error": str(exc)}, 500

    def get(self, pid: str) -> LoadedPlugin | None:
        return self._plugins.get(pid)


def _coerce(field: base.SettingField, value: Any) -> Any:
    try:
        if field.type == "bool":
            return bool(value)
        if field.type == "int":
            return int(value)
        if field.type == "select":
            return value if (not field.options or value in field.options) else field.default
        return str(value)
    except (TypeError, ValueError):
        return field.default


# Module-level singleton.
registry = Registry()
