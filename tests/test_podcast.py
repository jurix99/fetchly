"""Podcast feeds: audio-rendition tracking, iTunes RSS generation (well-formed,
namespaced, exact enclosure length/type, escaped titles), token, stats, cascade.
Video→audio ffmpeg extraction is not exercised (audio-kind path only)."""

from __future__ import annotations

import os
import tempfile
import uuid
import xml.etree.ElementTree as ET

import pytest

from app import db as db_mod
from app import podcast, store

_ITUNES = "http://www.itunes.com/dtds/podcast-1.0.dtd"


@pytest.fixture()
def db():
    db_mod.init()
    with db_mod._LOCK:
        db_mod._conn.execute("DELETE FROM contents")
        db_mod._conn.commit()
    return db_mod


def _audio_content(db, watch_id, size=1234, **over):
    cid = uuid.uuid4().hex
    tmp = tempfile.mkdtemp()
    f = os.path.join(tmp, "ep.m4a")
    with open(f, "wb") as fh:
        fh.write(b"x" * size)
    row = {
        "id": cid, "source": "yt", "source_id": cid, "url": "", "title": "Ép 1 & <x>",
        "description": "d" * 40, "channel": "Chan", "channel_url": "", "duration_seconds": 3725,
        "uploaded_at": "20260710", "downloaded_at": 1000.0, "filepath": f, "filesize": size,
        "thumbnail_path": "", "watch_id": watch_id, "kind": "audio",
        "transcript_status": "done", "index_status": "none", "language": "fr",
    }
    row.update(over)
    db.content_upsert(row)
    return cid


def test_itunes_duration():
    assert podcast.itunes_duration(3725) == "1:02:05"
    assert podcast.itunes_duration(75) == "1:15"
    assert podcast.itunes_duration(0) == "0:00"


def test_prepare_audio_references_audio_file(db):
    cid = _audio_content(db, "w1", size=999)
    assert podcast.prepare_audio(cid) is True
    row = db.content_get(cid)
    assert row["audio_path"].endswith("ep.m4a") and row["audio_bytes"] == 999


def test_feed_is_wellformed_and_namespaced(db):
    store.add_watch("https://youtube.com/@chan", title="Chan")
    wid = store.list_watches()[-1]["id"]
    store.update_watch(wid, podcast_feed=True)
    cid = _audio_content(db, wid)
    podcast.prepare_audio(cid)
    with db._LOCK:
        db._conn.execute("UPDATE contents SET summary_short=? WHERE id=?", ("Résumé court.", cid))
        db._conn.commit()

    token = store.feeds_token()
    xml = podcast.build_feed(wid, "https://fetchly.example", token)
    assert 'xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"' in xml.splitlines()[1]
    root = ET.fromstring(xml)  # well-formed
    items = root.find("channel").findall("item")
    assert len(items) == 1
    enc = items[0].find("enclosure")
    assert enc.get("url") == f"https://fetchly.example/feeds/media/{cid}.m4a?token={token}"
    assert enc.get("length") == str(1234) and enc.get("type") == "audio/mp4"
    assert items[0].find("guid").text == cid
    assert items[0].find(f"{{{_ITUNES}}}duration").text == "1:02:05"
    assert items[0].find("description").text == "Résumé court."


def test_all_feed_aggregates_enabled_only(db):
    store.add_watch("https://youtube.com/@a", title="A")
    store.add_watch("https://youtube.com/@b", title="B")
    wa, wb = store.list_watches()[-2]["id"], store.list_watches()[-1]["id"]
    store.update_watch(wa, podcast_feed=True)  # only A is a podcast feed
    for w in (wa, wb):
        podcast.prepare_audio(_audio_content(db, w))
    token = store.feeds_token()
    items = ET.fromstring(podcast.build_feed("all", "https://x", token)).find("channel").findall("item")
    assert len(items) == 1  # B excluded


def test_unknown_watch_returns_none(db):
    assert podcast.build_feed("does-not-exist", "https://x", store.feeds_token()) is None


def test_token_regeneration_changes_token():
    old = store.feeds_token()
    new = store.regenerate_feeds_token()
    assert new != old and store.feeds_token() == new


def test_stats_and_cascade(db):
    store.add_watch("https://youtube.com/@c", title="C")
    wid = store.list_watches()[-1]["id"]
    store.update_watch(wid, podcast_feed=True)
    cid = _audio_content(db, wid, size=555)
    podcast.prepare_audio(cid)
    st = podcast.stats()
    assert st["episodes_ready"] >= 1 and st["audio_bytes"] >= 555
    assert db.podcast_missing_count(wid) == 0
    db.content_delete(cid)
    assert db.podcast_items([wid]) == []
