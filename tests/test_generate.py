"""Pure-logic tests for the Intelligence brick: LLM JSON coaxing, provider
presets, and chapter snapping/finalization. No network — the LLM transport is
never exercised here."""

from __future__ import annotations

import uuid

import pytest

from app import db as db_mod
from app import generate, llm


# --- llm: tolerant JSON parsing --------------------------------------------
def test_parse_json_strips_fences():
    assert llm._parse_json('```json\n{"a": 1}\n```') == {"a": 1}


def test_parse_json_extracts_from_prose():
    assert llm._parse_json('ok: {"s":"x","chapters":[]} fin') == {"s": "x", "chapters": []}


def test_parse_json_none_on_garbage():
    assert llm._parse_json("pas du json du tout") is None


# --- llm: preset table integrity -------------------------------------------
def test_presets_two_protocols_only():
    for p in llm.presets_public():
        assert p["protocol"] in ("openai_compatible", "anthropic")


def test_anthropic_preset_shape():
    pp = {p["id"]: p for p in llm.presets_public()}
    assert pp["anthropic"]["protocol"] == "anthropic"
    assert pp["anthropic"]["base_url"] == "https://api.anthropic.com"
    assert pp["ollama"]["needs_key"] is False and pp["ollama"]["local"] is True


def test_configured_off_by_default():
    assert llm.configured() is False  # default preset "none" → feature disabled


# --- generate: pure helpers ------------------------------------------------
def test_chapter_range_bounds():
    assert generate._chapter_range(None) == (3, 6)
    lo, hi = generate._chapter_range(3600)
    assert 3 <= lo < hi <= 12


def test_token_estimate():
    assert generate._est_tokens("a" * 4000) == 1000


# --- generate: finalize snaps + dedups + clamps + stores -------------------
@pytest.fixture(scope="module")
def db():
    db_mod.init()
    return db_mod


def test_finalize_snaps_and_stores(db):
    cid = "GEN-" + uuid.uuid4().hex
    db.content_upsert({
        "id": cid, "source": "yt", "source_id": cid, "url": "", "title": "T",
        "description": "", "channel": "Ch", "channel_url": "", "duration_seconds": 600,
        "uploaded_at": "", "downloaded_at": 1.0, "filepath": f"/tmp/{cid}.mp4",
        "filesize": 1, "thumbnail_path": "", "watch_id": None, "kind": "video",
        "transcript_status": "done", "index_status": "none", "language": "fr",
    })
    seg_starts = [0, 60000, 120000, 300000]
    data = {
        "summary_short": "court", "summary_long": "long",
        "chapters": [
            {"start_ms": 1200, "title": "Intro"},      # → 0
            {"start_ms": 61000, "title": "Partie 1"},   # → 60000
            {"start_ms": 500, "title": "Doublon"},      # → 0, deduped out
            {"start_ms": 295000, "title": "Fin"},       # → 300000
            {"title": "sans start"},                     # invalid → skipped
        ],
    }
    cfg = {"model": "m", "style": "concis", "output_language": "auto"}
    generate._finalize(cid, data, seg_starts, cfg, 600)

    assert [c["start_ms"] for c in db.chapters_get(cid)] == [0, 60000, 300000]
    row = db.content_get(cid)
    assert row["summary_short"] == "court"
    assert row["summary_model"] == "m"
    assert row["generation_status"] == "done"


def test_finalize_rejects_empty_summary(db):
    cid = "GEN-" + uuid.uuid4().hex
    db.content_upsert({
        "id": cid, "source": "yt", "source_id": cid, "url": "", "title": "T",
        "description": "", "channel": "Ch", "channel_url": "", "duration_seconds": 60,
        "uploaded_at": "", "downloaded_at": 1.0, "filepath": f"/tmp/{cid}.mp4",
        "filesize": 1, "thumbnail_path": "", "watch_id": None, "kind": "video",
        "transcript_status": "done", "index_status": "none", "language": "fr",
    })
    with pytest.raises(llm.LLMError):
        generate._finalize(cid, {"summary_short": "", "summary_long": ""}, [0], {"model": "m"}, 60)
