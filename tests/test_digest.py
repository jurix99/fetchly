"""Digest tests: chronological day→subscription grouping, stats, summary
fallback, seen-state, watch-later, and the e-mail HTML (deep links, no tracking).
Echoes require sqlite-vec/embeddings, so only their shape is asserted here."""

from __future__ import annotations

import time
import uuid

import pytest

from app import db as db_mod
from app import digest, store


@pytest.fixture()
def db():
    db_mod.init()
    # Isolate each test: clean slate + fresh visit marker (the DB is shared).
    with db_mod._LOCK:
        db_mod._conn.execute("DELETE FROM contents")
        db_mod._conn.commit()
    store.update_digest({"public_base_url": ""})
    store.set_digest_key("last_seen_at", "")
    return db_mod


def _mk(db, title, wid, dl, summary=None, dur=600):
    cid = uuid.uuid4().hex
    db.content_upsert({
        "id": cid, "source": "youtube", "source_id": cid, "url": "", "title": title,
        "description": f"description de {title}", "channel": "Ch", "channel_url": "",
        "duration_seconds": dur, "uploaded_at": "", "downloaded_at": dl,
        "filepath": f"/tmp/{cid}.mp4", "filesize": 1, "thumbnail_path": "", "watch_id": wid,
        "kind": "video", "transcript_status": "done", "index_status": "none", "language": "fr",
    })
    if summary is not None:
        with db._LOCK:
            db._conn.execute("UPDATE contents SET summary_short=? WHERE id=?", (summary, cid))
            db._conn.commit()
    return cid


def test_grouping_and_stats(db):
    now = time.time()
    _mk(db, "A", "w1", now - 3600)
    _mk(db, "B", "w1", now - 7200, summary="Résumé B")
    _mk(db, "C", "w2", now - 8000)
    d = digest.build()
    assert d["stats"]["count"] == 3
    assert d["stats"]["watches_count"] == 2
    assert d["stats"]["total_duration_s"] == 1800
    groups = {g["watch_id"]: g["count"] for g in d["new"][0]["subscriptions"]}
    assert groups.get("w1") == 2 and groups.get("w2") == 1
    assert isinstance(d["echoes"], list)  # shape only (needs embeddings otherwise)


def test_summary_fallback_to_description(db):
    now = time.time()
    _mk(db, "NoSummary", "w1", now - 100)  # no summary_short → truncated description
    item = digest.build()["new"][0]["subscriptions"][0]["items"][0]
    assert item["summary_short"].startswith("description de NoSummary")


def test_seen_empties_digest_and_count(db):
    now = time.time()
    _mk(db, "A", "w1", now - 100)
    assert digest.new_count() == 1
    digest.mark_all_seen()
    assert digest.new_count() == 0
    assert digest.build()["stats"]["count"] == 0


def test_mark_specific_seen(db):
    now = time.time()
    a = _mk(db, "A", "w1", now - 100)
    _mk(db, "B", "w1", now - 200)
    db.content_mark_seen([a])
    assert digest.new_count() == 1  # only B remains


def test_watch_later_roundtrip(db):
    now = time.time()
    c = _mk(db, "C", "w2", now - 100)
    db.content_set_watch_later(c, True)
    assert any(x["id"] == c for x in digest.build()["watch_later"])
    db.content_set_watch_later(c, False)
    assert not any(x["id"] == c for x in digest.build()["watch_later"])


def test_email_html_has_deeplinks_no_tracking(db):
    now = time.time()
    _mk(db, "Vidéo <b>x</b>", "w1", now - 100, summary="Un <résumé>")
    d = digest.build(since_ts=now - 7 * 86400)
    html = digest.build_email_html(d, "https://fetchly.example/")
    assert "https://fetchly.example/?content=" in html
    assert "Fetchly" in html
    assert "<b>x</b>" not in html          # title is HTML-escaped
    assert "<img" not in html.lower()       # no tracking pixel


def test_send_email_requires_base_url(db):
    ok, msg = digest.send_email_now()
    assert ok is False and "public_base_url" in msg.lower()
