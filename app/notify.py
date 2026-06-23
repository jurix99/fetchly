"""Push a notification when a video finishes downloading.

Built on Apprise (https://github.com/caronc/apprise): one library that talks to
100+ services — Discord, Telegram, email, ntfy, Pushover, Slack, SMS (Twilio /
Vonage), etc. — each configured as a single URL. The user stores those URLs in
config.json (see store.get_notifications); we fan a message out to all of them.

All sending is fire-and-forget and failure-tolerant: a bad notification URL or a
network hiccup must never break or slow a download.
"""

from __future__ import annotations

import threading

from . import store

try:  # Apprise is optional at import time so the app still boots without it.
    import apprise
except Exception:  # noqa: BLE001
    apprise = None  # type: ignore[assignment]


def available() -> bool:
    return apprise is not None


def _build(urls: list[str]):
    """An Apprise bag loaded with the given service URLs, or None if unusable."""
    if apprise is None or not urls:
        return None
    ap = apprise.Apprise()
    for url in urls:
        ap.add(url)
    return ap if len(ap) else None


def _dispatch(title: str, body: str, urls: list[str]) -> None:
    ap = _build(urls)
    if ap is None:
        return
    try:
        ap.notify(title=title, body=body)
    except Exception:  # noqa: BLE001
        pass  # never let a notification failure surface to the caller


def _fire(event: str, title: str, body: str) -> None:
    """Send `title`/`body` to all services if notifications are on and the given
    event is enabled. Runs on a background thread so a download is never blocked
    on network I/O."""
    cfg = store.get_notifications()
    if not cfg["enabled"] or not cfg["urls"] or not cfg.get(event, False):
        return
    threading.Thread(
        target=_dispatch, args=(title, body, list(cfg["urls"])), daemon=True
    ).start()


def notify_video_downloaded(title: str, channel: str = "") -> None:
    """Alert that one video finished downloading (event: on_video)."""
    _fire("on_video", "✅ Vidéo téléchargée", f"{title}\n— {channel}" if channel else title)


def notify_video_failed(title: str, error: str = "") -> None:
    """Alert that a download failed (event: on_error)."""
    body = title if not error else f"{title}\n{error}"
    _fire("on_error", "❌ Échec de téléchargement", body)


def notify_job_summary(label: str, downloaded: int, failed: int = 0) -> None:
    """One digest at the end of a playlist/batch (event: on_summary)."""
    parts = [f"{downloaded} téléchargée(s)"]
    if failed:
        parts.append(f"{failed} échec(s)")
    body = f"{label}\n{' · '.join(parts)}" if label else " · ".join(parts)
    _fire("on_summary", "📦 Téléchargement terminé", body)


def notify_disk_low(free_gb: float, floor_gb: float) -> None:
    """Alert that the downloads volume is running low on space."""
    cfg = store.get_notifications()
    if not cfg["enabled"] or not cfg["urls"]:
        return
    body = f"Espace libre : {free_gb} Go (seuil {floor_gb} Go). Les téléchargements sont suspendus."
    threading.Thread(
        target=_dispatch,
        args=("⚠️ Disque presque plein", body, list(cfg["urls"])),
        daemon=True,
    ).start()


def send_test(urls: list[str]) -> tuple[bool, str]:
    """Send a test notification synchronously and report the outcome, so the UI
    can tell the user whether their service URLs actually work."""
    if apprise is None:
        return False, "Apprise n'est pas installé sur le serveur."
    cleaned = [u.strip() for u in urls if u and u.strip()]
    if not cleaned:
        return False, "Aucune URL de service configurée."
    ap = _build(cleaned)
    if ap is None:
        return False, "Aucune URL valide (vérifie le format, ex. discord://…)."
    try:
        ok = ap.notify(
            title="🔔 Fetchly — test",
            body="Si tu lis ceci, les notifications fonctionnent !",
        )
    except Exception as exc:  # noqa: BLE001
        return False, f"Échec de l'envoi : {exc}"
    return (True, "Notification de test envoyée.") if ok else (
        False,
        "L'envoi a échoué — vérifie tes URLs de service.",
    )
