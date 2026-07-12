"""Pure-function tests for the search substrate — the highest-risk logic to keep
regression-proof (highlight parsing, chunking, RRF-adjacent helpers, filters).

These import only app.indexer (+ db/store), no FastAPI or model deps, so they run
in a bare environment: `pytest tests/`.
"""

from __future__ import annotations

from app import indexer


# --- highlight offset parsing (FTS snippet STX/ETX -> [start,end]) ----------
def test_parse_highlights_basic():
    clean, spans = indexer._parse_highlights("un \x02mot\x03 exact et \x02deux\x03")
    assert clean == "un mot exact et deux"
    assert spans == [[3, 6], [16, 20]]  # "mot", "deux" offsets into clean text


def test_parse_highlights_none():
    assert indexer._parse_highlights("aucun marqueur") == ("aucun marqueur", [])


def test_parse_highlights_adjacent_and_edges():
    clean, spans = indexer._parse_highlights("\x02a\x03\x02b\x03c")
    assert clean == "abc"
    assert spans == [[0, 1], [1, 2]]


# --- query hash (stable, normalised) ---------------------------------------
def test_query_hash_normalises_case_and_spaces():
    assert indexer.query_hash("Bonjour  le   MONDE") == indexer.query_hash("bonjour le monde")


def test_query_hash_differs():
    assert indexer.query_hash("chat") != indexer.query_hash("chien")


# --- passage dedupe (1 s bucket; lexical wins, then score) -----------------
def _p(start_ms, score, match_type, highlights=None):
    return {
        "start_ms": start_ms, "score": score, "match_type": match_type,
        "text": "x", "highlights": highlights or [],
    }


def test_dedupe_collapses_same_second_prefers_lexical():
    out = indexer._dedupe_passages([
        _p(1000, 0.10, "semantic"),
        _p(1200, 0.05, "lexical", [[0, 1]]),  # same 1 s bucket as 1000
        _p(5000, 0.20, "semantic"),
    ])
    assert len(out) == 2
    assert out[0]["start_ms"] == 5000  # sorted by score desc
    bucket1 = [p for p in out if p["start_ms"] in (1000, 1200)][0]
    assert bucket1["match_type"] == "lexical"  # lexical won the bucket


def test_dedupe_higher_score_wins_within_type():
    out = indexer._dedupe_passages([_p(1000, 0.1, "semantic"), _p(1400, 0.3, "semantic")])
    assert len(out) == 1 and out[0]["score"] == 0.3


# --- content filters --------------------------------------------------------
def _card():  # minimal card+row shape used by _passes_filters
    return {"source": "youtube", "channel": "Chan", "duration_seconds": 600, "downloaded_at": 1_000_000.0}


def test_passes_filters_source_and_channel():
    row = _card()
    assert indexer._passes_filters(row, row, {"source": "youtube"})
    assert not indexer._passes_filters(row, row, {"source": "vimeo"})
    assert not indexer._passes_filters(row, row, {"channel": "Autre"})


def test_passes_filters_duration_bounds():
    row = _card()
    assert indexer._passes_filters(row, row, {"min_duration": 300, "max_duration": 900})
    assert not indexer._passes_filters(row, row, {"min_duration": 700})
    assert not indexer._passes_filters(row, row, {"max_duration": 500})


def test_passes_filters_since_ts():
    row = _card()
    assert indexer._passes_filters(row, row, {"since_ts": 999_999.0})
    assert not indexer._passes_filters(row, row, {"since_ts": 1_000_001.0})


# --- semantic chunking (~45 s windows, ~10 s overlap) ----------------------
def _seg(start, end, text):
    return {"start_ms": start, "end_ms": end, "text": text}


def test_build_chunks_empty():
    assert indexer.build_chunks([]) == []


def test_build_chunks_single_window():
    segs = [_seg(0, 10_000, "a"), _seg(10_000, 20_000, "b")]
    chunks = indexer.build_chunks(segs)
    assert len(chunks) == 1
    start, end, text = chunks[0]
    assert start == 0 and end == 20_000 and text == "a b"


def test_build_chunks_splits_and_overlaps():
    # 6 × 10 s segments = 60 s total, > 45 s window -> at least 2 chunks that
    # overlap (the second must start before the first ended).
    segs = [_seg(i * 10_000, (i + 1) * 10_000, f"s{i}") for i in range(6)]
    chunks = indexer.build_chunks(segs)
    assert len(chunks) >= 2
    assert chunks[1][0] < chunks[0][1]  # overlap: chunk2 start < chunk1 end
    assert all(text for _, _, text in chunks)  # no empty chunks


def test_build_chunks_oversized_single_segment():
    # A lone segment longer than the window must still produce one chunk.
    chunks = indexer.build_chunks([_seg(0, 90_000, "long")])
    assert chunks == [(0, 90_000, "long")]
