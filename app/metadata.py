"""Write Jellyfin/Plex-friendly sidecar metadata next to a downloaded video.

We emit a Kodi-style ``<movie>`` ``.nfo`` (read natively by Jellyfin, and by
Plex via the NFO/"XBMC" agent) plus a ``-poster.jpg`` image, built from the
yt-dlp info dict. Each YouTube video is treated as a standalone "movie" — the
simplest model that works in a mixed/movies library without a strict
season/episode numbering scheme.

Gated by the ``nfo_export`` setting and fully best-effort: a metadata failure
never breaks or fails a download.
"""

from __future__ import annotations

import html
import shutil
from datetime import datetime
from pathlib import Path
from typing import Any

from . import store


def _esc(value: Any) -> str:
    # Escape &, <, > for XML text nodes (quotes are fine inside element text).
    return html.escape(str(value if value is not None else ""), quote=False)


def _nfo_xml(info: dict[str, Any]) -> str:
    title = info.get("title") or "Sans titre"
    plot = info.get("description") or ""
    channel = info.get("uploader") or info.get("channel") or ""
    upload = str(info.get("upload_date") or "")  # YYYYMMDD
    premiered = f"{upload[0:4]}-{upload[4:6]}-{upload[6:8]}" if len(upload) == 8 else ""
    year = upload[0:4] if len(upload) >= 4 else ""
    duration = info.get("duration")
    runtime = str(round(duration / 60)) if duration else ""
    vid = info.get("id") or ""
    url = info.get("webpage_url") or (f"https://www.youtube.com/watch?v={vid}" if vid else "")
    thumb = info.get("thumbnail") or ""
    genres = info.get("categories") or []
    tags = (info.get("tags") or [])[:15]
    views = info.get("view_count")

    lines = ['<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>', "<movie>"]
    lines.append(f"  <title>{_esc(title)}</title>")
    if plot:
        lines.append(f"  <plot>{_esc(plot)}</plot>")
    if premiered:
        lines.append(f"  <premiered>{premiered}</premiered>")
    if year:
        lines.append(f"  <year>{_esc(year)}</year>")
    if channel:
        lines.append(f"  <studio>{_esc(channel)}</studio>")
        lines.append(f"  <director>{_esc(channel)}</director>")
    for genre in genres:
        lines.append(f"  <genre>{_esc(genre)}</genre>")
    if runtime:
        lines.append(f"  <runtime>{runtime}</runtime>")
    if thumb:
        lines.append(f'  <thumb aspect="poster">{_esc(thumb)}</thumb>')
    if isinstance(views, int):
        lines.append(f"  <playcount>0</playcount>")
        lines.append(f"  <votes>{views}</votes>")
    for tag in tags:
        lines.append(f"  <tag>{_esc(tag)}</tag>")
    if vid:
        lines.append(f'  <uniqueid type="youtube" default="true">{_esc(vid)}</uniqueid>')
    if url:
        lines.append(f"  <trailer>{_esc(url)}</trailer>")
    lines.append(f"  <dateadded>{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}</dateadded>")
    lines.append("</movie>")
    return "\n".join(lines) + "\n"


def write_sidecar(media_path: str, info: dict[str, Any] | None) -> None:
    """Write ``<name>.nfo`` and ``<name>-poster.jpg`` next to a downloaded file,
    if NFO export is enabled. No-op / swallows errors otherwise."""
    if not media_path or not info:
        return
    if not store.get_settings().get("nfo_export"):
        return
    try:
        media = Path(media_path)
        nfo = media.with_suffix(".nfo")
        tmp = nfo.with_suffix(".nfo.tmp")
        tmp.write_text(_nfo_xml(info), encoding="utf-8")
        tmp.replace(nfo)
        # Provide a local poster (Jellyfin: "<name>-poster.jpg"). The download
        # already wrote "<name>.jpg" via the thumbnail convertor.
        jpg = media.with_suffix(".jpg")
        poster = media.with_name(media.stem + "-poster.jpg")
        if jpg.exists() and not poster.exists():
            shutil.copyfile(jpg, poster)
    except OSError:
        pass
