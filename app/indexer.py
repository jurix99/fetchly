"""Hybrid search index: semantic chunks + embeddings (fastembed/ONNX) and
lexical FTS5, fused with Reciprocal Rank Fusion. Fully in-process (SQLite +
sqlite-vec), no external search service.

Indexing runs in the transcription worker after a content is transcribed (or its
source subtitles imported), so it never blocks a download or the pipeline.
"""

from __future__ import annotations

import re
import threading
import time
from pathlib import Path
from typing import Any

from . import db, store

# Multilingual 384-dim embedder that fastembed ships as ONNX (no torch — the
# actual constraint). intfloat/multilingual-e5-small isn't in the pinned
# fastembed's registry; this MiniLM is 384-dim, multilingual and strong in
# French. Swap here (and drop the prefixes below) if a fastembed build bundling
# e5-small is pinned.
MODEL_NAME = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
MODEL_LANG = "multilingue (50+ langues, fort en français)"
MODELS_DIR = store.CONFIG_DIR / "models"
_RRF_K = 60
_CHUNK_MS = 45_000
_OVERLAP_MS = 10_000

_model: Any = None
_model_lock = threading.Lock()


# --- embeddings ------------------------------------------------------------
def _get_model():
    global _model
    with _model_lock:
        if _model is None:
            from fastembed import TextEmbedding
            from . import transcribe
            # Relax TLS only for the (first-use) model download, like Whisper.
            with transcribe._relaxed_tls():
                _model = TextEmbedding(model_name=MODEL_NAME, cache_dir=str(MODELS_DIR))
        return _model


def _serialize(vec) -> bytes:
    import sqlite_vec
    return sqlite_vec.serialize_float32(list(vec))


def _embed(texts: list[str]) -> list[Any]:
    model = _get_model()
    return list(model.embed(texts, batch_size=32))


def embed_query(q: str) -> bytes:
    # MiniLM uses symmetric embeddings (no query/passage prefix).
    return _serialize(_embed([q])[0])


# --- chunking --------------------------------------------------------------
def build_chunks(segments: list[dict[str, Any]]) -> list[tuple[int, int, str]]:
    """~45 s chunks with ~10 s overlap, concatenating consecutive segments.
    This is the semantic-search unit AND the future RAG unit — kept generous."""
    if not segments:
        return []
    chunks: list[tuple[int, int, str]] = []
    i = 0
    n = len(segments)
    while i < n:
        start = segments[i]["start_ms"]
        texts: list[str] = []
        end = start
        j = i
        while j < n and segments[j]["end_ms"] - start <= _CHUNK_MS:
            texts.append(segments[j]["text"])
            end = segments[j]["end_ms"]
            j += 1
        if j == i:  # a single segment longer than the target window
            texts.append(segments[i]["text"])
            end = segments[i]["end_ms"]
            j = i + 1
        chunks.append((start, end, " ".join(t for t in texts if t).strip()))
        if j >= n:
            break
        # Step forward, keeping ~overlap by rewinding to the first segment that
        # starts within `overlap` of the end.
        overlap_start = end - _OVERLAP_MS
        nxt = j
        for k in range(i, j):
            if segments[k]["start_ms"] >= overlap_start:
                nxt = k
                break
        i = nxt if nxt > i else j
    return [c for c in chunks if c[2]]


# --- indexing --------------------------------------------------------------
def index_content(content_id: str) -> None:
    """(Re)index one content: import source subs if needed, sync FTS, rebuild
    chunks + embeddings. Best-effort — sets index_status error on failure."""
    content = db.content_get(content_id)
    if not content:
        return
    segments = db.segments_get(content_id)
    if not segments:
        # Import existing source subtitles (never re-run Whisper) — roadmap P1.
        fp = content.get("filepath")
        if fp:
            from . import transcribe
            subs = transcribe.source_captions(Path(fp))
            if subs:
                db.segments_replace(content_id, [(s["start_ms"], s["end_ms"], s["text"]) for s in subs])
                segments = db.segments_get(content_id)
    if not segments:
        db.content_set_index(content_id, "none")
        return
    try:
        db.segments_fts_sync(content_id)  # lexical coverage (idempotent)
        db.index_clear(content_id)  # drop stale chunks/vectors
        chunks = build_chunks(segments)
        ids = db.chunks_insert(content_id, chunks)
        if db.VEC_OK and chunks:
            embs = _embed([c[2] for c in chunks])
            db.vec_insert([(ids[k], _serialize(embs[k])) for k in range(len(ids))])
        db.content_set_index(content_id, "done")
    except Exception:  # noqa: BLE001
        db.content_set_index(content_id, "error")
        raise


def _content_card(content_id: str) -> dict[str, Any] | None:
    from . import library
    row = db.content_get(content_id)
    if not row:
        return None
    return {
        "id": row["id"],
        "title": row.get("title"),
        "channel": row.get("channel"),
        "source": row.get("source"),
        "duration_seconds": row.get("duration_seconds"),
        "thumbnail_url": library._media_url(row.get("thumbnail_path")),
    }


# --- search (hybrid, RRF) --------------------------------------------------
def search(q: str, scope: str = "all", limit: int = 20) -> dict[str, Any]:
    t0 = time.monotonic()
    content_id = None if scope in (None, "", "all") else scope
    tokens = re.findall(r"\w+", q.lower())

    seg_hits = db.fts_segments(tokens, limit * 3, content_id)
    con_hits = db.fts_contents(tokens, limit * 3, content_id)
    sem_hits: list[dict[str, Any]] = []
    if db.VEC_OK and q.strip():
        try:
            knn = db.vec_knn(embed_query(q), limit * 3)
            sem_hits = [h for h in knn if not content_id or h["content_id"] == content_id]
        except Exception as exc:  # noqa: BLE001 — semantic branch never breaks search
            print(f"[indexer] semantic search failed: {exc}", flush=True)

    # RRF fuse the three ranked lists into a per-content score; collect passages.
    scores: dict[str, float] = {}
    passages: dict[str, list[dict[str, Any]]] = {}

    def add(cid: str, rank: int) -> float:
        s = 1.0 / (_RRF_K + rank + 1)
        scores[cid] = scores.get(cid, 0.0) + s
        return s

    for rank, h in enumerate(seg_hits):
        s = add(h["content_id"], rank)
        passages.setdefault(h["content_id"], []).append({
            "start_ms": h["start_ms"], "text": h["snippet"], "match_type": "lexical", "score": s,
        })
    for rank, h in enumerate(sem_hits):
        s = add(h["content_id"], rank)
        passages.setdefault(h["content_id"], []).append({
            "start_ms": h["start_ms"], "text": h["text"], "match_type": "semantic", "score": s,
        })
    for rank, h in enumerate(con_hits):
        add(h["content_id"], rank)  # metadata boost, no timestamped passage

    results = []
    for cid in sorted(scores, key=lambda c: scores[c], reverse=True)[:limit]:
        card = _content_card(cid)
        if not card:
            continue
        ps = sorted(passages.get(cid, []), key=lambda p: p["score"], reverse=True)[:3]
        results.append({**card, "score": round(scores[cid], 5), "passages": ps})

    return {
        "query": q,
        "took_ms": round((time.monotonic() - t0) * 1000, 1),
        "count": len(results),
        "results": results,
    }


# --- backfill / rebuild / stats -------------------------------------------
def _run_index_task(job: Any, content_ids: list[str]) -> None:
    from . import jobs as jobs_mod
    job.total = len(content_ids)
    jobs_mod.persist(job)
    last = 0.0
    done = 0
    for i, cid in enumerate(content_ids):
        try:
            index_content(cid)
            done += 1
        except Exception as exc:  # noqa: BLE001
            job.log.append(f"index {cid}: {exc}")
        job.completed = i + 1
        now = time.time()
        if now - last >= 1.0:
            last = now
            jobs_mod.persist(job)
    job.status = "done"
    job.finished_at = time.time()
    job.log.append(f"Indexation terminée — {done} contenu(s) indexé(s).")
    jobs_mod.persist(job)


def backfill() -> str:
    from . import jobs as jobs_mod
    job = jobs_mod.create_task("Indexation de la bibliothèque")
    ids = [c["id"] for c in db.contents_to_index()]
    threading.Thread(target=_run_index_task, args=(job, ids), daemon=True).start()
    return job.id


def rebuild() -> str:
    from . import jobs as jobs_mod
    db.index_rebuild_drop()
    job = jobs_mod.create_task("Reconstruction de l'index")
    ids = [c["id"] for c in db.content_list(limit=100000)[0]]
    threading.Thread(target=_run_index_task, args=(job, ids), daemon=True).start()
    return job.id


def stats() -> dict[str, Any]:
    s = db.index_stats()
    s["embedding_model"] = MODEL_NAME
    s["embedding_lang"] = MODEL_LANG
    s["semantic"] = db.VEC_OK
    return s
