"""Builtin source plugin: YouTube (and everything else yt-dlp supports).

This is the ONLY module that imports yt_dlp. It owns option building, flat
listing, channel detection, subscription filters, extraction and the download
engine body (formerly _run_job / _download_parallel in main.py). The jobs engine
(app/jobs.py) drives status/persistence/finalize and calls `download()` here.
"""

from __future__ import annotations

import threading
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit, urlunsplit

from yt_dlp import YoutubeDL
from yt_dlp.utils import DateRange, DownloadCancelled

from ... import cookies, metadata, notify, store
from ...runtime import (
    DOWNLOAD_DIR,
    MEDIA_EXTS,
    POT_PROVIDER_URL,
    _drop_file_cache,
    _release_memory,
)
from ..base import (
    DownloadResult,
    MediaItem,
    PluginManifest,
    SettingField,
    SourcePlugin,
)

# --- Quality presets -------------------------------------------------------
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
_QUALITY_NORM: dict[str, str] = {
    "Auto": "best", "best": "best",
    "2160p": "2160", "2160": "2160", "1440p": "1440", "1440": "1440",
    "1080p": "1080", "1080": "1080", "720p": "720", "720": "720",
    "480p": "480", "480": "480",
    "Audio seul": "audio", "audio": "audio",
}
_QUALITY_HEIGHT = {"480": 480, "720": 720, "1080": 1080, "1440": 1440, "2160": 2160}

ORGANIZE_TEMPLATES = {
    "uploader": "%(uploader,channel,extractor_key)s/%(title)s [%(id)s].%(ext)s",
    "playlist": "%(playlist_title,uploader,channel,extractor_key)s/%(title)s [%(id)s].%(ext)s",
    "flat": "%(title)s [%(id)s].%(ext)s",
}


def _format_opts(quality: str, fmt: str) -> dict[str, Any]:
    """Translate a frontend quality + container choice into yt-dlp options."""
    fmt = (fmt or "MP4").upper()
    q = _QUALITY_NORM.get(quality, "best")
    s = store.get_settings()
    audio = q == "audio" or fmt in ("MP3", "M4A")

    pps: list[dict[str, Any]] = [{"key": "FFmpegThumbnailsConvertor", "format": "jpg"}]
    opts: dict[str, Any] = {"writethumbnail": True}

    if audio:
        codec = "mp3" if fmt == "MP3" else "m4a"
        opts["format"] = "bestaudio/best"
        pps.insert(0, {"key": "FFmpegExtractAudio", "preferredcodec": codec})
    else:
        height = _QUALITY_HEIGHT.get(q)
        if height:
            selector = (
                f"bv*[height<=?{height}][vcodec^=avc1]+ba[acodec^=mp4a]/"
                f"bv*[height<=?{height}]+ba[acodec^=mp4a]/"
                f"bv*[height<=?{height}]+ba/b[height<=?{height}]/b"
            )
        else:
            selector = "bv*+ba[acodec^=mp4a]/bv*+ba/b"
        opts["format"] = selector
        opts["merge_output_format"] = "mkv" if fmt == "MKV" else "mp4"
        if s.get("subtitles"):
            langs = (s.get("subtitle_langs") or "fr,en").strip()
            opts["writesubtitles"] = True
            opts["writeautomaticsub"] = True
            opts["subtitleslangs"] = (
                ["all"] if langs == "all" else [x.strip() for x in langs.split(",") if x.strip()]
            )
            if s.get("embed_subtitles"):
                pps.append({"key": "FFmpegEmbedSubtitle"})

    if s.get("sponsorblock"):
        cats = ["sponsor", "selfpromo", "interaction"]
        pps.append({"key": "SponsorBlock", "categories": cats, "api": "https://sponsor.ajay.app"})
        if s.get("sponsorblock_mode") != "mark":
            pps.append({"key": "ModifyChapters", "remove_sponsor_segments": cats})

    add_meta = bool(s.get("embed_metadata"))
    add_chapters = bool(s.get("embed_chapters")) or (
        s.get("sponsorblock") and s.get("sponsorblock_mode") == "mark"
    )
    if add_meta or add_chapters:
        pps.append({"key": "FFmpegMetadata", "add_metadata": add_meta, "add_chapters": add_chapters})

    if s.get("embed_thumbnail"):
        pps.append({"key": "EmbedThumbnail", "already_have_thumbnail": True})

    opts["postprocessors"] = pps
    return opts


def _outtmpl(dest: str) -> str:
    organize = store.get_settings()["organize"]
    tmpl = ORGANIZE_TEMPLATES.get(organize, ORGANIZE_TEMPLATES["playlist"])
    base = DOWNLOAD_DIR
    if dest:
        safe = dest.strip().strip("/\\").replace("..", "")
        if safe:
            base = DOWNLOAD_DIR / safe
    return str(base / tmpl)


def _common_opts(log: list[str]) -> tuple[dict[str, Any], str | None]:
    """Options shared by every yt-dlp call: cookies, PO-token provider, clients."""
    opts: dict[str, Any] = {
        "ignoreerrors": True,
        "quiet": True,
        "no_warnings": True,
        "retries": 5,
        "nocheckcertificate": True,
        "extractor_args": {
            "youtube": {"player_client": ["default", "web_safari", "mweb", "tv"]},
            "youtubepot-bgutilhttp": {"base_url": [POT_PROVIDER_URL]},
        },
    }
    try:
        bw = float(store.get_settings().get("bandwidth_limit") or 0)
    except (TypeError, ValueError):
        bw = 0
    if bw > 0:
        opts["ratelimit"] = int(bw * 1_000_000)

    temp_cookies = cookies.prepare()
    if temp_cookies:
        opts["cookiefile"] = temp_cookies
        log.append("Using cookies file for authentication.")
    else:
        log.append(
            "No cookies file found. If YouTube blocks with a bot check, add a "
            "cookies.txt in Settings → Cookies (see README)."
        )
    return opts, temp_cookies


def _log_available_formats(ydl: YoutubeDL, video_url: str, job: Any) -> None:
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


# --- Listing / channel detection ------------------------------------------
def _flat_list(url: str, log: list[str]) -> list[dict[str, Any]]:
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
        cookies.commit(cookie)


_CHANNEL_TABS = ("videos", "shorts", "streams", "live", "playlists", "featured", "community")


def _is_channel_url(url: str) -> bool:
    u = url.lower()
    return "/@" in u or "/channel/" in u or "/c/" in u or "/user/" in u


def _channel_root(url: str) -> str:
    try:
        parts = urlsplit(url)
        segs = [s for s in parts.path.split("/") if s and s.lower() not in _CHANNEL_TABS]
        return urlunsplit((parts.scheme, parts.netloc, "/" + "/".join(segs), "", ""))
    except Exception:  # noqa: BLE001
        return url


def _fetch_channel_avatar(url: str, log: list[str]) -> str:
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
        cookies.commit(temp_cookies)


def _channel_avatar(info: dict[str, Any]) -> str:
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


def _entry_avatar(e: dict[str, Any]) -> str:
    thumbs = e.get("thumbnails")
    if thumbs:
        return thumbs[-1].get("url", "")
    return e.get("thumbnail") or ""


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


def _fmt_duration(seconds: Any) -> str:
    if not seconds:
        return ""
    s = int(seconds)
    h, m, sec = s // 3600, (s % 3600) // 60, s % 60
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m}:{sec:02d}"


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


def _watch_sources(url: str, exclude_shorts: bool = False) -> list[str]:
    if _is_channel_url(url):
        root = _channel_root(url).rstrip("/")
        srcs = [f"{root}/videos"]
        if not exclude_shorts:
            srcs.append(f"{root}/shorts")
        return srcs
    return [url]


_LIVE_STATUSES = frozenset({"is_live", "is_upcoming", "post_live", "was_live"})


def _is_live_entry(e: dict[str, Any]) -> bool:
    return str(e.get("live_status") or "").lower() in _LIVE_STATUSES


def _archive_ids() -> set[str]:
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


# --- Subscription filters --------------------------------------------------
_DEFAULT_FILTERS: dict[str, Any] = {
    "min_duration": None,
    "max_duration": None,
    "exclude_shorts": False,
    "exclude_lives": False,
    "include_keywords": [],
    "exclude_keywords": [],
    "keep_last_n": None,
}


def _norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    return s.casefold()


def watch_filters(watch: dict[str, Any]) -> dict[str, Any]:
    """Normalized filters for a watch (retro-compatible with pre-filter watches)."""
    f = dict(_DEFAULT_FILTERS)
    stored = watch.get("filters")
    if isinstance(stored, dict):
        for k in f:
            if stored.get(k) is not None:
                f[k] = stored[k]
    else:
        f["exclude_shorts"] = bool(watch.get("exclude_shorts"))
        f["exclude_lives"] = bool(watch.get("exclude_lives"))
    f["include_keywords"] = [k for k in (f["include_keywords"] or []) if str(k).strip()]
    f["exclude_keywords"] = [k for k in (f["exclude_keywords"] or []) if str(k).strip()]
    return f


def passes_filters(entry: dict[str, Any], f: dict[str, Any]) -> tuple[bool, str]:
    """(ok, reason). reason ∈ duration|short|live|keyword|"". Missing metadata is
    never a rejection here (the download-time match_filter is the safety net)."""
    title = entry.get("title") or ""
    nt = _norm(title)
    dur = entry.get("duration")
    has_dur = isinstance(dur, (int, float)) and dur
    url = (
        entry.get("original_url")
        or entry.get("webpage_url")
        or entry.get("url")
        or ""
    ).lower()

    if f.get("exclude_shorts") and ("/shorts/" in url or (has_dur and dur <= 60)):
        return False, "short"
    if f.get("exclude_lives") and _is_live_entry(entry):
        return False, "live"
    if has_dur:
        mn, mx = f.get("min_duration"), f.get("max_duration")
        if mn and dur < mn:
            return False, "duration"
        if mx and dur > mx:
            return False, "duration"
    excl = [_norm(k) for k in (f.get("exclude_keywords") or []) if str(k).strip()]
    incl = [_norm(k) for k in (f.get("include_keywords") or []) if str(k).strip()]
    if excl and any(k in nt for k in excl):
        return False, "keyword"
    if incl and not any(k in nt for k in incl):
        return False, "keyword"
    return True, ""


def make_match_filter(f: dict[str, Any]) -> Callable:
    def match(info: dict[str, Any], *, incomplete: bool = False) -> str | None:
        ok, reason = passes_filters(info, f)
        return None if ok else f"filtré ({reason})"
    return match


# --- Watch listing / seeding ----------------------------------------------
def collect_new(
    watch: dict[str, Any], log: list[str], filters: dict[str, Any]
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """New (un-archived) videos for a watch, filtered. Returns (entries, stats)."""
    after = (watch.get("date_after") or "").replace("-", "")
    exclude_shorts = bool(filters.get("exclude_shorts"))
    archived = _archive_ids()
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    listed = 0
    rejected = 0

    def keep(e: dict[str, Any]) -> bool:
        nonlocal rejected
        ok, _reason = passes_filters(e, filters)
        if not ok:
            rejected += 1
        return ok

    for src in _watch_sources(watch["url"], exclude_shorts):
        candidates = [
            e
            for e in _flat_list(src, log)
            if e.get("id") and e["id"] not in archived and e["id"] not in seen
        ]
        listed += len(candidates)
        if not after:
            for e in candidates:
                seen.add(e["id"])
                if keep(e):
                    out.append(e)
            continue
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
                    if keep(meta or e):
                        out.append(e)
        finally:
            cookies.commit(cookie)
    return out, {"listed": listed, "rejected": rejected}


def seed_archive(watch: dict[str, Any], log: list[str]) -> list[dict[str, Any]]:
    """Record a watch's existing videos into the archive WITHOUT downloading."""
    f = watch_filters(watch)
    exclude_shorts = bool(f.get("exclude_shorts"))
    exclude_lives = bool(f.get("exclude_lives"))
    entries: list[dict[str, Any]] = []
    for src in _watch_sources(watch["url"], exclude_shorts):
        entries.extend(
            e for e in _flat_list(src, log) if not (exclude_lives and _is_live_entry(e))
        )
    with store.ARCHIVE_FILE.open("a", encoding="utf-8") as f2:
        for entry in entries:
            if entry.get("id"):
                f2.write(f"youtube {entry['id']}\n")
    return entries


def fetch_channel_avatar(url: str, log: list[str]) -> str:
    return _fetch_channel_avatar(url, log)


def _entry_to_item(e: dict[str, Any]) -> MediaItem:
    url = e.get("webpage_url") or e.get("url") or e.get("id") or ""
    return MediaItem(
        id=e.get("id") or "",
        source="youtube",
        url=url,
        title=e.get("title") or "",
        duration=e.get("duration"),
        is_live=_is_live_entry(e),
        thumbnail=_entry_thumb(e),
        extra=e,
    )


def _result_to_item(result: dict[str, Any], final: str) -> MediaItem:
    """Rich per-file MediaItem from a completed yt-dlp download (feeds the
    pipeline: NFO generation, media-center output, …)."""
    return MediaItem(
        id=result.get("id") or "",
        source="youtube",
        url=result.get("webpage_url") or "",
        title=result.get("title") or Path(final).stem,
        duration=result.get("duration"),
        uploaded_at=str(result.get("upload_date") or ""),
        is_live=bool(result.get("is_live")),
        thumbnail=result.get("thumbnail") or "",
        description=result.get("description") or "",
        channel=result.get("uploader") or result.get("channel") or "",
        channel_url=result.get("channel_url") or result.get("uploader_url") or "",
        filepath=final,
        extra={"channel_id": result.get("channel_id") or ""},
    )


# --- Download engine (formerly _run_job / _download_parallel) --------------
def _download_parallel(
    job: Any, targets: list[dict[str, Any]], concurrency: int,
    on_progress: Callable | None, result_paths: list[str],
    result_items: list[MediaItem],
) -> None:
    speeds: dict[str, float] = {}
    lock = threading.Lock()
    DATE_STOP_AFTER = 3

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
                eid = entry.get("id")
                if eid and eid in job.done_ids:
                    job.completed += 1
                    continue
                if job.use_archive and probe.in_download_archive(entry):
                    job.completed += 1
                    continue
                new_entries.append(entry)
    finally:
        cookies.commit(probe_cookie)

    def aggregate() -> None:
        with lock:
            job.current_speed = (
                f"{sum(speeds.values()) / 1_000_000:.1f} MB/s" if speeds else ""
            )
            if len(speeds):
                job.current_title = f"{len(speeds)} vidéo(s) en cours…"

    def work(entry: dict[str, Any]) -> str:
        if job.pause_event.is_set() or job.cancel_event.is_set():
            return "aborted"
        vid = str(entry.get("id") or id(entry))
        video_url = entry.get("webpage_url") or entry.get("url") or entry.get("id")
        title = entry.get("title", "")
        thumb = _entry_thumb(entry)
        if thumb:
            job.current_thumbnail = thumb

        def hook(d: dict[str, Any]) -> None:
            tmp = d.get("tmpfilename")
            if tmp:
                job.partials.add(tmp)
            if job.pause_event.is_set() or job.cancel_event.is_set():
                raise DownloadCancelled()
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
                "concurrent_fragment_downloads": 2,
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
                    job.output_dir = str(Path(final).parent)
                    result_paths.append(final)
                    result_items.append(_result_to_item(result, final))
                    job.downloaded += 1
                    if entry.get("id"):
                        job.done_ids.append(entry["id"])
                job.log.append(f"Downloaded: {title}")
                _drop_file_cache(final)
                metadata.write_sidecar(final, result)
                notify.notify_video_downloaded(
                    title, entry.get("uploader") or entry.get("channel") or ""
                )
                status = "downloaded"
            else:
                job.log.append(f"Skipped: {title}")
        except DownloadCancelled:
            return "aborted"
        except Exception as exc:  # noqa: BLE001
            job.log.append(f"Failed: {title} ({exc})")
            with lock:
                job.failed += 1
            notify.notify_video_failed(title, str(exc))
            status = "failed"
        finally:
            cookies.discard(w_cookie)
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
        job.total = max(job.completed, 1)


def run_download(job: Any, on_progress: Callable | None = None) -> DownloadResult:
    """Download the job's target(s) — the body of the former _run_job (status /
    persistence / finalize stay in app/jobs.py). Mutates job progress in place.
    Interrupts (pause/cancel) surface via job.pause_event / job.cancel_event and
    leave the loop cleanly; the caller finalizes based on those events."""
    result_paths: list[str] = []
    result_items: list[MediaItem] = []

    def progress_hook(d: dict[str, Any]) -> None:
        tmp = d.get("tmpfilename")
        if tmp:
            job.partials.add(tmp)
        if job.pause_event.is_set() or job.cancel_event.is_set():
            raise DownloadCancelled()
        if d["status"] == "downloading":
            job.phase = "downloading"
            info = d.get("info_dict", {})
            job.current_title = info.get("title", job.current_title)
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            downloaded = d.get("downloaded_bytes", 0)
            job.current_percent = (downloaded / total * 100) if total else 0.0
            speed = d.get("speed")
            job.current_speed = f"{speed / 1_000_000:.1f} MB/s" if speed else ""
            if on_progress:
                on_progress(job)
        elif d["status"] == "finished":
            job.current_percent = 100.0

    def postprocessor_hook(d: dict[str, Any]) -> None:
        if job.pause_event.is_set() or job.cancel_event.is_set():
            raise DownloadCancelled()
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
            "allow_playlist_files": False,
            **_format_opts(job.quality, job.fmt),
        }
    )
    if job.use_archive:
        ydl_opts["download_archive"] = str(store.ARCHIVE_FILE)
    if job.date_after:
        ydl_opts["daterange"] = DateRange(job.date_after.replace("-", ""), None)
    if job.filters:
        ydl_opts["match_filter"] = make_match_filter(job.filters)

    try:
        list_opts, list_cookies = _common_opts(job.log)
        list_opts["extract_flat"] = "in_playlist"
        try:
            with YoutubeDL(list_opts) as lydl:
                info = lydl.extract_info(job.url, download=False)
        finally:
            cookies.commit(list_cookies)

        entries = info.get("entries") if info else None
        if entries is not None:
            entries = [e for e in entries if e]
            job.total = len(entries)
            job.playlist_title = (info or {}).get("title", "")
            job.log.append(f"Found {job.total} videos.")
        else:
            job.total = 1
        targets = entries if entries is not None else [info]

        concurrency = max(1, int(store.get_settings().get("max_concurrent", 3) or 3))
        if entries is not None and concurrency > 1:
            job.log.append(f"Downloading up to {concurrency} videos in parallel.")
            _download_parallel(job, targets, concurrency, on_progress, result_paths, result_items)
        else:
            date_misses = 0
            DATE_STOP_AFTER = 3
            aborted = False
            with YoutubeDL(ydl_opts) as ydl:
                for entry in targets:
                    if job.pause_event.is_set() or job.cancel_event.is_set():
                        aborted = True
                        break
                    if not entry:
                        job.completed += 1
                        continue
                    eid = entry.get("id")
                    if eid and eid in job.done_ids:
                        job.completed += 1
                        continue
                    if job.use_archive and ydl.in_download_archive(entry):
                        job.completed += 1
                        date_misses = 0
                        continue
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
                            job.output_dir = str(Path(final).parent)
                            result_paths.append(final)
                            result_items.append(_result_to_item(result, final))
                            job.downloaded += 1
                            if eid:
                                job.done_ids.append(eid)
                            title = result.get("title") or entry.get("title", "")
                            job.log.append(f"Downloaded: {title}")
                            _drop_file_cache(final)
                            metadata.write_sidecar(final, result)
                            notify.notify_video_downloaded(
                                title, result.get("uploader") or result.get("channel") or ""
                            )
                    except DownloadCancelled:
                        aborted = True
                        break
                    except Exception as exc:  # noqa: BLE001
                        job.log.append(f"Failed: {entry.get('title', '')} ({exc})")
                        job.failed += 1
                        notify.notify_video_failed(entry.get("title", ""), str(exc))
                        if "Requested format" in str(exc):
                            _log_available_formats(ydl, video_url, job)
                    finally:
                        if not aborted:
                            job.completed += 1
    finally:
        cookies.commit(temp_cookies)
        _release_memory()

    item = result_items[0] if len(result_items) == 1 else MediaItem(
        id=job.id,
        source="youtube",
        url=job.url,
        title=job.playlist_title or job.current_title,
        thumbnail=job.current_thumbnail,
    )
    return DownloadResult(
        item=item, filepaths=result_paths, items=result_items, job_id=job.id
    )


# --- Extraction (rich shapes consumed by the routes/frontend) --------------
def extract_url(url: str, limit: int | None = None) -> dict[str, Any]:
    log: list[str] = []
    opts, temp_cookies = _common_opts(log)
    opts["extract_flat"] = "in_playlist"
    if limit:
        opts["playlist_items"] = f"1:{max(1, int(limit))}"
        opts["lazy_playlist"] = True
    try:
        with YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as exc:  # noqa: BLE001
        return {"error": str(exc)}
    finally:
        cookies.commit(temp_cookies)

    if not info:
        return {"error": "Extraction échouée"}
    entries = info.get("entries")
    if entries is not None:
        entries = [e for e in entries if e]
        videos = [_video_dict(e) for e in entries[:300]]
        return {
            "kind": "playlist",
            "title": info.get("title") or "",
            "uploader": info.get("uploader") or info.get("channel") or "",
            "thumbnail": videos[0]["thumbnail"] if videos else "",
            "avatar": _channel_avatar(info) or _fetch_channel_avatar(url, log),
            "url": url,
            "count": len(entries),
            "videos": videos,
        }
    return {"kind": "video", **_video_dict(info)}


def channel_info(url: str) -> dict[str, Any]:
    log: list[str] = []
    opts, temp_cookies = _common_opts(log)
    opts["extract_flat"] = True
    opts["playlist_items"] = "1"
    try:
        with YoutubeDL(opts) as ydl:
            info = ydl.extract_info(_channel_root(url), download=False) or {}
    except Exception as exc:  # noqa: BLE001
        return {"error": str(exc)}
    finally:
        cookies.commit(temp_cookies)
    return {
        "name": info.get("channel") or info.get("title") or "",
        "avatar": _channel_avatar(info),
        "url": url,
        "subscribers": info.get("channel_follower_count"),
        "count": info.get("playlist_count"),
    }


def channel_videos(url: str, offset: int, limit: int) -> dict[str, Any]:
    target = _channel_root(url).rstrip("/") + "/videos" if _is_channel_url(url) else url
    limit = max(1, min(limit, 50))
    start = max(0, offset) + 1
    end = max(0, offset) + limit
    log: list[str] = []
    opts, temp_cookies = _common_opts(log)
    opts["extract_flat"] = "in_playlist"
    opts["lazy_playlist"] = True
    opts["playlist_items"] = f"{start}:{end}"
    try:
        with YoutubeDL(opts) as ydl:
            info = ydl.extract_info(target, download=False)
    except Exception as exc:  # noqa: BLE001
        return {"error": str(exc)}
    finally:
        cookies.commit(temp_cookies)
    entries = [e for e in ((info or {}).get("entries") or []) if e]
    videos = [_video_dict(e) for e in entries]
    return {"videos": videos, "offset": offset, "limit": limit, "has_more": len(videos) >= limit}


def search(query: str, limit: int) -> dict[str, Any]:
    limit = max(1, min(limit, 30))
    log: list[str] = []
    opts, temp_cookies = _common_opts(log)
    opts["extract_flat"] = True
    try:
        with YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f"ytsearch{limit}:{query}", download=False)
    except Exception as exc:  # noqa: BLE001
        return {"error": str(exc)}
    finally:
        cookies.commit(temp_cookies)
    entries = [e for e in ((info or {}).get("entries") or []) if e]
    videos = [_video_dict(e) for e in entries]
    channels: dict[str, dict[str, str]] = {}
    for e in entries:
        cid = e.get("channel_id")
        curl = (
            e.get("channel_url")
            or e.get("uploader_url")
            or (f"https://www.youtube.com/channel/{cid}" if cid else "")
        )
        name = e.get("channel") or e.get("uploader") or ""
        if curl and curl not in channels:
            channels[curl] = {"name": name or curl, "url": curl}
    return {"query": query, "videos": videos, "channels": list(channels.values())[:6]}


def list_subscribed_channels(log: list[str], cap: int = 500) -> list[dict[str, str]]:
    channels: dict[str, dict[str, str]] = {}

    def add(url: str, name: str, avatar: str = "") -> None:
        url = (url or "").strip()
        if url and url not in channels:
            channels[url] = {"url": url, "name": (name or url).strip(), "avatar": avatar or ""}

    for e in _flat_list("https://www.youtube.com/feed/channels", log):
        add(
            e.get("url") or e.get("channel_url") or e.get("uploader_url") or "",
            e.get("title") or e.get("channel") or e.get("uploader") or "",
            _entry_avatar(e),
        )
    if not channels:
        opts, cookie = _common_opts(log)
        opts["extract_flat"] = "in_playlist"
        opts["playlist_items"] = f"1:{cap}"
        opts["lazy_playlist"] = True
        try:
            with YoutubeDL(opts) as ydl:
                info = ydl.extract_info(":ytsubscriptions", download=False)
            for e in [e for e in ((info or {}).get("entries") or []) if e]:
                cid = e.get("channel_id")
                add(
                    e.get("channel_url")
                    or e.get("uploader_url")
                    or (f"https://www.youtube.com/channel/{cid}" if cid else ""),
                    e.get("channel") or e.get("uploader") or "",
                )
        except Exception as exc:  # noqa: BLE001
            log.append(f"subscriptions feed: {exc}")
        finally:
            cookies.commit(cookie)
    return list(channels.values())


# --- The plugin ------------------------------------------------------------
class YtdlpSource(SourcePlugin):
    MANIFEST = PluginManifest(
        id="ytdlp",
        name="YouTube (yt-dlp)",
        version="1.0.0",
        type="source",
        description="Source par défaut : extraction et téléchargement via yt-dlp (YouTube et 1000+ sites).",
        critical=True,  # the core source — cannot be disabled from the UI
        settings_schema=[
            SettingField(
                key="concurrent_fragments",
                type="int",
                label="Fragments simultanés",
                help="Nombre de fragments téléchargés en parallèle par vidéo (avancé).",
                default=4,
            ),
        ],
    )

    def capabilities(self) -> dict[str, Any]:
        return {"search": True, "channels": True, "playlists": True, "watches": True}

    def can_handle(self, url: str) -> bool:
        # yt-dlp is the catch-all source: it accepts any http(s) URL (and the
        # special ":ytsubscriptions" pseudo-URL). More specific sources, if added
        # later, are resolved first by the registry.
        u = (url or "").strip().lower()
        return u.startswith("http") or u.startswith(":yt")

    def extract(self, url: str) -> MediaItem | list[MediaItem]:
        data = extract_url(url)
        if data.get("kind") == "playlist":
            return [
                MediaItem(id=v["id"], source="youtube", url=v["url"], title=v["title"],
                          thumbnail=v["thumbnail"])
                for v in data.get("videos", [])
            ]
        return MediaItem(id=data.get("id", ""), source="youtube", url=data.get("url", url),
                         title=data.get("title", ""), thumbnail=data.get("thumbnail", ""))

    def list_new(self, watch: dict[str, Any]) -> list[MediaItem]:
        items, _stats = self.list_new_detailed(watch)
        return items

    def list_new_detailed(self, watch: dict[str, Any]) -> tuple[list[MediaItem], dict[str, int]]:
        log: list[str] = []
        filters = watch_filters(watch)
        entries, stats = collect_new(watch, log, filters)
        return [_entry_to_item(e) for e in entries], stats

    def download(self, job: Any, hooks: dict[str, Callable]) -> DownloadResult:
        return run_download(job, (hooks or {}).get("on_progress"))
