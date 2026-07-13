"""Pure-logic tests for the optional cloud STT engine: verbose_json parsing (+
fallbacks), the slice plan, overlap-dedup re-stitching, and the monthly minutes
counter. No network / no ffmpeg — only the pure functions are exercised."""

from __future__ import annotations

import pytest

from app import cloud_stt
from app import db as db_mod


# --- response parsing ------------------------------------------------------
def test_parse_segments_offsets_and_ms():
    data = {"segments": [
        {"start": 0.0, "end": 2.5, "text": " Bonjour"},
        {"start": 2.5, "end": 5.0, "text": "le monde "},
    ]}
    assert cloud_stt._parse_segments(data, 600_000) == [
        (600_000, 602_500, "Bonjour"),
        (602_500, 605_000, "le monde"),
    ]


def test_parse_words_fallback_groups():
    words = {"words": [{"start": i * 0.5, "end": i * 0.5 + 0.5, "word": f"w{i}"} for i in range(15)]}
    segs = cloud_stt._parse_segments(words, 0)
    assert segs and segs[0][0] == 0
    assert all(t.strip() for _, _, t in segs)


def test_parse_text_only_and_empty():
    assert cloud_stt._parse_segments({"text": "juste du texte"}, 1000) == [(1000, 2000, "juste du texte")]
    assert cloud_stt._parse_segments({}, 0) == []


# --- slice plan ------------------------------------------------------------
def test_slice_plan_windows_and_overlap():
    plan = cloud_stt._slice_plan(25 * 60)
    assert [round(s) for s, _ in plan] == [0, 600, 1200]      # 10-min steps
    assert abs(plan[0][1] - (cloud_stt._SLICE_SEC + cloud_stt._OVERLAP_SEC)) < 0.01
    assert plan[-1][1] <= cloud_stt._SLICE_SEC + cloud_stt._OVERLAP_SEC


def test_slice_plan_short_single():
    assert cloud_stt._slice_plan(120) == [(0.0, 120)]


# --- overlap re-stitching --------------------------------------------------
def test_merge_overlap_dedups_join():
    s1 = [(0, 2000, "a"), (2000, 600_000, "mid"), (599_000, 605_000, "joint phrase")]
    s2 = [(599_500, 605_000, "joint phrase"), (605_000, 610_000, "suite")]
    merged = cloud_stt._merge_overlap([s1, s2])
    texts = [t for _, _, t in merged]
    assert texts.count("joint phrase") == 1  # duplicate at the join removed
    assert "suite" in texts


# --- monthly minutes counter -----------------------------------------------
@pytest.fixture(scope="module")
def db():
    db_mod.init()
    return db_mod


def test_cloud_minutes_accumulate(db):
    before = db.cloud_stt_stats()["minutes"]
    db.cloud_stt_add_minutes(10.0)
    db.cloud_stt_add_minutes(5.5)
    after = db.cloud_stt_stats()
    assert after["minutes"] == round(before + 15.5, 1)
    assert after["month"]  # YYYY-MM


def test_cloud_minutes_ignores_nonpositive(db):
    before = db.cloud_stt_stats()["minutes"]
    db.cloud_stt_add_minutes(0)
    db.cloud_stt_add_minutes(-3)
    assert db.cloud_stt_stats()["minutes"] == before
