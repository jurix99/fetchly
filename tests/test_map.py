"""Content-map assembly (the "Carte" mode): node rings, neighbour↔neighbour
edges, depth caps, dedup, and the default start pick. related() is monkeypatched
so the graph logic is exercised without sqlite-vec/embeddings."""

from __future__ import annotations

import uuid

import pytest

from app import db as db_mod
from app import indexer


@pytest.fixture()
def db():
    db_mod.init()
    with db_mod._LOCK:
        db_mod._conn.execute("DELETE FROM contents")
        db_mod._conn.commit()
    return db_mod


def _mk(db, cid, title="T"):
    db.content_upsert({
        "id": cid, "source": "yt", "source_id": cid, "url": "", "title": title,
        "description": "", "channel": "Ch", "channel_url": "", "duration_seconds": 60,
        "uploaded_at": "", "downloaded_at": 1.0, "filepath": f"/tmp/{cid}.mp4",
        "filesize": 1, "thumbnail_path": "", "watch_id": None, "kind": "video",
        "transcript_status": "done", "index_status": "done", "language": "fr",
        "lifecycle": "ready",
    })


def _res(cid, score):
    return {
        "id": cid, "title": cid, "channel": "Ch", "source": "yt",
        "duration_seconds": 60, "thumbnail_url": None, "score": score,
        "pair": {"a_start_ms": 1000, "a_text": "ici", "b_start_ms": 2000, "b_text": "la"},
    }


@pytest.fixture()
def graph(monkeypatch, db):
    # C ── n1 (0.9), C ── n2 (0.8); n1 ── n2 (0.7); n1 ── n3 (0.6)
    for cid in ("C", "n1", "n2", "n3"):
        _mk(db, cid)
    table = {
        "C": [_res("n1", 0.9), _res("n2", 0.8)],
        "n1": [_res("C", 0.9), _res("n2", 0.7), _res("n3", 0.6)],
        "n2": [_res("C", 0.8), _res("n1", 0.7)],
        "n3": [_res("n1", 0.6)],
    }
    monkeypatch.setattr(indexer, "related", lambda cid, limit=5: {"content_id": cid, "results": table.get(cid, [])[:limit]})
    return table


def test_depth1_nodes_and_neighbour_edges(graph):
    m = indexer.content_map("C", depth=1)
    ids = {n["content_id"] for n in m["nodes"]}
    assert ids == {"C", "n1", "n2"}  # n3 is depth-2 only
    center = next(n for n in m["nodes"] if n["content_id"] == "C")
    assert center["ring"] == 0 and center["score_to_center"] == 1.0
    # The neighbour↔neighbour edge (n1-n2) is what reveals a cluster.
    pairs = {frozenset((e["a"], e["b"])) for e in m["edges"]}
    assert frozenset(("C", "n1")) in pairs
    assert frozenset(("n1", "n2")) in pairs
    # Every edge carries a passage pair.
    assert all(e["pair"]["a_start_ms"] and e["pair"]["b_start_ms"] for e in m["edges"])


def test_edges_are_deduped_undirected(graph):
    m = indexer.content_map("C", depth=1)
    keys = [frozenset((e["a"], e["b"])) for e in m["edges"]]
    assert len(keys) == len(set(keys))  # C-n1 counted once despite both directions


def test_depth2_adds_ring2(graph):
    m = indexer.content_map("C", depth=2)
    ids = {n["content_id"] for n in m["nodes"]}
    assert "n3" in ids
    n3 = next(n for n in m["nodes"] if n["content_id"] == "n3")
    assert n3["ring"] == 2


def test_total_node_cap(monkeypatch, db):
    _mk(db, "C")
    many = [_res(f"x{i}", 0.9 - i * 0.001) for i in range(40)]
    # Every node also links to 40 others → depth 2 would explode without the cap.
    monkeypatch.setattr(indexer, "related", lambda cid, limit=5: {"content_id": cid, "results": many[:limit]})
    m = indexer.content_map("C", depth=2)
    assert len(m["nodes"]) <= indexer._MAP_MAX_TOTAL


def test_map_start_prefers_last_opened_with_links(monkeypatch, db):
    monkeypatch.setattr(db, "map_start_candidates",
                        lambda limit=60, seen_only=False: ["seen1"] if seen_only else ["a", "b"])
    monkeypatch.setattr(indexer, "related", lambda cid, limit=5: {"content_id": cid, "results": [_res("z", 0.9)]})
    assert indexer.map_start() == {"content_id": "seen1"}
