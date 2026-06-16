"""FastAPI app that downloads YouTube playlists in 1080p+ using yt-dlp.

For resolutions >= 1080p, YouTube serves video and audio as separate streams,
so yt-dlp downloads each and merges them with ffmpeg into a single .mp4.

It can also "watch" playlists/channels: a background scheduler periodically
checks each watch and downloads any new videos, using yt-dlp's download archive
to avoid re-downloading what is already on disk.
"""

from __future__ import annotations

import os
import shutil
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit, urlunsplit

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from yt_dlp import YoutubeDL
from yt_dlp.utils import DateRange

from . import store

BASE_DIR = Path(__file__).resolve().parent
DOWNLOAD_DIR = Path("/downloads")  # mounted as a volume in Docker
DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)

# Optional Netscape-format cookies.txt, mounted into the container. Required to
# get past YouTube's "Sign in to confirm you're not a bot" check, which is
# common from datacenter/Docker IPs. Export it from your logged-in browser.
COOKIES_FILE = os.environ.get("COOKIES_FILE", "/cookies/cookies.txt")

# bgutil PO-token provider (sidecar container). YouTube increasingly requires a
# proof-of-origin token; the bgutil-ytdlp-pot-provider plugin fetches one from
# this HTTP service during extraction.
POT_PROVIDER_URL = os.environ.get("POT_PROVIDER_URL", "http://bgutil-provider:4416")

app = FastAPI(title="Fetchly — Video Downloader", version="0.0.1")

WEB_DIR = BASE_DIR / "web"  # built React SPA (Vite output, copied in Docker)
WEB_DIR.mkdir(exist_ok=True)

# Serve the downloaded media so videos and their thumbnails can be browsed,
# played and downloaded straight from the UI. The SPA itself is mounted at "/"
# at the very end of this file (after all the API routes).
app.mount("/media", StaticFiles(directory=str(DOWNLOAD_DIR)), name="media")


# --- Quality presets -------------------------------------------------------
# yt-dlp format selectors. The "+ba" part triggers the separate video/audio
# download and ffmpeg merge.
#
# Audio: we force AAC ("acodec^=mp4a", YouTube format 140) because YouTube's
# other audio codec, Opus, plays as SILENT in an MP4 container on many players
# (Windows Media Player, QuickTime, etc.). AAC plays everywhere with sound.
#
# Video: prefer H.264 ("vcodec^=avc1") for maximum compatibility where it
# exists (up to 1080p). Above 1080p YouTube only offers VP9/AV1, so we take
# those but still pair them with AAC audio.
#
# "<=?" makes the height a preference (graceful fallback), and each selector
# ends with broader fallbacks so it never fails outright.
QUALITY_FORMATS: dict[str, str] = {
    "1080": (
        "bv*[height<=?1080][vcodec^=avc1]+ba[acodec^=mp4a]/"
        "bv*[height<=?1080]+ba[acodec^=mp4a]/"
        "bv*[height<=?1080]+ba/b[height<=?1080]/b"
    ),
    "1440": (
        "bv*[height<=?1440]+ba[acodec^=mp4a]/"
        "bv*[height<=?1440]+ba/b[height<=?1440]/b"
    ),
    "2160": (
        "bv*[height<=?2160]+ba[acodec^=mp4a]/"
        "bv*[height<=?2160]+ba/b[height<=?2160]/b"
    ),
    "best": "bv*+ba[acodec^=mp4a]/bv*+ba/b",
}

# Normalize the frontend's quality labels (and the legacy presets) to a height
# key. "audio" means audio-only extraction.
_QUALITY_NORM: dict[str, str] = {
    "Auto": "best", "best": "best",
    "2160p": "2160", "2160": "2160", "1440p": "1440", "1440": "1440",
    "1080p": "1080", "1080": "1080", "720p": "720", "720": "720",
    "480p": "480", "480": "480",
    "Audio seul": "audio", "audio": "audio",
}
_QUALITY_HEIGHT = {"480": 480, "720": 720, "1080": 1080, "1440": 1440, "2160": 2160}

# Extensions shown in the Library (video + extracted audio).
MEDIA_EXTS = ("mp4", "mkv", "webm", "mp3", "m4a")


def _format_opts(quality: str, fmt: str) -> dict[str, Any]:
    """Translate a frontend quality + container choice into yt-dlp options.

    quality: Auto/1080p/720p/480p/Audio seul (or legacy 1080/best/...).
    fmt:     MP4 / MKV / MP3 / M4A.
    """
    fmt = (fmt or "MP4").upper()
    q = _QUALITY_NORM.get(quality, "best")
    thumb_pp = {"key": "FFmpegThumbnailsConvertor", "format": "jpg"}

    if q == "audio" or fmt in ("MP3", "M4A"):
        codec = "mp3" if fmt == "MP3" else "m4a"
        return {
            "format": "bestaudio/best",
            "writethumbnail": True,
            "postprocessors": [
                {"key": "FFmpegExtractAudio", "preferredcodec": codec},
            ],
        }

    height = _QUALITY_HEIGHT.get(q)
    if height:
        selector = (
            f"bv*[height<=?{height}][vcodec^=avc1]+ba[acodec^=mp4a]/"
            f"bv*[height<=?{height}]+ba[acodec^=mp4a]/"
            f"bv*[height<=?{height}]+ba/b[height<=?{height}]/b"
        )
    else:
        selector = "bv*+ba[acodec^=mp4a]/bv*+ba/b"
    return {
        "format": selector,
        "merge_output_format": "mkv" if fmt == "MKV" else "mp4",
        "writethumbnail": True,
        "postprocessors": [thumb_pp],
    }


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# How the files are foldered under /downloads, per the "organize" setting.
# Chained fallbacks end in extractor_key (always present, e.g. "Youtube") so a
# missing uploader/playlist never produces an "NA" folder.
ORGANIZE_TEMPLATES = {
    "uploader": "%(uploader,channel,extractor_key)s/%(title)s [%(id)s].%(ext)s",
    "playlist": "%(playlist_title,uploader,channel,extractor_key)s/%(title)s [%(id)s].%(ext)s",
    "flat": "%(title)s [%(id)s].%(ext)s",
}


def _outtmpl(dest: str) -> str:
    organize = store.get_settings()["organize"]
    tmpl = ORGANIZE_TEMPLATES.get(organize, ORGANIZE_TEMPLATES["playlist"])
    base = DOWNLOAD_DIR
    if dest:
        # keep it inside /downloads — strip separators and parent refs
        safe = dest.strip().strip("/\\").replace("..", "")
        if safe:
            base = DOWNLOAD_DIR / safe
    return str(base / tmpl)


# --- Job tracking ----------------------------------------------------------
@dataclass
class Job:
    id: str
    url: str
    quality: str
    kind: str = "manual"  # manual | watch
    status: str = "queued"  # queued | running | done | error
    phase: str = "downloading"  # downloading | processing (ffmpeg merge/convert)
    total: int = 0
    completed: int = 0
    downloaded: int = 0  # how many were actually new (not skipped)
    current_title: str = ""
    current_thumbnail: str = ""  # thumbnail of the video currently downloading
    current_percent: float = 0.0
    current_speed: str = ""
    files: list[str] = field(default_factory=list)
    error: str = ""
    log: list[str] = field(default_factory=list)
    use_archive: bool = False  # watches set this to skip already-downloaded
    watch_id: str | None = None
    dest: str = ""  # optional destination subfolder under /downloads
    date_after: str = ""  # only download videos uploaded on/after this date
    fmt: str = "MP4"  # container/format: MP4 / MKV / MP3 / M4A
    playlist_title: str = ""
    created_at: float = field(default_factory=time.time)


JOBS: dict[str, Job] = {}
JOBS_LOCK = threading.Lock()

# Watch IDs currently being checked, so a manual "Check now" and the scheduler
# (or two scheduler ticks) can never download the same playlist at once — that
# race makes two yt-dlp processes clobber each other's .part files.
_ACTIVE_WATCHES: set[str] = set()
_ACTIVE_WATCHES_LOCK = threading.Lock()


class DownloadRequest(BaseModel):
    url: str
    quality: str = ""  # empty -> use saved default quality
    format: str = "MP4"
    subfolder: str = ""


class ExtractRequest(BaseModel):
    url: str


class SearchRequest(BaseModel):
    query: str
    limit: int = 15


class SettingsRequest(BaseModel):
    default_quality: str | None = None
    watch_interval_minutes: int | None = None
    organize: str | None = None
    max_concurrent: int | None = None


class WatchRequest(BaseModel):
    url: str
    quality: str | None = None
    backfill: bool = True
    subfolder: str = ""
    date_after: str = ""  # ISO date "YYYY-MM-DD"; only sync newer uploads
    title: str = ""  # known channel name, so the card shows it before first sync
    thumbnail: str = ""  # known channel avatar, shown before first sync


class WatchUpdate(BaseModel):
    enabled: bool | None = None
    quality: str | None = None
    subfolder: str | None = None
    date_after: str | None = None  # ISO "YYYY-MM-DD"; "" clears the filter


# --- yt-dlp option building ------------------------------------------------
def _common_opts(log: list[str]) -> tuple[dict[str, Any], str | None]:
    """Options shared by every yt-dlp call: cookies, PO-token provider and the
    multi-client extractor args. Returns the opts plus the temp cookie path to
    clean up afterwards (yt-dlp rewrites the cookie jar, so the read-only
    mounted file is copied to a writable temp location first)."""
    opts: dict[str, Any] = {
        "ignoreerrors": True,
        "quiet": True,
        "no_warnings": True,
        "retries": 5,
        # Skip TLS verification: corporate proxies (e.g. Ekimetrics) perform TLS
        # interception with a self-signed root CA that yt-dlp won't trust,
        # causing "CERTIFICATE_VERIFY_FAILED: self-signed certificate in
        # certificate chain". Only safe on a trusted network.
        "nocheckcertificate": True,
        "extractor_args": {
            # Try several player clients: YouTube serves different format sets
            # per client, widening availability and dodging "format not
            # available" errors.
            "youtube": {"player_client": ["default", "web_safari", "mweb", "tv"]},
            # Point the bgutil PO-token plugin at the sidecar provider.
            "youtubepot-bgutilhttp": {"base_url": [POT_PROVIDER_URL]},
        },
    }

    temp_cookies: str | None = None
    if os.path.isfile(COOKIES_FILE):
        fd, temp_cookies = tempfile.mkstemp(suffix=".txt", prefix="cookies-")
        os.close(fd)
        shutil.copyfile(COOKIES_FILE, temp_cookies)
        opts["cookiefile"] = temp_cookies
        log.append("Using cookies file for authentication.")
    else:
        log.append(
            "No cookies file found. If YouTube blocks with a bot check, "
            "mount a cookies.txt (see README)."
        )
    return opts, temp_cookies


def _log_available_formats(ydl: YoutubeDL, video_url: str, job: Job) -> None:
    """On a format failure, list what YouTube actually offered, to diagnose
    whether the video returned no formats (PO-token gated) or just none that
    matched the selector."""
    try:
        di = ydl.extract_info(video_url, download=False, process=False)
        formats = (di or {}).get("formats") or []
        heights = sorted({f"{f['height']}p" for f in formats if f.get("height")})
        if formats:
            job.log.append(
                f"  ↳ {len(formats)} formats offered; heights: "
                f"{', '.join(heights) or 'audio-only'}"
            )
        else:
            job.log.append(
                "  ↳ 0 formats offered — YouTube is gating this video behind a "
                "PO token. Make sure the bgutil provider container is running."
            )
    except Exception as exc:  # noqa: BLE001
        job.log.append(f"  ↳ could not list formats: {exc}")


def _download_parallel(job: Job, targets: list[dict[str, Any]], concurrency: int) -> None:
    """Download a playlist/channel's videos several at a time. Each worker uses
    its OWN YoutubeDL instance (and its own temp cookie copy, since yt-dlp
    rewrites the cookie jar on close) to stay thread-safe. Progress is shown as
    a completed/total count plus the summed live speed.

    For a date-limited backfill we download in ORDERED BATCHES so we can still
    stop early: once a whole batch is rejected by the date filter (channels list
    newest-first), everything after is older too and we stop."""
    speeds: dict[str, float] = {}
    lock = threading.Lock()
    DATE_STOP_AFTER = 3

    # Pre-filter videos already in the archive (cheap, no download).
    new_entries: list[dict[str, Any]] = []
    probe_opts, probe_cookie = _common_opts(job.log)
    if job.use_archive:
        probe_opts["download_archive"] = str(store.ARCHIVE_FILE)
    try:
        with YoutubeDL(probe_opts) as probe:
            for entry in targets:
                if not entry:
                    job.completed += 1
                    continue
                if job.use_archive and probe.in_download_archive(entry):
                    job.completed += 1
                    continue
                new_entries.append(entry)
    finally:
        if probe_cookie and os.path.exists(probe_cookie):
            os.remove(probe_cookie)

    def aggregate() -> None:
        with lock:
            job.current_speed = (
                f"{sum(speeds.values()) / 1_000_000:.1f} MB/s" if speeds else ""
            )
            active = len(speeds)
            if active:
                job.current_title = f"{active} vidéo(s) en cours…"

    def work(entry: dict[str, Any]) -> str:  # "downloaded" | "rejected" | "failed"
        vid = str(entry.get("id") or id(entry))
        video_url = entry.get("webpage_url") or entry.get("url") or entry.get("id")
        title = entry.get("title", "")
        thumb = _entry_thumb(entry)
        if thumb:
            job.current_thumbnail = thumb

        def hook(d: dict[str, Any]) -> None:
            if d["status"] == "downloading":
                with lock:
                    speeds[vid] = d.get("speed") or 0.0
            elif d["status"] in ("finished", "error"):
                with lock:
                    speeds.pop(vid, None)
            aggregate()

        w_opts, w_cookie = _common_opts(job.log)
        w_opts.update(
            {
                "outtmpl": _outtmpl(job.dest),
                "noplaylist": True,
                "progress_hooks": [hook],
                "concurrent_fragment_downloads": 4,
                "allow_playlist_files": False,
                **_format_opts(job.quality, job.fmt),
            }
        )
        if job.use_archive:
            w_opts["download_archive"] = str(store.ARCHIVE_FILE)
        if job.date_after:
            w_opts["daterange"] = DateRange(job.date_after.replace("-", ""), None)
        status = "rejected"
        try:
            with YoutubeDL(w_opts) as ydl:
                result = ydl.extract_info(video_url, download=True)
            if result is not None:
                ext = {"MP3": "mp3", "M4A": "m4a", "MKV": "mkv"}.get(job.fmt.upper(), "mp4")
                final = str(Path(ydl.prepare_filename(result)).with_suffix("." + ext))
                with lock:
                    job.files.append(Path(final).name)
                    job.downloaded += 1
                job.log.append(f"Downloaded: {title}")
                status = "downloaded"
            else:
                job.log.append(f"Skipped: {title}")
        except Exception as exc:  # noqa: BLE001
            job.log.append(f"Failed: {title} ({exc})")
            status = "failed"
        finally:
            if w_cookie and os.path.exists(w_cookie):
                os.remove(w_cookie)
            with lock:
                speeds.pop(vid, None)
                job.completed += 1
                job.current_percent = job.completed / job.total * 100 if job.total else 0.0
            aggregate()
        return status

    with ThreadPoolExecutor(max_workers=concurrency) as ex:
        if not job.date_after:
            list(ex.map(work, new_entries))
            return
        # Date-limited: ordered batches, stop once a full batch is date-rejected.
        consecutive_rejects = 0
        for i in range(0, len(new_entries), concurrency):
            batch = new_entries[i : i + concurrency]
            statuses = list(ex.map(work, batch))
            if all(s == "rejected" for s in statuses):
                consecutive_rejects += len(batch)
            elif any(s == "downloaded" for s in statuses):
                consecutive_rejects = 0
            if consecutive_rejects >= DATE_STOP_AFTER:
                job.log.append("Reached the date cutoff — stopping.")
                break
        # We stopped early, so the channel's full count is meaningless here —
        # report progress against what we actually processed.
        job.total = max(job.completed, 1)


def _run_job(job: Job) -> None:
    job.status = "running"

    def progress_hook(d: dict[str, Any]) -> None:
        if d["status"] == "downloading":
            job.phase = "downloading"
            info = d.get("info_dict", {})
            job.current_title = info.get("title", job.current_title)
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            downloaded = d.get("downloaded_bytes", 0)
            job.current_percent = (downloaded / total * 100) if total else 0.0
            speed = d.get("speed")
            job.current_speed = f"{speed / 1_000_000:.1f} MB/s" if speed else ""
        elif d["status"] == "finished":
            job.current_percent = 100.0

    def postprocessor_hook(d: dict[str, Any]) -> None:
        # After the streams are downloaded, ffmpeg merges/converts — surface that
        # as a separate "processing" phase so the UI doesn't look stuck at 100%.
        if d["status"] == "started":
            job.phase = "processing"
            job.current_speed = ""
        elif d["status"] == "finished" and d.get("postprocessor") == "Merger":
            job.log.append(f"Merged: {d.get('info_dict', {}).get('title', '')}")

    ydl_opts, temp_cookies = _common_opts(job.log)
    ydl_opts.update(
        {
            "outtmpl": _outtmpl(job.dest),
            "noplaylist": False,
            "progress_hooks": [progress_hook],
            "postprocessor_hooks": [postprocessor_hook],
            "concurrent_fragment_downloads": 4,
            # Don't write a thumbnail/description for the playlist itself, which
            # would land as a junk "downloads [PL…].jpg" tile.
            "allow_playlist_files": False,
            # format selector, container and post-processors per quality+format.
            **_format_opts(job.quality, job.fmt),
        }
    )
    if job.use_archive:
        # Skip (and record) videos already downloaded — this is what makes a
        # watch only grab new uploads on each check.
        ydl_opts["download_archive"] = str(store.ARCHIVE_FILE)
    if job.date_after:
        # Only download videos uploaded on/after this date (e.g. "20240101").
        ydl_opts["daterange"] = DateRange(job.date_after.replace("-", ""), None)

    try:
        # FLAT listing first to learn the entries/total. This MUST be flat:
        # extracting a channel without extract_flat deep-extracts every video's
        # metadata (1000+ page loads for a big channel) — that is what made watch
        # checks take minutes. The per-video download below re-extracts each.
        list_opts, list_cookies = _common_opts(job.log)
        list_opts["extract_flat"] = "in_playlist"
        try:
            with YoutubeDL(list_opts) as lydl:
                info = lydl.extract_info(job.url, download=False)
        finally:
            if list_cookies and os.path.exists(list_cookies):
                os.remove(list_cookies)

        entries = info.get("entries") if info else None
        if entries is not None:
            entries = [e for e in entries if e]
            job.total = len(entries)
            job.playlist_title = (info or {}).get("title", "")
            job.log.append(f"Found {job.total} videos.")
        else:
            job.total = 1  # single video
        targets = entries if entries is not None else [info]

        # Parallel path for multi-video jobs: download several at once, up to the
        # configured limit. Handles the date filter too (ordered batches with an
        # early stop). Single videos fall through to the sequential path.
        concurrency = max(1, int(store.get_settings().get("max_concurrent", 3) or 3))
        if entries is not None and concurrency > 1:
            job.log.append(f"Downloading up to {concurrency} videos in parallel.")
            _download_parallel(job, targets, concurrency)
            job.status = "done"
            job.log.append(f"Finished. {job.downloaded} new file(s).")
            return

        # For a date-limited backfill, count consecutive date-rejected videos so
        # we can stop once we hit the (contiguous, newest-first) older tail —
        # while tolerating the odd isolated skip (private/members video).
        date_misses = 0
        DATE_STOP_AFTER = 3
        with YoutubeDL(ydl_opts) as ydl:
            for entry in targets:
                if not entry:
                    job.completed += 1
                    continue
                if job.use_archive and ydl.in_download_archive(entry):
                    job.completed += 1
                    date_misses = 0  # already-have means we're still in range
                    continue  # already have it; stay quiet to keep logs short
                video_url = entry.get("webpage_url") or entry.get("url") or entry.get("id")
                job.current_title = entry.get("title", "")
                job.current_thumbnail = _entry_thumb(entry) or job.current_thumbnail
                job.current_percent = 0.0
                job.phase = "downloading"
                try:
                    result = ydl.extract_info(video_url, download=True)
                    if result is None:
                        job.log.append(f"Skipped: {entry.get('title', '')}")
                        date_misses += 1
                        if job.date_after and entries is not None and date_misses >= DATE_STOP_AFTER:
                            # Reached the older-than-cutoff tail — stop scanning the
                            # rest of the channel. (-1: the finally adds the last +1.)
                            job.completed = job.total - 1
                            job.log.append("Reached the date cutoff — stopping.")
                            break
                    else:
                        date_misses = 0
                        ext = {"MP3": "mp3", "M4A": "m4a", "MKV": "mkv"}.get(
                            job.fmt.upper(), "mp4"
                        )
                        filename = ydl.prepare_filename(result)
                        final = str(Path(filename).with_suffix("." + ext))
                        job.files.append(Path(final).name)
                        job.downloaded += 1
                        job.log.append(f"Downloaded: {entry.get('title', '')}")
                except Exception as exc:  # noqa: BLE001
                    job.log.append(f"Failed: {entry.get('title', '')} ({exc})")
                    if "Requested format" in str(exc):
                        _log_available_formats(ydl, video_url, job)
                finally:
                    job.completed += 1

        job.status = "done"
        job.log.append(f"Finished. {job.downloaded} new file(s).")
    except Exception as exc:  # noqa: BLE001
        job.status = "error"
        job.error = str(exc)
        job.log.append(f"Error: {exc}")
    finally:
        if temp_cookies and os.path.exists(temp_cookies):
            os.remove(temp_cookies)


# --- Watches ---------------------------------------------------------------
def _archive_ids() -> set[str]:
    """The video IDs recorded in the download archive ("youtube <id>" lines)."""
    ids: set[str] = set()
    try:
        with store.ARCHIVE_FILE.open(encoding="utf-8") as f:
            for line in f:
                parts = line.split()
                if len(parts) == 2:
                    ids.add(parts[1])
    except FileNotFoundError:
        pass
    return ids


# Channel tab path segments (.../@name/<tab>); stripped to reach the root.
_CHANNEL_TABS = ("videos", "shorts", "streams", "live", "playlists", "featured", "community")


def _is_channel_url(url: str) -> bool:
    u = url.lower()
    return "/@" in u or "/channel/" in u or "/c/" in u or "/user/" in u


def _channel_root(url: str) -> str:
    """Strip a trailing tab segment (/videos, /shorts, …) and any query so we
    target the channel's main page, where yt-dlp exposes the avatar."""
    try:
        parts = urlsplit(url)
        segs = [s for s in parts.path.split("/") if s and s.lower() not in _CHANNEL_TABS]
        return urlunsplit((parts.scheme, parts.netloc, "/" + "/".join(segs), "", ""))
    except Exception:  # noqa: BLE001
        return url


def _fetch_channel_avatar(url: str, log: list[str]) -> str:
    """Best-effort fetch of a channel's avatar via a cheap metadata-only
    extraction of its root page (playlist_items=1 avoids listing every video).
    The flat /videos listing used elsewhere does not carry the avatar."""
    if not _is_channel_url(url):
        return ""
    opts, temp_cookies = _common_opts(log)
    opts["extract_flat"] = True
    opts["playlist_items"] = "1"
    try:
        with YoutubeDL(opts) as ydl:
            info = ydl.extract_info(_channel_root(url), download=False)
        return _channel_avatar(info or {})
    except Exception:  # noqa: BLE001
        return ""
    finally:
        if temp_cookies and os.path.exists(temp_cookies):
            os.remove(temp_cookies)


def _channel_avatar(info: dict[str, Any]) -> str:
    """Pick a channel's round avatar from a flat extraction's thumbnails.

    YouTube tags the avatar with an id containing "avatar"; otherwise prefer the
    most square thumbnail (avatars are square, banners are wide) so we never
    return the channel banner. Falls back to the first thumbnail / the plain
    thumbnail field."""
    thumbs = info.get("thumbnails") or []
    for t in thumbs:
        if "avatar" in str(t.get("id", "")).lower() and t.get("url"):
            return t["url"]
    best, best_ratio = "", 99.0
    for t in thumbs:
        w, h = t.get("width"), t.get("height")
        if t.get("url") and w and h:
            ratio = abs(w / h - 1)
            if ratio < best_ratio:
                best, best_ratio = t["url"], ratio
    if best:
        return best
    if thumbs and thumbs[0].get("url"):
        return thumbs[0]["url"]
    return info.get("thumbnail") or ""


# Global pool that performs the actual video downloads, plus a resizable gate so
# a watch can fetch several videos at once (each video is its own Job) without
# ever exceeding the configured limit across all watches.
_DOWNLOAD_POOL = ThreadPoolExecutor(max_workers=12, thread_name_prefix="dl")
_DL_GATE = threading.Semaphore(3)
_DL_GATE_LOCK = threading.Lock()


def _set_download_concurrency(n: int) -> None:
    global _DL_GATE
    with _DL_GATE_LOCK:
        _DL_GATE = threading.Semaphore(max(1, min(int(n), 10)))


def _run_job_gated(job: Job) -> None:
    """Run a single-video job, but only once a concurrency slot is free."""
    with _DL_GATE_LOCK:
        gate = _DL_GATE
    gate.acquire()
    try:
        _run_job(job)
    finally:
        gate.release()


def _flat_list(url: str, log: list[str]) -> list[dict[str, Any]]:
    """Flat (id/title only) listing of a URL's entries, newest-first."""
    opts, cookie = _common_opts(log)
    opts["extract_flat"] = "in_playlist"
    try:
        with YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
        return [e for e in ((info or {}).get("entries") or []) if e]
    except Exception as exc:  # noqa: BLE001
        log.append(f"List {url}: {exc}")
        return []
    finally:
        if cookie and os.path.exists(cookie):
            os.remove(cookie)


def _watch_sources(url: str) -> list[str]:
    """URLs that flat-list a watch's ACTUAL videos. A bare channel URL lists its
    tabs (Videos/Shorts/…), not videos, so target /videos and /shorts directly."""
    if _is_channel_url(url):
        root = _channel_root(url).rstrip("/")
        return [f"{root}/videos", f"{root}/shorts"]
    return [url]


def _collect_new_videos(watch: dict[str, Any], log: list[str]) -> list[dict[str, Any]]:
    """Real videos (and shorts) for this watch not yet in the archive, optionally
    filtered by the watch's date — newest-first with an early stop once we pass
    the cutoff so we don't scan the whole back-catalogue."""
    after = (watch.get("date_after") or "").replace("-", "")
    archived = _archive_ids()
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for src in _watch_sources(watch["url"]):
        candidates = [
            e
            for e in _flat_list(src, log)
            if e.get("id") and e["id"] not in archived and e["id"] not in seen
        ]
        if not after:
            for e in candidates:
                seen.add(e["id"])
                out.append(e)
            continue
        # Date filter with early stop (entries are newest-first within a source).
        # Cap the scan so that if upload dates are unavailable we don't walk the
        # entire back-catalogue — the in-range videos are at the front anyway.
        opts, cookie = _common_opts(log)
        misses = 0
        checked = 0
        SCAN_CAP = 300
        try:
            with YoutubeDL(opts) as ydl:
                for e in candidates:
                    if checked >= SCAN_CAP:
                        break
                    checked += 1
                    vurl = e.get("url") or e.get("webpage_url") or e["id"]
                    try:
                        meta = ydl.extract_info(vurl, download=False, process=False)
                    except Exception:  # noqa: BLE001
                        meta = None
                    ud = (meta or {}).get("upload_date")
                    if ud and ud < after:
                        misses += 1
                        if misses >= 3:
                            break
                        continue
                    misses = 0
                    seen.add(e["id"])
                    out.append(e)
        finally:
            if cookie and os.path.exists(cookie):
                os.remove(cookie)
    return out


def _seed_archive(url: str, log: list[str]) -> list[dict[str, Any]]:
    """Record a watch's existing videos into the download archive WITHOUT
    downloading them, so a 'no backfill' watch only grabs uploads from now on."""
    entries: list[dict[str, Any]] = []
    for src in _watch_sources(url):
        entries.extend(_flat_list(src, log))
    with store.ARCHIVE_FILE.open("a", encoding="utf-8") as f:
        for entry in entries:
            if entry.get("id"):
                f.write(f"youtube {entry['id']}\n")
    return entries


def _run_watch_check(watch: dict[str, Any]) -> None:
    """Check a single watch once: seed-only on first run if backfill is off,
    otherwise download any new videos. Never runs twice for the same watch
    concurrently."""
    wid = watch["id"]
    with _ACTIVE_WATCHES_LOCK:
        if wid in _ACTIVE_WATCHES:
            return  # already being checked — skip this duplicate trigger
        _ACTIVE_WATCHES.add(wid)
    try:
        _do_watch_check(watch)
    finally:
        with _ACTIVE_WATCHES_LOCK:
            _ACTIVE_WATCHES.discard(wid)


def _do_watch_check(watch: dict[str, Any]) -> None:
    store.CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    quality = watch.get("quality") or store.get_settings()["default_quality"]

    log: list[str] = []

    # First run with backfill disabled: just mark existing videos as seen.
    if not watch.get("backfill", True) and not watch.get("seeded"):
        try:
            entries = _seed_archive(watch["url"], log)
            videos = [
                {"id": e.get("id"), "title": e.get("title") or e.get("id") or "", "synced": True}
                for e in entries
                if e
            ]
            store.save_watch_videos(watch["id"], videos)
            store.update_watch(
                watch["id"],
                seeded=True,
                thumbnail=_fetch_channel_avatar(watch["url"], log) or watch.get("thumbnail", ""),
                synced=len(videos),
                total=len(videos),
                last_checked=_now_iso(),
                last_result=f"Seeded {len(videos)} existing (new only from now)",
            )
        except Exception as exc:  # noqa: BLE001
            store.update_watch(
                watch["id"], last_checked=_now_iso(), last_result=f"Seed error: {exc}"
            )
        return

    # Backfill / new-video check: one Job per real video, downloaded with bounded
    # concurrency via the global pool. We wait for them to finish so the watch
    # stays "checking" and a re-check can't re-queue the same videos.
    try:
        to_dl = _collect_new_videos(watch, log)
    except Exception as exc:  # noqa: BLE001
        store.update_watch(
            watch["id"], last_checked=_now_iso(), last_result=f"Check error: {exc}"
        )
        return

    jobs: list[Job] = []
    for entry in to_dl:
        vurl = entry.get("webpage_url") or entry.get("url") or entry.get("id")
        if not vurl:
            continue
        job = Job(
            id=str(uuid.uuid4()),
            url=vurl,
            quality=quality,
            kind="watch",
            use_archive=True,
            watch_id=watch["id"],
            dest=watch.get("subfolder", ""),
        )
        job.total = 1
        job.current_title = entry.get("title", "")
        job.current_thumbnail = _entry_thumb(entry)
        with JOBS_LOCK:
            JOBS[job.id] = job
        jobs.append(job)

    for future in [_DOWNLOAD_POOL.submit(_run_job_gated, j) for j in jobs]:
        try:
            future.result()
        except Exception:  # noqa: BLE001
            pass

    downloaded = sum(j.downloaded for j in jobs)
    store.update_watch(
        watch["id"],
        seeded=True,
        last_checked=_now_iso(),
        thumbnail=_fetch_channel_avatar(watch["url"], log) or watch.get("thumbnail", ""),
        last_result=f"{downloaded} new" if downloaded else "up to date",
    )


def _scheduler_loop() -> None:
    """Wake once a minute and check any watch whose interval has elapsed."""
    while True:
        try:
            interval = store.get_settings()["watch_interval_minutes"]
            cutoff = datetime.now(timezone.utc) - timedelta(minutes=interval)
            for watch in store.list_watches():
                if not watch.get("enabled", True):
                    continue
                last = watch.get("last_checked")
                due = True
                if last:
                    try:
                        due = datetime.fromisoformat(last) <= cutoff
                    except ValueError:
                        due = True
                if due:
                    _run_watch_check(watch)
        except Exception as exc:  # noqa: BLE001
            print(f"[scheduler] error: {exc}", flush=True)
        time.sleep(60)


def _cleanup_partials() -> None:
    """Remove leftover fragments from downloads that were interrupted (e.g. the
    container was restarted mid-download). On startup nothing is downloading, so
    every .part/.ytdl is stale. Also drop orphan .webp thumbnails whose video
    never finished."""
    removed = 0
    for pattern in ("*.part", "*.ytdl", "*.part-Frag*"):
        for p in DOWNLOAD_DIR.rglob(pattern):
            try:
                p.unlink()
                removed += 1
            except OSError:
                pass
    for p in DOWNLOAD_DIR.rglob("*.webp"):
        if not any(p.with_suffix("." + ext).exists() for ext in MEDIA_EXTS):
            try:
                p.unlink()
                removed += 1
            except OSError:
                pass
    if removed:
        print(f"[startup] cleaned {removed} leftover partial file(s)", flush=True)


@app.on_event("startup")
def _on_startup() -> None:
    _cleanup_partials()
    _set_download_concurrency(store.get_settings().get("max_concurrent", 3))
    threading.Thread(target=_scheduler_loop, daemon=True).start()


# --- Routes ----------------------------------------------------------------
@app.post("/api/download")
async def start_download(req: DownloadRequest) -> JSONResponse:
    if not req.url.strip():
        return JSONResponse({"error": "URL is required"}, status_code=400)
    quality = req.quality or store.get_settings()["default_quality"]
    job = Job(
        id=str(uuid.uuid4()),
        url=req.url.strip(),
        quality=quality,
        fmt=req.format or "MP4",
        dest=req.subfolder.strip(),
    )
    with JOBS_LOCK:
        JOBS[job.id] = job
    threading.Thread(target=_run_job, args=(job,), daemon=True).start()
    return JSONResponse({"job_id": job.id})


@app.get("/api/status/{job_id}")
async def status(job_id: str) -> JSONResponse:
    job = JOBS.get(job_id)
    if not job:
        return JSONResponse({"error": "Unknown job"}, status_code=404)
    return JSONResponse(
        {
            "status": job.status,
            "phase": job.phase,
            "total": job.total,
            "completed": job.completed,
            "downloaded": job.downloaded,
            "current_title": job.current_title,
            "current_percent": round(job.current_percent, 1),
            "current_speed": job.current_speed,
            "files": job.files,
            "error": job.error,
            "log": job.log[-50:],
        }
    )


@app.get("/api/settings")
async def get_settings() -> JSONResponse:
    data = store.get_settings()
    data["download_dir"] = str(DOWNLOAD_DIR)
    data["qualities"] = list(QUALITY_FORMATS.keys())
    return JSONResponse(data)


@app.post("/api/settings")
async def set_settings(req: SettingsRequest) -> JSONResponse:
    cfg = store.update_settings(
        req.default_quality, req.watch_interval_minutes, req.organize, req.max_concurrent
    )
    _set_download_concurrency(cfg.get("max_concurrent", 3))
    return JSONResponse(
        {
            "default_quality": cfg["default_quality"],
            "watch_interval_minutes": cfg["watch_interval_minutes"],
            "organize": cfg["organize"],
            "max_concurrent": cfg.get("max_concurrent", 3),
        }
    )


@app.get("/api/watches")
async def get_watches() -> JSONResponse:
    return JSONResponse(store.list_watches())


@app.post("/api/watches")
async def add_watch(req: WatchRequest) -> JSONResponse:
    url = req.url.strip()
    if not url:
        return JSONResponse({"error": "URL is required"}, status_code=400)
    # Refuse duplicate watches for the same URL — two watches on one channel
    # would download the same videos twice (and clobber each other's files).
    if any(w.get("url", "").strip() == url for w in store.list_watches()):
        return JSONResponse(
            {"error": "Déjà abonné à cette chaîne"}, status_code=409
        )
    watch = store.add_watch(
        req.url.strip(),
        req.quality or None,
        req.backfill,
        req.subfolder.strip(),
        req.date_after.strip(),
        req.title.strip(),
        req.thumbnail.strip(),
    )
    # Kick off an immediate first check in the background.
    threading.Thread(target=_run_watch_check, args=(watch,), daemon=True).start()
    return JSONResponse(watch)


@app.delete("/api/watches/{watch_id}")
async def delete_watch(watch_id: str) -> JSONResponse:
    store.delete_watch_videos(watch_id)
    return JSONResponse({"removed": store.remove_watch(watch_id)})


@app.get("/api/watches/{watch_id}/videos")
async def watch_videos(watch_id: str) -> JSONResponse:
    watch = store.get_watch(watch_id)
    if watch is None:
        return JSONResponse({"error": "Unknown watch"}, status_code=404)
    videos = store.load_watch_videos(watch_id)
    return JSONResponse(
        {
            "synced": sum(1 for v in videos if v.get("synced")),
            "total": len(videos),
            "videos": videos,
        }
    )


@app.post("/api/watches/{watch_id}/check")
async def check_watch_now(watch_id: str) -> JSONResponse:
    for watch in store.list_watches():
        if watch["id"] == watch_id:
            threading.Thread(target=_run_watch_check, args=(watch,), daemon=True).start()
            return JSONResponse({"status": "checking"})
    return JSONResponse({"error": "Unknown watch"}, status_code=404)


@app.patch("/api/watches/{watch_id}")
async def update_watch(watch_id: str, req: WatchUpdate) -> JSONResponse:
    fields: dict[str, Any] = {}
    if req.enabled is not None:
        fields["enabled"] = req.enabled
    if req.quality is not None:
        fields["quality"] = req.quality or None
    if req.subfolder is not None:
        fields["subfolder"] = req.subfolder.strip()
    if req.date_after is not None:
        fields["date_after"] = req.date_after.strip()
    watch = store.update_watch(watch_id, **fields)
    if watch is None:
        return JSONResponse({"error": "Unknown watch"}, status_code=404)
    return JSONResponse(watch)


@app.get("/api/jobs")
async def list_jobs() -> JSONResponse:
    with JOBS_LOCK:
        jobs = sorted(JOBS.values(), key=lambda j: j.created_at, reverse=True)
    return JSONResponse(
        [
            {
                "id": j.id,
                "url": j.url,
                "kind": j.kind,
                "quality": j.quality,
                "status": j.status,
                "phase": j.phase,
                "total": j.total,
                "completed": j.completed,
                "downloaded": j.downloaded,
                "current_title": j.current_title,
                "current_thumbnail": j.current_thumbnail,
                "current_percent": round(j.current_percent, 1),
                "current_speed": j.current_speed,
                "files": j.files,
                "playlist_title": j.playlist_title,
                "watch_id": j.watch_id,
                "created_at": j.created_at,
            }
            for j in jobs[:60]
        ]
    )


def _media_url(path: Path) -> str:
    rel = path.relative_to(DOWNLOAD_DIR).as_posix()
    return "/media/" + quote(rel)


@app.get("/api/files")
async def list_files() -> JSONResponse:
    """Downloaded media for the Library view, newest first, each paired with
    its .jpg thumbnail if one was saved."""
    items = []
    for p in DOWNLOAD_DIR.rglob("*"):
        if p.suffix.lstrip(".").lower() not in MEDIA_EXTS or not p.is_file():
            continue
        try:
            st = p.stat()
        except OSError:
            continue
        thumb = p.with_suffix(".jpg")
        rel = p.relative_to(DOWNLOAD_DIR)
        items.append(
            {
                "name": p.stem,
                "folder": rel.parent.as_posix() if rel.parent.as_posix() != "." else "",
                "url": _media_url(p),
                "thumb": _media_url(thumb) if thumb.exists() else None,
                "size": st.st_size,
                "mtime": st.st_mtime,
            }
        )
    items.sort(key=lambda x: x["mtime"], reverse=True)
    return JSONResponse(items)


def _fmt_duration(seconds: Any) -> str:
    if not seconds:
        return ""
    s = int(seconds)
    h, m, sec = s // 3600, (s % 3600) // 60, s % 60
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m}:{sec:02d}"


def _entry_thumb(d: dict[str, Any]) -> str:
    if d.get("thumbnail"):
        return d["thumbnail"]
    thumbs = d.get("thumbnails")
    if thumbs:
        return thumbs[-1].get("url", "")
    vid = d.get("id")
    extractor = (d.get("ie_key") or d.get("extractor") or "").lower()
    if vid and "youtube" in extractor:
        return f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"
    return ""


def _video_dict(d: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": d.get("id") or "",
        "title": d.get("title") or d.get("id") or "Sans titre",
        "thumbnail": _entry_thumb(d),
        "duration": _fmt_duration(d.get("duration")),
        "channel": d.get("uploader") or d.get("channel") or "",
        "source": (d.get("ie_key") or d.get("extractor_key") or "youtube").lower(),
        "url": d.get("webpage_url") or d.get("url") or "",
        "uploaded": d.get("upload_date") or "",
    }


@app.post("/api/extract")
async def extract(req: ExtractRequest) -> JSONResponse:
    """Extract metadata for a URL (video / playlist / channel) without
    downloading — powers the paste-URL preview flow."""
    if not req.url.strip():
        return JSONResponse({"error": "URL requise"}, status_code=400)
    log: list[str] = []
    opts, temp_cookies = _common_opts(log)
    opts["extract_flat"] = "in_playlist"
    try:
        with YoutubeDL(opts) as ydl:
            info = ydl.extract_info(req.url.strip(), download=False)
    except Exception as exc:  # noqa: BLE001
        return JSONResponse({"error": str(exc)}, status_code=400)
    finally:
        if temp_cookies and os.path.exists(temp_cookies):
            os.remove(temp_cookies)

    if not info:
        return JSONResponse({"error": "Extraction échouée"}, status_code=400)

    entries = info.get("entries")
    if entries is not None:
        entries = [e for e in entries if e]
        videos = [_video_dict(e) for e in entries[:300]]
        return JSONResponse(
            {
                "kind": "playlist",
                "title": info.get("title") or "",
                "uploader": info.get("uploader") or info.get("channel") or "",
                "thumbnail": videos[0]["thumbnail"] if videos else "",
                # The channel's round avatar (distinct from a video thumbnail).
                # Falls back to a dedicated root-page fetch since the flat
                # /videos listing doesn't carry the avatar.
                "avatar": _channel_avatar(info) or _fetch_channel_avatar(req.url.strip(), log),
                "url": req.url.strip(),
                "count": len(entries),
                "videos": videos,
            }
        )
    return JSONResponse({"kind": "video", **_video_dict(info)})


@app.post("/api/channel")
async def channel_info(req: ExtractRequest) -> JSONResponse:
    """Lightweight channel metadata (name, avatar, counts) WITHOUT enumerating
    the whole back-catalogue — keeps the channel card fast. The video list is
    fetched separately/lazily via /api/extract."""
    url = req.url.strip()
    if not url:
        return JSONResponse({"error": "URL requise"}, status_code=400)
    log: list[str] = []
    opts, temp_cookies = _common_opts(log)
    opts["extract_flat"] = True
    opts["playlist_items"] = "1"  # metadata only; don't list every video
    try:
        with YoutubeDL(opts) as ydl:
            info = ydl.extract_info(_channel_root(url), download=False) or {}
    except Exception as exc:  # noqa: BLE001
        return JSONResponse({"error": str(exc)}, status_code=400)
    finally:
        if temp_cookies and os.path.exists(temp_cookies):
            os.remove(temp_cookies)
    return JSONResponse(
        {
            "name": info.get("channel") or info.get("title") or "",
            "avatar": _channel_avatar(info),
            "url": url,
            "subscribers": info.get("channel_follower_count"),
            "count": info.get("playlist_count"),
        }
    )


@app.post("/api/search")
async def search(req: SearchRequest) -> JSONResponse:
    """Search YouTube by free text and return matching videos plus the distinct
    channels behind them, so the user can pick a video or follow a creator
    without knowing the URL."""
    q = req.query.strip()
    if not q:
        return JSONResponse({"error": "Recherche vide"}, status_code=400)
    limit = max(1, min(req.limit, 30))
    log: list[str] = []
    opts, temp_cookies = _common_opts(log)
    opts["extract_flat"] = True
    try:
        with YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f"ytsearch{limit}:{q}", download=False)
    except Exception as exc:  # noqa: BLE001
        return JSONResponse({"error": str(exc)}, status_code=400)
    finally:
        if temp_cookies and os.path.exists(temp_cookies):
            os.remove(temp_cookies)

    entries = [e for e in ((info or {}).get("entries") or []) if e]
    videos = [_video_dict(e) for e in entries]

    # Distinct channels behind the results, in first-seen order. Flat entries
    # don't always include channel_url, so fall back to the channel_id.
    channels: dict[str, dict[str, str]] = {}
    for e in entries:
        cid = e.get("channel_id")
        url = (
            e.get("channel_url")
            or e.get("uploader_url")
            or (f"https://www.youtube.com/channel/{cid}" if cid else "")
        )
        name = e.get("channel") or e.get("uploader") or ""
        if url and url not in channels:
            channels[url] = {"name": name or url, "url": url}
    return JSONResponse(
        {
            "query": q,
            "videos": videos,
            "channels": list(channels.values())[:6],
        }
    )


# Mounted LAST so the API routes above take precedence; serves the built React
# SPA (index.html + hashed assets) for everything else.
app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="spa")
