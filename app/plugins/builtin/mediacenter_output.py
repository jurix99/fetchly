"""Builtin OutputPlugin: media-center integration (Jellyfin / Plex).

Two independent jobs, both best-effort (never fail or block a download):
  1. NFO generation — Kodi/Jellyfin `episodedetails` per video + a per-channel
     `tvshow.nfo` with poster.jpg and per-video `-thumb.jpg`, so each channel
     shows up as a clean "series" with artwork.
  2. Scan notification — tells Jellyfin/Plex to rescan, DEBOUNCED (60 s) so a
     burst of downloads triggers a single refresh instead of hammering.

HTTP uses stdlib urllib (no new dependency). XML via xml.etree. Errors are
logged to pipeline_runs; the download always succeeds regardless.
"""

from __future__ import annotations

import os
import re
import shutil
import threading
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote

from ... import db
from ...runtime import DOWNLOAD_DIR, MEDIA_EXTS
from ..base import (
    DownloadResult,
    MediaItem,
    OutputPlugin,
    PluginAction,
    PluginContext,
    PluginManifest,
    SettingField,
)

# Debounce window for scan notifications (seconds). Overridable for tests.
_DEBOUNCE_SECONDS = float(os.environ.get("MEDIACENTER_DEBOUNCE", "60"))
_ID_RE = re.compile(r"\[([A-Za-z0-9_-]{6,})\]\s*$")


# --- NFO / artwork ---------------------------------------------------------
def _iso_date(yyyymmdd: str) -> str:
    s = str(yyyymmdd or "")
    return f"{s[0:4]}-{s[4:6]}-{s[6:8]}" if len(s) == 8 and s.isdigit() else ""


def _write_xml(path: Path, root: ET.Element) -> None:
    """Atomic, idempotent XML write (re-generation overwrites cleanly)."""
    try:
        ET.indent(root)  # py3.9+: pretty output
    except Exception:  # noqa: BLE001
        pass
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(ET.tostring(root, encoding="utf-8", xml_declaration=True))
    tmp.replace(path)


def _episode_root(title: str, plot: str, aired: str, runtime_min: str,
                  studio: str, source: str, uid: str, thumb_url: str) -> ET.Element:
    root = ET.Element("episodedetails")
    ET.SubElement(root, "title").text = title or "Sans titre"
    if plot:
        ET.SubElement(root, "plot").text = plot
    if aired:
        ET.SubElement(root, "aired").text = aired
        ET.SubElement(root, "premiered").text = aired
        ET.SubElement(root, "year").text = aired[:4]
    if runtime_min:
        ET.SubElement(root, "runtime").text = runtime_min
    if studio:
        ET.SubElement(root, "studio").text = studio
    if thumb_url:
        thumb = ET.SubElement(root, "thumb")
        thumb.text = thumb_url
    if uid:
        el = ET.SubElement(root, "uniqueid")
        el.set("type", source or "youtube")
        el.set("default", "true")
        el.text = uid
    ET.SubElement(root, "dateadded").text = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    return root


def _tvshow_root(title: str, plot: str) -> ET.Element:
    root = ET.Element("tvshow")
    ET.SubElement(root, "title").text = title or "Chaîne"
    if plot:
        ET.SubElement(root, "plot").text = plot
    return root


def _download_image(url: str, dest: Path) -> bool:
    if not url:
        return False
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Fetchly"})
        with urllib.request.urlopen(req, timeout=10) as r:
            data = r.read()
        if data:
            tmp = dest.with_suffix(dest.suffix + ".tmp")
            tmp.write_bytes(data)
            tmp.replace(dest)
            return True
    except Exception:  # noqa: BLE001
        pass
    return False


def _ensure_thumb(media: Path, thumb_url: str) -> None:
    """`<stem>-thumb.jpg` from the already-downloaded `<stem>.jpg` (no network),
    falling back to the thumbnail URL if that jpg is missing."""
    dest = media.with_name(media.stem + "-thumb.jpg")
    local = media.with_suffix(".jpg")
    try:
        if local.exists():
            shutil.copyfile(local, dest)
            return
    except OSError:
        pass
    _download_image(thumb_url, dest)


# --- Scan notification (debounced) -----------------------------------------
_refresh_lock = threading.Lock()
_refresh_timer: threading.Timer | None = None
_pending_settings: dict[str, Any] | None = None
_pending_jobs: set[str] = set()


def _refresh_jellyfin(base: str, token: str) -> tuple[bool, str]:
    url = base.rstrip("/") + "/Library/Refresh"
    req = urllib.request.Request(url, method="POST", headers={"X-Emby-Token": token})
    with urllib.request.urlopen(req, timeout=5) as r:
        return 200 <= r.status < 300, f"HTTP {r.status}"


def _refresh_plex(base: str, token: str, section: str) -> tuple[bool, str]:
    path = f"/library/sections/{section}/refresh" if section else "/library/sections/all/refresh"
    url = base.rstrip("/") + path + (f"?X-Plex-Token={quote(token)}" if token else "")
    with urllib.request.urlopen(url, timeout=5) as r:
        return 200 <= r.status < 300, f"HTTP {r.status}"


def _do_refresh(settings: dict[str, Any]) -> tuple[bool, str]:
    stype = settings.get("server_type") or "aucun"
    base = (settings.get("base_url") or "").strip()
    token = settings.get("api_key") or ""
    try:
        if stype == "jellyfin":
            return _refresh_jellyfin(base, token)
        if stype == "plex":
            return _refresh_plex(base, token, (settings.get("plex_section_id") or "").strip())
        return False, "aucun serveur configuré"
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}"
    except urllib.error.URLError as e:
        return False, f"connexion impossible ({e.reason})"
    except Exception as e:  # noqa: BLE001
        return False, str(e)


def _fire_refresh() -> None:
    global _refresh_timer
    with _refresh_lock:
        settings = _pending_settings
        jids = set(_pending_jobs)
        _pending_jobs.clear()
        _refresh_timer = None
    if not settings:
        return
    ok, detail = _do_refresh(settings)
    label = "Jellyfin" if settings.get("server_type") == "jellyfin" else "Plex"
    for jid in (jids or {""}):
        db.record_pipeline_run(jid, "mediacenter", "scan_refresh",
                               "ok" if ok else "error", 0.0, "" if ok else detail)
    # Reflect the async scan result on the contributing jobs' cards + logs.
    for jid in jids:
        _update_job_scan(jid, label, ok, detail)


def _schedule_refresh(settings: dict[str, Any], job_id: str) -> None:
    """Coalesce rapid downloads into a single refresh (timer re-armed each call)."""
    global _refresh_timer, _pending_settings
    with _refresh_lock:
        _pending_settings = settings
        if job_id:
            _pending_jobs.add(job_id)
        if _refresh_timer is not None:
            _refresh_timer.cancel()
        _refresh_timer = threading.Timer(_DEBOUNCE_SECONDS, _fire_refresh)
        _refresh_timer.daemon = True
        _refresh_timer.start()


def _update_job_scan(job_id: str, label: str, ok: bool, detail: str) -> None:
    try:
        from ... import jobs as jobs_mod
        job = jobs_mod.JOBS.get(job_id)
        if not job:
            return
        for rep in job.reports:
            if rep.get("label") == label:
                rep["ok"] = ok
                rep["detail"] = "bibliothèque rafraîchie" if ok else f"échec ({detail})"
        job.log.append(
            f"{label}: rafraîchissement {'ok' if ok else 'échec — ' + detail}"
        )
        jobs_mod.persist(job)
    except Exception:  # noqa: BLE001
        pass


# --- Connection test -------------------------------------------------------
def _test_connection(settings: dict[str, Any]) -> dict[str, Any]:
    stype = settings.get("server_type") or "aucun"
    base = (settings.get("base_url") or "").strip().rstrip("/")
    token = settings.get("api_key") or ""
    if stype not in ("jellyfin", "plex"):
        return {"ok": False, "message": "Choisissez un type de serveur (Jellyfin ou Plex)."}
    if not base:
        return {"ok": False, "message": "Renseignez l'adresse du serveur (base_url)."}
    try:
        if stype == "jellyfin":
            req = urllib.request.Request(base + "/System/Info", headers={"X-Emby-Token": token})
            with urllib.request.urlopen(req, timeout=5) as r:
                import json
                info = json.loads(r.read() or "{}")
            return {
                "ok": True,
                "message": f"Connecté à Jellyfin {info.get('Version', '?')} — "
                           f"{info.get('ServerName', 'serveur')} · bibliothèque visible",
            }
        # Plex: /identity is unauthenticated but confirms reachability; a token,
        # if given, is validated against a library listing.
        ident = base + "/identity"
        with urllib.request.urlopen(ident, timeout=5):
            pass
        if token:
            check = base + "/library/sections?X-Plex-Token=" + quote(token)
            with urllib.request.urlopen(check, timeout=5):
                pass
        return {"ok": True, "message": "Connecté à Plex — bibliothèque visible"}
    except urllib.error.HTTPError as e:
        if e.code == 401:
            return {"ok": False, "message": "Clé API / token invalide (401)."}
        return {"ok": False, "message": f"Réponse inattendue du serveur (HTTP {e.code})."}
    except urllib.error.URLError as e:
        return {"ok": False, "message": f"Connexion impossible : {e.reason} "
                                        f"(adresse, DNS ou serveur hors ligne ?)"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "message": f"Erreur : {e}"}


# --- The plugin ------------------------------------------------------------
class MediaCenterOutput(OutputPlugin):
    MANIFEST = PluginManifest(
        id="mediacenter",
        name="Media Center (Jellyfin / Plex)",
        version="1.0.0",
        type="output",
        description="Génère les métadonnées NFO + visuels et notifie Jellyfin/Plex de rescanner.",
        settings_schema=[
            SettingField(key="server_type", type="select", label="Serveur média",
                         help="Type de serveur à notifier après un téléchargement.",
                         default="aucun", options=["aucun", "jellyfin", "plex"]),
            SettingField(key="base_url", type="str", label="Adresse du serveur",
                         help="Ex. http://192.168.1.10:8096 (Jellyfin) ou http://192.168.1.10:32400 (Plex).",
                         default=""),
            SettingField(key="api_key", type="str", label="Clé API / Token", secret=True,
                         help="Jellyfin : Tableau de bord → Clés API. Plex : X-Plex-Token.",
                         default=""),
            SettingField(key="plex_section_id", type="str", label="ID de bibliothèque Plex",
                         help="Optionnel (Plex) : ID de la section à rescanner ; vide = tout.",
                         default=""),
            SettingField(key="generate_nfo", type="bool", label="Générer les NFO + visuels",
                         help="Écrit les .nfo, posters et miniatures à côté des vidéos.",
                         default=True),
            SettingField(key="notify_scan", type="bool", label="Notifier le rescan",
                         help="Demande au serveur de rescanner sa bibliothèque (débounce 60 s).",
                         default=True),
        ],
        actions=[
            PluginAction(id="test", label="Tester la connexion", kind="test"),
            PluginAction(id="backfill", kind="backfill", confirm=True,
                         label="Générer les métadonnées pour la bibliothèque existante"),
        ],
    )

    # --- pipeline hook ---
    def on_content_ready(self, result: DownloadResult, ctx: PluginContext) -> None:
        s = ctx.settings
        if s.get("generate_nfo", True) and result.items:
            n = _generate_nfos(result.items, ctx)
            result.reports.append(
                {"plugin": "mediacenter", "label": "NFO", "ok": True, "detail": f"{n} fichier(s)"}
            )
        stype = s.get("server_type") or "aucun"
        if s.get("notify_scan", True) and stype in ("jellyfin", "plex") and (s.get("base_url") or "").strip():
            _schedule_refresh(dict(s), result.job_id)
            label = "Jellyfin" if stype == "jellyfin" else "Plex"
            result.reports.append(
                {"plugin": "mediacenter", "label": label, "ok": True, "detail": "rafraîchissement programmé"}
            )

    # --- UI actions ---
    def action(self, name: str, payload: dict[str, Any], ctx: PluginContext):
        if name == "test":
            return _test_connection(ctx.settings), 200
        if name == "backfill":
            from ... import jobs as jobs_mod
            job = jobs_mod.create_task("Génération des métadonnées (bibliothèque)")
            threading.Thread(target=_run_backfill, args=(job, ctx), daemon=True).start()
            return {"job_id": job.id, "status": "started"}, 200
        return {"error": f"Action inconnue : {name}"}, 400


def _generate_nfos(items: list[MediaItem], ctx: PluginContext) -> int:
    """Write episode NFO + thumb per item and tvshow.nfo + poster per folder."""
    written = 0
    tvshow_done: set[str] = set()
    avatar_cache: dict[str, str] = {}
    for item in items:
        if not item.filepath:
            continue
        media = Path(item.filepath)
        try:
            runtime = str(round(item.duration / 60)) if item.duration else ""
            root = _episode_root(
                title=item.title, plot=item.description, aired=_iso_date(item.uploaded_at),
                runtime_min=runtime, studio=item.channel, source=item.source,
                uid=item.id, thumb_url=item.thumbnail,
            )
            _write_xml(media.with_suffix(".nfo"), root)
            _ensure_thumb(media, item.thumbnail)
            written += 1
        except OSError as exc:
            ctx.logger.warning("mediacenter: NFO write failed for %s: %s", media.name, exc)
            continue

        folder = media.parent
        key = str(folder)
        if key not in tvshow_done:
            tvshow_done.add(key)
            try:
                _write_xml(folder / "tvshow.nfo", _tvshow_root(item.channel, ""))
            except OSError:
                pass
            # Channel poster (once per folder, only if missing — it's a fetch).
            poster = folder / "poster.jpg"
            if not poster.exists() and item.channel_url:
                url = avatar_cache.get(item.channel_url)
                if url is None:
                    try:
                        from . import ytdlp_source as ytsrc
                        url = ytsrc.fetch_channel_avatar(item.channel_url, []) or ""
                    except Exception:  # noqa: BLE001
                        url = ""
                    avatar_cache[item.channel_url] = url
                if url:
                    _download_image(url, poster)
    return written


def _run_backfill(job: Any, ctx: PluginContext) -> None:
    """Generate NFOs for the EXISTING library from filenames — never touches or
    moves media. Progress is shown via the task job in the Downloads view."""
    from ... import jobs as jobs_mod
    try:
        media_files = [
            p for p in DOWNLOAD_DIR.rglob("*")
            if p.is_file() and p.suffix.lstrip(".").lower() in MEDIA_EXTS
        ]
        job.total = len(media_files)
        jobs_mod.persist(job)
        tvshow_done: set[str] = set()
        last_write = 0.0
        for i, media in enumerate(media_files):
            try:
                stem = media.stem
                m = _ID_RE.search(stem)
                vid = m.group(1) if m else ""
                title = stem[: m.start()].strip() if m else stem
                root = _episode_root(
                    title=title, plot="", aired="", runtime_min="",
                    studio=media.parent.name, source="youtube", uid=vid, thumb_url="",
                )
                _write_xml(media.with_suffix(".nfo"), root)
                _ensure_thumb(media, "")  # copy existing <stem>.jpg if present
                folder = media.parent
                if str(folder) not in tvshow_done and folder != DOWNLOAD_DIR:
                    tvshow_done.add(str(folder))
                    _write_xml(folder / "tvshow.nfo", _tvshow_root(folder.name, ""))
            except OSError as exc:
                job.log.append(f"backfill: {media.name}: {exc}")
            job.completed = i + 1
            job.current_title = media.name
            now = time.time()
            if now - last_write >= 1.0:
                last_write = now
                jobs_mod.persist(job)
        job.status = "done"
        job.finished_at = time.time()
        job.log.append(f"Métadonnées générées pour {job.completed} fichier(s).")
        jobs_mod.persist(job)
    except Exception as exc:  # noqa: BLE001
        job.status = "error"
        job.error = str(exc)
        job.finished_at = time.time()
        jobs_mod.persist(job)
