"""Digest — the Bibliothèque "since your last visit" section + optional weekly
e-mail. Strictly chronological and grouped (day → subscription): it's a TiVo,
not a feed. No opaque ranking anywhere.

Reuses indexer.related() for the "echoes" (a new content resurfacing an old one),
and Apprise (notify.py) for the optional e-mail. Everything degrades gracefully:
no provider → items show without a summary; nothing new → a calm "up to date".
"""

from __future__ import annotations

import html
import time
from collections import OrderedDict
from datetime import datetime, timezone
from typing import Any

from . import db, indexer, library, store

_DEFAULT_WINDOW_S = 7 * 86400   # when there's no prior visit, show the last week
_ECHO_MIN_AGE_S = 60 * 86400    # an "echo" old content must be >60 days old
_ECHO_MIN_SCORE = 0.6           # similarity floor for an echo
_ECHO_MAX = 3                   # never more than 3 echoes (discreet)
_DESC_FALLBACK_LEN = 180


# --- helpers ---------------------------------------------------------------
def _since_ts() -> float:
    """Epoch of the last visit, or a 1-week window when never visited."""
    raw = store.get_digest().get("last_seen_at") or ""
    if raw:
        try:
            return datetime.fromisoformat(raw).timestamp()
        except ValueError:
            pass
    return time.time() - _DEFAULT_WINDOW_S


def _truncate(text: str, n: int) -> str:
    text = (text or "").strip().replace("\n", " ")
    return text if len(text) <= n else text[:n].rstrip() + "…"


def _card(row: dict[str, Any]) -> dict[str, Any]:
    """A compact content card for the digest (summary_short, else truncated desc)."""
    summary = row.get("summary_short") or _truncate(row.get("description") or "", _DESC_FALLBACK_LEN)
    return {
        "id": row["id"],
        "title": row.get("title") or "",
        "channel": row.get("channel") or "",
        "source": row.get("source") or "",
        "duration_seconds": row.get("duration_seconds"),
        "thumbnail_url": library._media_url(row.get("thumbnail_path")),
        "summary_short": summary,
        "transcript_status": row.get("transcript_status") or "none",
        "generation_status": row.get("generation_status") or "none",
        "watch_id": row.get("watch_id"),
        "watch_later": bool(row.get("watch_later")),
        "downloaded_at": row.get("downloaded_at"),
    }


def _watch_meta(watch_id: str | None) -> dict[str, Any]:
    if not watch_id:
        return {"watch_id": None, "name": "Téléchargements manuels", "avatar": ""}
    w = store.get_watch(watch_id) or {}
    return {
        "watch_id": watch_id,
        "name": w.get("title") or "Abonnement",
        "avatar": w.get("thumbnail") or "",
    }


# --- new (grouped day → subscription) --------------------------------------
def _group_new(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Day (desc) → subscription (first-seen order) → items (desc). Predictable:
    rows already arrive newest-first from the DB, we only bucket them."""
    days: "OrderedDict[str, OrderedDict[str, list[dict[str, Any]]]]" = OrderedDict()
    for r in rows:
        dl = r.get("downloaded_at") or 0
        day = datetime.fromtimestamp(dl).date().isoformat() if dl else "—"
        wk = r.get("watch_id") or "__manual__"
        days.setdefault(day, OrderedDict()).setdefault(wk, []).append(r)

    out = []
    for day, subs in days.items():
        groups = []
        for wk, items in subs.items():
            meta = _watch_meta(None if wk == "__manual__" else wk)
            groups.append({**meta, "count": len(items), "items": [_card(r) for r in items]})
        out.append({"date": day, "subscriptions": groups})
    return out


# --- echoes (memory resurfacing) -------------------------------------------
def _echoes(new_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """For each new, indexed content, surface an OLD (>60 d) content it echoes,
    reusing indexer.related(). Deduped by pair, capped at _ECHO_MAX."""
    echoes: list[dict[str, Any]] = []
    seen_pairs: set[frozenset[str]] = set()
    now = time.time()
    for row in new_rows:
        if len(echoes) >= _ECHO_MAX:
            break
        if row.get("index_status") != "done":
            continue
        try:
            related = indexer.related(row["id"], limit=5).get("results", [])
        except Exception:  # noqa: BLE001 — echoes never break the digest
            continue
        for cand in related:
            if cand.get("score", 0) < _ECHO_MIN_SCORE or not cand.get("pair"):
                continue
            old = db.content_get(cand["id"])
            if not old:
                continue
            age = now - (old.get("downloaded_at") or now)
            if age < _ECHO_MIN_AGE_S:
                continue
            key = frozenset({row["id"], cand["id"]})
            if key in seen_pairs:
                continue
            seen_pairs.add(key)
            echoes.append({
                "new": _card(row),
                "old": _card(old),
                "pair": cand["pair"],  # {a_start_ms/a_text = new, b_start_ms/b_text = old}
                "score": cand["score"],
            })
            break  # one echo per new content
        if len(echoes) >= _ECHO_MAX:
            break
    return echoes


# --- public: build the digest ----------------------------------------------
def build(since_ts: float | None = None) -> dict[str, Any]:
    since = since_ts if since_ts is not None else _since_ts()
    rows = db.digest_new(since)
    watches = {r.get("watch_id") for r in rows if r.get("watch_id")}
    stats = {
        "count": len(rows),
        "total_duration_s": int(sum(r.get("duration_seconds") or 0 for r in rows)),
        "watches_count": len(watches),
    }
    return {
        "since": since,
        "stats": stats,
        "new": _group_new(rows),
        "echoes": _echoes(rows),
        "watch_later": [_card(r) for r in db.watch_later_list()],
    }


def new_count() -> int:
    return db.digest_new_count(_since_ts())


def mark_all_seen() -> None:
    """Advance the visit marker so the digest empties (badge clears)."""
    store.set_digest_key("last_seen_at", datetime.now(timezone.utc).isoformat())


# --- weekly e-mail ---------------------------------------------------------
def _fmt_duration(seconds: int) -> str:
    seconds = int(seconds or 0)
    h, m = seconds // 3600, (seconds % 3600) // 60
    return f"{h} h {m:02d}" if h else f"{m} min"


def _deep_link(base: str, content_id: str) -> str:
    return f"{base.rstrip('/')}/?content={html.escape(content_id, quote=True)}"


def build_email_html(digest: dict[str, Any], base_url: str) -> str:
    """A sober HTML e-mail: text logo, stats, top items per subscription with
    summary_short and deep links. No images beyond nothing, no tracking."""
    st = digest["stats"]
    accroche = (
        f"{st['count']} nouveauté{'s' if st['count'] != 1 else ''} · "
        f"{_fmt_duration(st['total_duration_s'])} · "
        f"{st['watches_count']} chaîne{'s' if st['watches_count'] != 1 else ''}"
    )
    parts: list[str] = [
        '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;'
        'max-width:640px;margin:0 auto;color:#1a1a1a;">',
        '<p style="font-size:20px;font-weight:700;margin:0 0 4px;">Fetchly</p>',
        f'<p style="color:#666;margin:0 0 20px;">Depuis votre dernière visite : {html.escape(accroche)}</p>',
    ]
    for day in digest["new"]:
        for sub in day["subscriptions"]:
            parts.append(
                f'<p style="font-weight:600;margin:18px 0 6px;border-top:1px solid #eee;'
                f'padding-top:12px;">{html.escape(sub["name"])} '
                f'<span style="color:#999;font-weight:400;">· {sub["count"]}</span></p>'
            )
            for item in sub["items"][:5]:
                link = _deep_link(base_url, item["id"])
                summ = html.escape(item["summary_short"] or "")
                parts.append(
                    f'<p style="margin:0 0 10px;"><a href="{link}" '
                    f'style="color:#2563eb;text-decoration:none;font-weight:600;">'
                    f'{html.escape(item["title"])}</a>'
                    + (f'<br><span style="color:#555;font-size:14px;">{summ}</span>' if summ else "")
                    + "</p>"
                )
    parts.append(
        f'<p style="margin-top:24px;"><a href="{html.escape(base_url.rstrip("/"), quote=True)}/" '
        'style="color:#2563eb;">Ouvrir Fetchly</a></p>'
    )
    parts.append("</div>")
    return "".join(parts)


def send_email_now() -> tuple[bool, str]:
    """Build the current digest and send it via Apprise. Requires public_base_url
    (no dead links). Used by the 'send me a preview' button and the scheduler."""
    from . import notify
    cfg = store.get_digest()
    base = (cfg.get("public_base_url") or "").strip()
    if not base.startswith(("http://", "https://")):
        return False, "URL publique (public_base_url) requise et valide pour les liens de l'e-mail."
    digest = build(since_ts=time.time() - _DEFAULT_WINDOW_S)
    if digest["stats"]["count"] == 0:
        return False, "Rien de nouveau cette semaine — aucun e-mail envoyé."
    html_body = build_email_html(digest, base)
    subject = f"Fetchly — {digest['stats']['count']} nouveauté(s) cette semaine"
    return notify.send_digest_email(subject, html_body)


def maybe_send_weekly() -> None:
    """Called each scheduler minute. Fires once in the configured day/hour, then
    guarded by email_last_sent so it doesn't repeat within the week."""
    cfg = store.get_digest()
    if not cfg.get("email_enabled") or not (cfg.get("public_base_url") or "").strip():
        return
    now = datetime.now()
    if now.weekday() != int(cfg.get("email_day", 6)) or now.hour != int(cfg.get("email_hour", 8)):
        return
    last = cfg.get("email_last_sent") or ""
    if last:
        try:
            if (now - datetime.fromisoformat(last)).total_seconds() < 6 * 86400:
                return  # already sent this week
        except ValueError:
            pass
    ok, msg = send_email_now()
    if ok:
        store.set_digest_key("email_last_sent", now.isoformat())
        print("[digest] weekly e-mail sent", flush=True)
    else:
        print(f"[digest] weekly e-mail skipped: {msg}", flush=True)
