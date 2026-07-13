"""Highlights, notes (FTS + search fusion), verbatim reconstruction, clip
validation helpers, and the cascade on content delete."""

from __future__ import annotations

import uuid

import pytest

from app import clips
from app import db as db_mod
from app import indexer, library


@pytest.fixture()
def db():
    db_mod.init()
    return db_mod


def _content(db, cid, segs):
    db.content_upsert({
        "id": cid, "source": "yt", "source_id": cid, "url": "", "title": "Ma Vidéo Pipeline",
        "description": "", "channel": "Chan", "channel_url": "", "duration_seconds": 600,
        "uploaded_at": "", "downloaded_at": 1.0, "filepath": f"/tmp/{cid}.mp4", "filesize": 1,
        "thumbnail_path": "", "watch_id": None, "kind": "video",
        "transcript_status": "done", "index_status": "none", "language": "fr",
    })
    db.segments_replace(cid, segs)


# --- verbatim reconstruction (server-side, never DOM) ----------------------
def test_rebuild_span_snaps_to_segments(db):
    cid = uuid.uuid4().hex
    _content(db, cid, [(0, 2000, "le pipeline de donnees"), (2000, 4000, "passe par ffmpeg"), (4000, 6000, "puis lindex")])
    span = library.rebuild_span(cid, 1500, 3000)  # overlaps seg0 + seg1
    assert span == (0, 4000, "le pipeline de donnees passe par ffmpeg")


def test_rebuild_span_none_without_overlap(db):
    cid = uuid.uuid4().hex
    _content(db, cid, [(0, 1000, "court")])
    assert library.rebuild_span(cid, 5000, 6000) is None


# --- highlights + notes ----------------------------------------------------
def test_highlight_note_indexed_and_searchable(db):
    cid = uuid.uuid4().hex
    _content(db, cid, [(0, 2000, "le pipeline de donnees"), (2000, 4000, "passe par ffmpeg")])
    s, e, text = library.rebuild_span(cid, 0, 4000)
    hl = db.highlight_create(cid, s, e, text, "amber")
    assert hl["text"].startswith("le pipeline")
    db.highlight_set_note(hl["id"], "idée pipeline")

    notes = db.fts_notes(["pipeline"], 10, None)
    assert notes and notes[0]["highlight_id"] == hl["id"]
    assert notes[0]["note"] == "idée pipeline" and notes[0]["text"].startswith("le pipeline")

    # search() surfaces a typed "note" passage
    kinds = [p["match_type"] for r in indexer.search("pipeline", record=False)["results"] for p in r["passages"]]
    assert "note" in kinds


def test_note_removed_when_cleared(db):
    cid = uuid.uuid4().hex
    _content(db, cid, [(0, 2000, "alpha beta")])
    s, e, text = library.rebuild_span(cid, 0, 2000)
    hl = db.highlight_create(cid, s, e, text, "amber")
    db.highlight_set_note(hl["id"], "note zeta")
    assert db.fts_notes(["zeta"], 10, None)
    db.highlight_set_note(hl["id"], "")  # clear
    assert db.fts_notes(["zeta"], 10, None) == []


def test_highlights_spans(db):
    cid = uuid.uuid4().hex
    _content(db, cid, [(0, 2000, "a"), (2000, 4000, "b")])
    s, e, text = library.rebuild_span(cid, 0, 4000)
    db.highlight_create(cid, s, e, text, "amber")
    assert db.highlights_spans(cid) == [(0, 4000)]


# --- clip validation + filename helpers ------------------------------------
def test_clip_duration_validation():
    assert clips.duration_error(1000, 500) is not None       # end <= start
    assert clips.duration_error(0, 6 * 60 * 1000) is not None  # > 5 min
    assert clips.duration_error(0, 45_000) is None


def test_clip_name_helpers():
    assert clips._mmss(90_000) == "0130"
    assert clips._slug("Ma Vidéo Pipeline!!") == "ma-vid-o-pipeline"


# --- cascade ---------------------------------------------------------------
def test_content_delete_cascades_highlights_notes_clips(db):
    cid = uuid.uuid4().hex
    _content(db, cid, [(0, 2000, "gamma delta")])
    s, e, text = library.rebuild_span(cid, 0, 2000)
    hl = db.highlight_create(cid, s, e, text, "amber")
    db.highlight_set_note(hl["id"], "note gamma")
    db.clip_create("clip-" + cid, cid, "/downloads/.fetchly/clips/x.mp4", "video", 0, 2000)
    assert db.highlights_get(cid) and db.clips_get(cid)

    db.content_delete(cid)
    assert db.highlights_get(cid) == []
    assert db.clips_get(cid) == []
    assert db.fts_notes(["gamma"], 10, None) == []  # notes_fts purged
