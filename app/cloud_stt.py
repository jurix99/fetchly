"""Cloud speech-to-text — an OPTIONAL transcription engine behind the same
Transcriber interface as local Whisper. Default stays local; nothing leaves the
machine unless the user picks engine=cloud AND enters a key.

One protocol only: the OpenAI-compatible multipart `POST {base}/audio/transcriptions`
(covers OpenAI whisper-1/gpt-4o-transcribe, Groq whisper-large-v3-turbo, Mistral
voxtral-mini). Audio is always extracted + downsampled with ffmpeg first (mono
16 kHz AAC ~48 kbps → the video is never uploaded), then chunked if it exceeds
the provider size limit and re-stitched with overlap dedup.

Stdlib only (urllib multipart); temp audio files are always deleted.
"""

from __future__ import annotations

import difflib
import json
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Callable

_MAX_UPLOAD_BYTES = 22 * 1024 * 1024  # safety margin under the common 25 MB cap
_SLICE_SEC = 600                       # 10-minute slices when chunking
_OVERLAP_SEC = 5                       # overlap between slices (re-stitched)
_RETRIES = 2                           # extra attempts on 429/5xx
_HTTP_TIMEOUT = 300.0                  # per-request upload+transcribe budget
_AAC_BITRATE = "48k"


class CloudSTTError(Exception):
    """Actionable cloud-transcription error (surfaced as transcript_status error)."""


def _ffmpeg() -> str:
    return shutil.which("ffmpeg") or "ffmpeg"


def _ffprobe() -> str:
    return shutil.which("ffprobe") or "ffprobe"


def _run(cmd: list[str], timeout: float = 900.0) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, timeout=timeout, check=False)


# --- audio preparation -----------------------------------------------------
def _extract(src: Path, out: Path, start_s: float | None = None, len_s: float | None = None) -> None:
    """Extract mono/16 kHz/AAC audio (optionally a [start, start+len] slice)."""
    cmd = [_ffmpeg(), "-nostdin", "-y"]
    if start_s is not None:
        cmd += ["-ss", f"{start_s:.3f}"]
    cmd += ["-i", str(src)]
    if len_s is not None:
        cmd += ["-t", f"{len_s:.3f}"]
    cmd += ["-vn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", _AAC_BITRATE, str(out)]
    proc = _run(cmd)
    if proc.returncode != 0 or not out.exists() or out.stat().st_size == 0:
        tail = proc.stderr.decode("utf-8", "replace")[-300:] if proc.stderr else ""
        raise CloudSTTError(f"Extraction audio échouée (ffmpeg). {tail}")


def _probe_duration(audio: Path) -> float:
    """Audio duration in seconds; falls back to a bitrate estimate if ffprobe
    is unavailable so chunking still works."""
    try:
        proc = _run(
            [_ffprobe(), "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(audio)],
            timeout=30,
        )
        if proc.returncode == 0:
            return float(proc.stdout.decode().strip())
    except (ValueError, OSError, subprocess.SubprocessError):
        pass
    # ~48 kbps → bytes*8/48000 seconds
    try:
        return audio.stat().st_size * 8 / 48000
    except OSError:
        return 0.0


def _slice_plan(duration_s: float) -> list[tuple[float, float]]:
    """[(start_s, len_s), …] — 10-min windows, each carrying `_OVERLAP_SEC` past
    its nominal end so consecutive slices overlap for clean re-stitching."""
    plan: list[tuple[float, float]] = []
    start = 0.0
    while start < duration_s:
        length = min(_SLICE_SEC + _OVERLAP_SEC, duration_s - start)
        plan.append((start, length))
        start += _SLICE_SEC
    return plan or [(0.0, duration_s)]


# --- HTTP (multipart, retries) ---------------------------------------------
def _encode_multipart(fields: dict[str, Any], filename: str, blob: bytes, ctype: str) -> tuple[bytes, str]:
    boundary = "----fetchly" + uuid.uuid4().hex
    parts: list[bytes] = []
    for key, val in fields.items():
        values = val if isinstance(val, list) else [val]
        for v in values:
            parts.append(
                f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{v}\r\n'.encode()
            )
    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        f"Content-Type: {ctype}\r\n\r\n".encode()
    )
    parts.append(blob)
    parts.append(f"\r\n--{boundary}--\r\n".encode())
    return b"".join(parts), boundary


def _http_message(code: int, detail: str) -> str:
    if code == 401:
        return "Clé API invalide ou manquante (401)"
    if code == 403:
        return "Accès refusé (403) — clé ou droits insuffisants"
    if code == 404:
        return "Introuvable (404) — vérifiez l'URL de base et le nom du modèle"
    if code == 413:
        return "Fichier trop volumineux (413) — le découpage devrait éviter cela"
    if code == 429:
        return "Limite de débit atteinte (429)"
    hint = f" — {detail}" if detail else ""
    return f"Erreur du fournisseur (HTTP {code}){hint}"


def _post_audio(url: str, key: str, model: str, blob: bytes, filename: str, timeout: float) -> dict[str, Any]:
    fields = {
        "model": model,
        "response_format": "verbose_json",
        "timestamp_granularities[]": ["segment"],
    }
    body, boundary = _encode_multipart(fields, filename, blob, "audio/mp4")
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": f"multipart/form-data; boundary={boundary}",
    }
    last: Exception | None = None
    for attempt in range(_RETRIES + 1):
        req = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8", "replace"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:300] if hasattr(exc, "read") else ""
            if exc.code in (429, 500, 502, 503, 504) and attempt < _RETRIES:
                last = exc
                time.sleep(2 ** attempt)  # 1s, 2s backoff
                continue
            raise CloudSTTError(_http_message(exc.code, detail)) from exc
        except (urllib.error.URLError, TimeoutError) as exc:
            if attempt < _RETRIES:
                last = exc
                time.sleep(2 ** attempt)
                continue
            raise CloudSTTError(f"URL injoignable : {getattr(exc, 'reason', exc)}") from exc
        except json.JSONDecodeError as exc:
            raise CloudSTTError("Réponse illisible du fournisseur (JSON invalide)") from exc
    raise CloudSTTError(f"Échec après {_RETRIES + 1} tentatives : {last}")


# --- response parsing ------------------------------------------------------
def _parse_segments(data: dict[str, Any], offset_ms: int) -> list[tuple[int, int, str]]:
    """Map an OpenAI-compatible verbose_json response to (start_ms, end_ms, text),
    tolerant of providers that only return `words` or a bare `text`."""
    out: list[tuple[int, int, str]] = []
    segs = data.get("segments")
    if isinstance(segs, list) and segs:
        for s in segs:
            start, end, text = s.get("start"), s.get("end"), (s.get("text") or "").strip()
            if start is None or end is None or not text:
                continue
            out.append((int(float(start) * 1000) + offset_ms, int(float(end) * 1000) + offset_ms, text))
        if out:
            return out
    # Word-level fallback: group ~12 words / >0.8 s gaps into segments.
    words = data.get("words")
    if isinstance(words, list) and words:
        buf: list[str] = []
        w_start = w_end = None
        for w in words:
            ws, we = w.get("start"), w.get("end")
            token = (w.get("word") or w.get("text") or "").strip()
            if ws is None or we is None or not token:
                continue
            if w_start is None:
                w_start = ws
            gap = ws - (w_end if w_end is not None else ws)
            if buf and (len(buf) >= 12 or gap > 0.8):
                out.append((int(w_start * 1000) + offset_ms, int((w_end or ws) * 1000) + offset_ms, " ".join(buf)))
                buf, w_start = [], ws
            buf.append(token)
            w_end = we
        if buf and w_start is not None:
            out.append((int(w_start * 1000) + offset_ms, int((w_end or w_start) * 1000) + offset_ms, " ".join(buf)))
        if out:
            return out
    # Last resort: a single segment carrying the whole text (still searchable).
    text = (data.get("text") or "").strip()
    if text:
        return [(offset_ms, offset_ms + 1000, text)]
    return []


def _text_sim(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, a.lower(), b.lower()).ratio()


def _merge_overlap(slices: list[list[tuple[int, int, str]]]) -> list[tuple[int, int, str]]:
    """Concatenate per-slice segments (already absolute), dropping duplicates in
    the overlap zone at each join by timestamp + text similarity."""
    merged: list[tuple[int, int, str]] = []
    for segs in slices:
        for s in segs:
            if merged:
                prev = merged[-1]
                # Sits inside the region already covered by the previous slice.
                if s[0] < prev[1]:
                    if s[0] < prev[0] or _text_sim(s[2], prev[2]) > 0.6:
                        continue
            merged.append(s)
    return merged


# --- public: the Transcriber implementation --------------------------------
def _effective(settings: dict[str, Any]) -> tuple[str, str, str]:
    base = (settings.get("cloud_base_url") or "").strip()
    model = (settings.get("cloud_model") or "").strip()
    key = (settings.get("cloud_api_key") or "").strip()
    if not base or not model or not key:
        raise CloudSTTError("Configuration cloud incomplète (URL de base, modèle et clé requis)")
    return base, model, key


def transcribe_media(
    path: Path,
    settings: dict[str, Any],
    on_progress: Callable[[int], None] | None = None,
    cancel: Callable[[], bool] | None = None,
) -> tuple[str, list[tuple[int, int, str]]]:
    """(language, segments) via the cloud provider. Extracts audio, chunks if
    over the size cap, re-stitches. Temp files are always deleted."""
    base, model, key = _effective(settings)
    url = base.rstrip("/") + "/audio/transcriptions"
    audio = Path(tempfile.mkstemp(prefix="fetchly-stt-", suffix=".m4a")[1])
    slices_tmp: list[Path] = []
    try:
        _extract(path, audio)
        if audio.stat().st_size <= _MAX_UPLOAD_BYTES:
            data = _post_audio(url, key, model, audio.read_bytes(), audio.name, _HTTP_TIMEOUT)
            if on_progress:
                on_progress(99)
            return (data.get("language") or ""), _parse_segments(data, 0)

        # Too big → 10-min slices with 5 s overlap, sent sequentially.
        plan = _slice_plan(_probe_duration(audio))
        language = ""
        collected: list[list[tuple[int, int, str]]] = []
        for i, (start_s, len_s) in enumerate(plan):
            if cancel and cancel():
                _cancel()
            part = Path(tempfile.mkstemp(prefix="fetchly-stt-", suffix=".m4a")[1])
            slices_tmp.append(part)
            _extract(audio, part, start_s=start_s, len_s=len_s)
            data = _post_audio(url, key, model, part.read_bytes(), part.name, _HTTP_TIMEOUT)
            language = language or (data.get("language") or "")
            collected.append(_parse_segments(data, int(start_s * 1000)))
            part.unlink(missing_ok=True)
            if on_progress:
                on_progress(int((i + 1) / len(plan) * 99))
        return language, _merge_overlap(collected)
    finally:
        audio.unlink(missing_ok=True)
        for p in slices_tmp:
            p.unlink(missing_ok=True)


def _cancel() -> None:
    from . import transcribe
    raise transcribe._Canceled()


def test_connection(settings: dict[str, Any]) -> tuple[bool, str]:
    """Send 5 s of generated silence and check the provider answers. Returns
    (ok, message) for the settings 'test' button."""
    try:
        base, model, key = _effective(settings)
    except CloudSTTError as exc:
        return False, str(exc)
    url = base.rstrip("/") + "/audio/transcriptions"
    silence = Path(tempfile.mkstemp(prefix="fetchly-stt-test-", suffix=".m4a")[1])
    try:
        proc = _run([
            _ffmpeg(), "-nostdin", "-y", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono",
            "-t", "5", "-c:a", "aac", "-b:a", "32k", str(silence),
        ], timeout=60)
        if proc.returncode != 0:
            return False, "ffmpeg indisponible pour générer l'audio de test"
        _post_audio(url, key, model, silence.read_bytes(), silence.name, 60.0)
        return True, f"Connecté à {model} ({base})."
    except CloudSTTError as exc:
        return False, str(exc)
    except Exception as exc:  # noqa: BLE001
        return False, f"Erreur inattendue : {exc}"
    finally:
        silence.unlink(missing_ok=True)
