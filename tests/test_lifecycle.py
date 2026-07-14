"""Content lifecycle (UX refactor): a 'pending' row exists from job acceptance,
is promoted in place on completion, dropped on cancel/failure, excluded from the
digest while pending, and surfaces lifecycle + download_progress via to_public."""

from __future__ import annotations

import time

import pytest

from app import db as db_mod
from app import digest, library, store


@pytest.fixture()
def db():
    db_mod.init()
    with db_mod._LOCK:
        db_mod._conn.execute("DELETE FROM contents")
        db_mod._conn.commit()
    store.set_digest_key("last_seen_at", "")
    return db_mod


def test_pending_create_is_idempotent_per_job(db):
    a = db.content_create_pending("job-1", {"title": "Cap", "source": "youtube"})
    b = db.content_create_pending("job-1", {"title": "Cap"})
    assert a == b  # second call returns the same row, no duplicate
    row = db.content_get(a)
    assert row["lifecycle"] == "pending"
    assert row["job_id"] == "job-1"
    assert row["filepath"] is None


def test_promote_flips_to_ready_in_place(db):
    cid = db.content_create_pending("job-2", {"title": "Cap"})
    out = db.content_promote("job-2", {
        "filepath": "/downloads/vid.mp4", "filesize": 42, "title": "Vraie vidéo",
        "duration_seconds": 120, "kind": "video",
    })
    assert out == cid  # same row promoted, not a new one
    row = db.content_get(cid)
    assert row["lifecycle"] == "ready"
    assert row["filepath"] == "/downloads/vid.mp4"
    assert row["title"] == "Vraie vidéo" and row["duration_seconds"] == 120
    # A second promote is a no-op (already ready).
    assert db.content_promote("job-2", {"filepath": "/x"}) is None


def test_delete_pending_only_touches_pending(db):
    cid = db.content_create_pending("job-3", {"title": "Cap"})
    db.content_promote("job-3", {"filepath": "/downloads/kept.mp4", "filesize": 1})
    # Now ready → delete_pending must not remove it.
    assert db.content_delete_pending("job-3") is False
    assert db.content_get(cid) is not None
    # A fresh pending row IS removed.
    db.content_create_pending("job-4", {"title": "Cap2"})
    assert db.content_delete_pending("job-4") is True
    assert db.content_by_job("job-4") is None


def test_pending_excluded_from_digest_until_ready(db):
    now = time.time()
    db.content_create_pending("job-5", {"title": "En cours", "downloaded_at": now})
    assert digest.new_count() == 0            # pending is invisible to the digest
    db.content_promote("job-5", {"filepath": "/downloads/done.mp4", "filesize": 1,
                                 "downloaded_at": now})
    assert digest.new_count() == 1            # ready shows up


def test_to_public_exposes_lifecycle_and_progress(db):
    cid = db.content_create_pending("job-6", {"title": "Cap",
                                              "thumbnail_path": "https://img/x.jpg"})
    pub = library.to_public(db.content_get(cid))
    assert pub["lifecycle"] == "pending"
    assert pub["download_progress"] == 0.0    # no live job in tests → 0
    assert pub["thumbnail_url"] == "https://img/x.jpg"  # remote preview kept
    db.content_promote("job-6", {"filepath": "/downloads/x.mp4", "filesize": 1})
    pub2 = library.to_public(db.content_get(cid))
    assert pub2["lifecycle"] == "ready"
    assert pub2["download_progress"] is None
