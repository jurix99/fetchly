"""Integrity + instrumentation of the SQLite layer: cascade delete leaves no
ghosts, startup GC sweeps orphans, and search_events power the north-star metric.
Runs against a real temp DB (sqlite-vec optional; lexical path always works)."""

from __future__ import annotations

import uuid

import pytest

from app import db as db_mod


@pytest.fixture(scope="module")
def db():
    db_mod.init()  # idempotent; CONFIG_DIR is a temp dir (see conftest)
    return db_mod


def _mk(db, **over):
    cid = over.get("id", str(uuid.uuid4()))
    row = {
        "id": cid, "source": "youtube", "source_id": cid, "url": "", "title": "Title chat",
        "description": "cats and dogs", "channel": "Chan", "channel_url": "",
        "duration_seconds": 600, "uploaded_at": "", "downloaded_at": 1000.0,
        "filepath": f"/tmp/{cid}.mp4", "filesize": 1, "thumbnail_path": "",
        "watch_id": None, "kind": "video", "transcript_status": "done",
        "index_status": "none", "language": "fr",
    }
    row.update(over)
    db.content_upsert(row)
    return cid


def test_cascade_delete_removes_all_memory(db):
    cid = _mk(db)
    db.segments_replace(cid, [(0, 2000, "un chat noir"), (2000, 4000, "le chien court")])
    db.chunks_insert(cid, [(0, 4000, "un chat noir le chien court")])
    v0 = db.index_version()
    db.related_cache_set(cid, db.index_version(), '{"x":1}')

    assert db.content_get(cid) is not None
    assert db.segments_get(cid) and db.chunks_of(cid)
    assert db.fts_segments(["chat"], 10)  # lexical index populated

    db.content_delete(cid)

    assert db.content_get(cid) is None
    assert db.segments_get(cid) == []
    assert db.chunks_of(cid) == []
    assert db.related_cache_get(cid, db.index_version()) is None
    assert not any(h["content_id"] == cid for h in db.fts_segments(["chat"], 10))
    assert db.index_version() > v0  # deletion invalidated related caches


def test_delete_by_filepath_cascades(db):
    cid = _mk(db)
    db.chunks_insert(cid, [(0, 1000, "text")])
    fp = f"/tmp/{cid}.mp4"
    assert db.content_delete_by_filepath(fp) is True
    assert db.content_get(cid) is None
    assert db.chunks_of(cid) == []
    assert db.content_delete_by_filepath("/tmp/does-not-exist.mp4") is False


def test_gc_sweeps_orphans(db):
    ghost = "GHOST-" + uuid.uuid4().hex
    db.chunks_insert(ghost, [(0, 1000, "orphan")])  # chunk for a non-existent content
    assert db.chunks_of(ghost)  # present before GC
    assert db.gc_orphans()["chunks"] >= 1
    assert db.chunks_of(ghost) == []  # swept
    assert db.gc_orphans()["chunks"] == 0  # idempotent


def test_search_events_power_metric(db):
    qh = uuid.uuid4().hex[:16]
    db.search_event_insert(qh, 3)
    before = db.search_metrics()["retrievals_total"]
    db.search_event_mark_clicked(qh)
    after = db.search_metrics()
    assert after["retrievals_total"] == before + 1
    assert after["searches_week"] >= 1


def test_mark_clicked_is_noop_for_unknown_hash(db):
    before = db.search_metrics()["retrievals_total"]
    db.search_event_mark_clicked("never-searched-hash")
    assert db.search_metrics()["retrievals_total"] == before
