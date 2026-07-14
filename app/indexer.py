"""Hybrid search index: semantic chunks + embeddings (fastembed/ONNX) and
lexical FTS5, fused with Reciprocal Rank Fusion. Fully in-process (SQLite +
sqlite-vec), no external search service.

Indexing runs in the transcription worker after a content is transcribed (or its
source subtitles imported), so it never blocks a download or the pipeline.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
from pathlib import Path
from typing import Any

from . import db, store

# FTS snippet() wraps matched terms with these control chars (STX/ETX) — see
# db.fts_segments. We parse them into explicit character offsets for the UI.
_HL_OPEN = "\x02"
_HL_CLOSE = "\x03"

# "période" presets → lookback window in days (None = all time).
_PERIOD_DAYS = {"week": 7, "month": 30, "quarter": 90, "year": 365}

# Related-contents tuning.
_REL_KNN = 25           # neighbours fetched per source chunk
_REL_TOP_PAIRS = 3      # average of the N best chunk-pair similarities per candidate
_REL_MIN_SCORE = 0.55   # cosine-similarity floor below which a link isn't shown
_REL_CACHE_MAX = 25     # cache the top-N links (sliced to `limit` on read) so the
                        # cache is limit-independent — the map needs more than the
                        # related-panel's 5.

# Content-map tuning (the "Carte" exploration mode — always centred on one node).
_MAP_MAX_D1 = 12        # direct neighbours at depth 1
_MAP_MAX_TOTAL = 25     # hard cap on total nodes at depth 2

# Preferred 384-dim ONNX embedders (no torch — the actual constraint), best
# first. intfloat/multilingual-e5-small is markedly stronger for French
# retrieval but only ships in newer fastembed registries; MiniLM is the
# always-available fallback. Both are 384-dim, so the vec table (float[384]) is
# unchanged — switching models just needs an index rebuild (UI button exists).
# e5 is asymmetric: it needs "query: " / "passage: " prefixes (MiniLM doesn't).
# Override the choice with FETCHLY_EMBED_MODEL=<fastembed model id>.
_PREFERRED_MODELS: list[tuple[str, str]] = [
    ("intfloat/multilingual-e5-small", "e5 multilingue (fort en retrieval FR)"),
    ("sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2", "MiniLM multilingue (50+ langues)"),
]
MODEL_NAME = _PREFERRED_MODELS[0][0]  # updated once the real model is loaded
MODEL_LANG = _PREFERRED_MODELS[0][1]
_USE_PREFIX = True  # e5-style query/passage prefixes; finalised on load
MODELS_DIR = store.CONFIG_DIR / "models"
_RRF_K = 60
_CHUNK_MS = 45_000
_OVERLAP_MS = 10_000
_HL_BONUS = 0.01  # small RRF nudge when a match falls inside a user highlight

_model: Any = None
_model_lock = threading.Lock()


# --- embeddings ------------------------------------------------------------
def _set_selected(name: str, lang: str) -> None:
    global MODEL_NAME, MODEL_LANG, _USE_PREFIX
    MODEL_NAME, MODEL_LANG = name, lang
    _USE_PREFIX = "e5" in name.lower()  # e5 family needs query/passage prefixes


def _get_model():
    """Load the best available embedder, falling back down the preferred list if
    a model isn't in the installed fastembed registry (so a fastembed bump to one
    that bundles e5 upgrades retrieval quality automatically)."""
    global _model
    with _model_lock:
        if _model is not None:
            return _model
        from fastembed import TextEmbedding
        from . import transcribe

        override = os.environ.get("FETCHLY_EMBED_MODEL", "").strip()
        candidates = (
            [(override, "modèle personnalisé (env)")] if override else list(_PREFERRED_MODELS)
        )
        # TLS relaxation is opt-in (default off), like Whisper.
        with transcribe._model_download_ctx():
            last_exc: Exception | None = None
            for name, lang in candidates:
                try:
                    m = TextEmbedding(model_name=name, cache_dir=str(MODELS_DIR))
                    _set_selected(name, lang)
                    _model = m
                    print(f"[indexer] embedding model: {name}", flush=True)
                    return _model
                except Exception as exc:  # noqa: BLE001 — try the next candidate
                    last_exc = exc
                    print(f"[indexer] embedding model {name} unavailable ({exc}); trying next", flush=True)
        raise last_exc if last_exc else RuntimeError("no embedding model available")


def _serialize(vec) -> bytes:
    import sqlite_vec
    return sqlite_vec.serialize_float32(list(vec))


def _embed(texts: list[str]) -> list[Any]:
    model = _get_model()
    return list(model.embed(texts, batch_size=32))


def _embed_passages(texts: list[str]) -> list[Any]:
    """Embed chunk texts for indexing (e5 needs a 'passage: ' prefix)."""
    _get_model()  # ensure _USE_PREFIX is finalised
    if _USE_PREFIX:
        texts = [f"passage: {t}" for t in texts]
    return _embed(texts)


def embed_query(q: str) -> bytes:
    _get_model()  # ensure _USE_PREFIX is finalised
    text = f"query: {q}" if _USE_PREFIX else q
    return _serialize(_embed([text])[0])


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
            embs = _embed_passages([c[2] for c in chunks])
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


# --- related contents (cross-memory) ---------------------------------------
def related(content_id: str, limit: int = 5) -> dict[str, Any]:
    """Contents semantically close to this one. Similarity between two contents =
    mean of the top-`_REL_TOP_PAIRS` cosine similarities between their chunks. We
    reuse stored embeddings (no re-embed) and the sqlite-vec KNN index, so this is
    cheap. Excludes self and same-source duplicates, applies a score floor, and
    returns the single best passage pair per link. Cached per content, keyed on
    the global index version (invalidated on any (re)index)."""
    version = db.index_version()
    cached = db.related_cache_get(content_id, version)
    if cached is not None:
        try:
            full = json.loads(cached)
            return {**full, "results": full.get("results", [])[:limit]}
        except (TypeError, json.JSONDecodeError):
            pass

    empty = {"content_id": content_id, "results": []}
    if not db.VEC_OK:
        return empty
    base = db.content_get(content_id)
    if not base:
        return empty
    chunks = db.chunks_of(content_id)
    if len(chunks) == 0:
        db.related_cache_set(content_id, version, json.dumps(empty))
        return empty

    base_source_id = base.get("source_id") or ""
    # candidate content_id -> {sims: [...], best: (sim, a_chunk, b_hit)}
    agg: dict[str, dict[str, Any]] = {}
    for ch in chunks:
        blob = db.vec_get(ch["id"])
        if not blob:
            continue
        for hit in db.vec_knn(blob, _REL_KNN):
            cid = hit["content_id"]
            if cid == content_id:
                continue
            sim = 1.0 - float(hit["distance"])  # cosine distance -> similarity
            slot = agg.setdefault(cid, {"sims": [], "best": None})
            slot["sims"].append(sim)
            if slot["best"] is None or sim > slot["best"][0]:
                slot["best"] = (sim, ch, hit)

    scored: list[tuple[float, str, dict[str, Any]]] = []
    for cid, slot in agg.items():
        cand = db.content_get(cid)
        if not cand:
            continue
        # Drop same-source duplicates (re-uploads / mirrors of the same item).
        if base_source_id and (cand.get("source_id") or "") == base_source_id:
            continue
        top = sorted(slot["sims"], reverse=True)[:_REL_TOP_PAIRS]
        mean = sum(top) / len(top)
        if mean < _REL_MIN_SCORE:
            continue
        scored.append((mean, cid, slot["best"]))

    scored.sort(key=lambda x: x[0], reverse=True)
    results = []
    for mean, cid, best in scored[:_REL_CACHE_MAX]:
        card = _content_card(cid)
        if not card:
            continue
        item = {**card, "score": round(mean, 4)}
        if best is not None:
            _sim, a_chunk, b_hit = best
            item["pair"] = {
                "a_start_ms": a_chunk["start_ms"], "a_text": a_chunk["text"],
                "b_start_ms": b_hit["start_ms"], "b_text": b_hit["text"],
                "score": round(best[0], 4),
            }
        results.append(item)

    # Cache the full top-N (limit-independent); callers slice to their own limit.
    payload = {"content_id": content_id, "results": results}
    db.related_cache_set(content_id, version, json.dumps(payload))
    return {"content_id": content_id, "results": results[:limit]}


def content_map(content_id: str, depth: int = 1) -> dict[str, Any]:
    """The "Carte" data: a graph ALWAYS centred on `content_id`. Depth 1 = the
    focal node + its direct links (≤12); depth 2 also pulls the links-of-links
    (≤25 nodes total). Edges include neighbour↔neighbour links (not only to the
    centre) above the score floor — that's what reveals clusters. Each edge
    carries the best existing passage pair. Cheap: it composes the (cached)
    related() payloads, so its invalidation follows related's index version."""
    depth = 2 if int(depth or 1) >= 2 else 1
    center = db.content_get(content_id)
    if not center:
        return {"center_id": content_id, "depth": depth, "nodes": [], "edges": []}

    def _node(card: dict[str, Any], ring: int, score_to_center: float) -> dict[str, Any]:
        return {
            "content_id": card["id"],
            "title": card.get("title") or "",
            "thumbnail": card.get("thumbnail_url"),
            "duration": card.get("duration_seconds"),
            "channel": card.get("channel") or "",
            "score_to_center": round(score_to_center, 4),
            "ring": ring,
        }

    order: list[str] = [content_id]
    node_of: dict[str, dict[str, Any]] = {content_id: _node(_content_card(content_id) or {"id": content_id}, 0, 1.0)}

    d1 = related(content_id, limit=_MAP_MAX_D1)["results"]
    for r in d1:
        if r["id"] in node_of:
            continue
        node_of[r["id"]] = _node(r, 1, r["score"])
        order.append(r["id"])

    if depth == 2:
        for r in d1:
            if len(node_of) >= _MAP_MAX_TOTAL:
                break
            for rr in related(r["id"], limit=_MAP_MAX_D1)["results"]:
                if len(node_of) >= _MAP_MAX_TOTAL:
                    break
                if rr["id"] in node_of or rr["score"] < _REL_MIN_SCORE:
                    continue
                # No direct centre score for a ring-2 node; use the score along
                # the path that introduced it (parent link × neighbour score).
                node_of[rr["id"]] = _node(rr, 2, rr["score"] * r["score"])
                order.append(rr["id"])

    ids = set(node_of)
    # Edges: every related() link that lands on another node in the set, deduped
    # on the unordered pair, keeping the highest-scoring orientation.
    edges: dict[frozenset[str], dict[str, Any]] = {}
    for x in ids:
        for r in related(x, limit=_MAP_MAX_D1)["results"]:
            y = r["id"]
            if y not in ids:
                continue
            key = frozenset((x, y))
            if len(key) < 2 or r["score"] < _REL_MIN_SCORE:
                continue
            prev = edges.get(key)
            if prev is not None and prev["score"] >= r["score"]:
                continue
            p = r.get("pair") or {}
            edges[key] = {
                "a": x, "b": y, "score": round(r["score"], 4),
                "pair": {
                    "a_start_ms": p.get("a_start_ms"), "a_text": p.get("a_text"),
                    "b_start_ms": p.get("b_start_ms"), "b_text": p.get("b_text"),
                },
            }

    return {
        "center_id": content_id,
        "depth": depth,
        "nodes": [node_of[i] for i in order],
        "edges": list(edges.values()),
    }


def map_start() -> dict[str, Any]:
    """The best default entry point for the Carte: the last-opened content if it
    has links, else the most-connected content in the library. Bounded scan."""
    # 1) Last opened (most recent seen_at) among indexed contents, if it links.
    for cid in db.map_start_candidates(limit=1, seen_only=True):
        if related(cid, limit=1)["results"]:
            return {"content_id": cid}
    # 2) Most connected among a bounded, recent set (cached related() keeps it cheap).
    best_id, best_n = None, 0
    for cid in db.map_start_candidates(limit=60):
        n = len(related(cid, limit=_MAP_MAX_D1)["results"])
        if n > best_n:
            best_id, best_n = cid, n
    return {"content_id": best_id}


# --- search (hybrid, RRF) --------------------------------------------------
def query_hash(q: str) -> str:
    """Stable, privacy-preserving id of a query for LOCAL instrumentation."""
    norm = " ".join(re.findall(r"\w+", q.lower()))
    return hashlib.sha256(norm.encode("utf-8")).hexdigest()[:16]


def _parse_highlights(snippet: str) -> tuple[str, list[list[int]]]:
    """Turn an FTS snippet with STX/ETX markers into clean text + char offsets
    [[start, end], …] of the highlighted spans (offsets into the clean text)."""
    if _HL_OPEN not in snippet:
        return snippet, []
    out: list[str] = []
    spans: list[list[int]] = []
    pos = 0
    start = -1
    for ch in snippet:
        if ch == _HL_OPEN:
            start = pos
        elif ch == _HL_CLOSE:
            if start >= 0:
                spans.append([start, pos])
                start = -1
        else:
            out.append(ch)
            pos += 1
    return "".join(out), spans


def _passes_filters(card: dict[str, Any], row: dict[str, Any], f: dict[str, Any]) -> bool:
    if f.get("source") and (row.get("source") or "") != f["source"]:
        return False
    if f.get("channel") and (row.get("channel") or "") != f["channel"]:
        return False
    dur = row.get("duration_seconds") or 0
    if f.get("min_duration") is not None and dur < f["min_duration"]:
        return False
    if f.get("max_duration") is not None and dur > f["max_duration"]:
        return False
    since = f.get("since_ts")
    if since is not None:
        dl = row.get("downloaded_at") or 0
        if dl < since:
            return False
    return True


def search(
    q: str,
    scope: str = "all",
    limit: int = 20,
    *,
    passage_limit: int = 3,
    source: str | None = None,
    channel: str | None = None,
    period: str | None = None,
    min_duration: int | None = None,
    max_duration: int | None = None,
    record: bool = True,
) -> dict[str, Any]:
    t0 = time.monotonic()
    content_id = None if scope in (None, "", "all") else scope
    tokens = re.findall(r"\w+", q.lower())
    filters = {
        "source": source or None,
        "channel": channel or None,
        "min_duration": min_duration,
        "max_duration": max_duration,
        "since_ts": (time.time() - _PERIOD_DAYS[period] * 86400) if period in _PERIOD_DAYS else None,
    }
    # Fetch enough hits to fill per-content passage lists after grouping.
    fetch = max(limit, passage_limit) * 4

    seg_hits = db.fts_segments(tokens, fetch, content_id)
    con_hits = db.fts_contents(tokens, fetch, content_id)
    note_hits = db.fts_notes(tokens, fetch, content_id)
    sem_hits: list[dict[str, Any]] = []
    if db.VEC_OK and q.strip():
        try:
            knn = db.vec_knn(embed_query(q), fetch)
            sem_hits = [h for h in knn if not content_id or h["content_id"] == content_id]
        except Exception as exc:  # noqa: BLE001 — semantic branch never breaks search
            print(f"[indexer] semantic search failed: {exc}", flush=True)

    # RRF fuse the ranked lists into a per-content score; collect passages.
    scores: dict[str, float] = {}
    passages: dict[str, list[dict[str, Any]]] = {}

    def add(cid: str, rank: int) -> float:
        s = 1.0 / (_RRF_K + rank + 1)
        scores[cid] = scores.get(cid, 0.0) + s
        return s

    for rank, h in enumerate(seg_hits):
        s = add(h["content_id"], rank)
        text, highlights = _parse_highlights(h["snippet"])
        passages.setdefault(h["content_id"], []).append({
            "start_ms": h["start_ms"], "text": text, "highlights": highlights,
            "match_type": "lexical", "score": s,
        })
    for rank, h in enumerate(sem_hits):
        s = add(h["content_id"], rank)
        passages.setdefault(h["content_id"], []).append({
            "start_ms": h["start_ms"], "text": h["text"], "highlights": [],
            "match_type": "semantic", "score": s,
        })
    # Notes are a first-class source: a note hit yields a typed passage carrying
    # the note text + the highlighted verbatim.
    for rank, h in enumerate(note_hits):
        s = add(h["content_id"], rank)
        passages.setdefault(h["content_id"], []).append({
            "start_ms": h["start_ms"], "text": h["note"], "verbatim": h.get("text") or "",
            "highlights": [], "match_type": "note", "score": s, "highlight_id": h["highlight_id"],
        })
    for rank, h in enumerate(con_hits):
        add(h["content_id"], rank)  # metadata boost, no timestamped passage

    # Attention-weighted memory: a light RRF bonus when a content's matched
    # passages fall inside a user highlight (a plain highlight boosts without a
    # dedicated index — its text already lives in segments_fts).
    for cid, ps in passages.items():
        spans = db.highlights_spans(cid)
        if spans and any(any(s <= p["start_ms"] < e for s, e in spans) for p in ps):
            scores[cid] = scores.get(cid, 0.0) + _HL_BONUS

    results = []
    for cid in sorted(scores, key=lambda c: scores[c], reverse=True):
        row = db.content_get(cid)
        card = _content_card(cid)
        if not row or not card:
            continue
        if not _passes_filters(card, row, filters):
            continue
        all_ps = _dedupe_passages(passages.get(cid, []))
        results.append({
            **card,
            "score": round(scores[cid], 5),
            "passages": all_ps[:passage_limit],
            "passage_total": len(all_ps),
        })
        if len(results) >= limit:
            break

    idx = db.index_stats()
    qh = query_hash(q)
    # Only top-level (whole-library) searches count as a "search"; scoped calls
    # (passage pagination within one content) are refinements, not new searches.
    if record and q.strip() and content_id is None:
        db.search_event_insert(qh, len(results))

    return {
        "query": q,
        "query_hash": qh,
        "took_ms": round((time.monotonic() - t0) * 1000, 1),
        "count": len(results),
        "indexed": idx.get("indexed", 0),
        "total": idx.get("total", 0),
        "semantic": db.VEC_OK,
        "results": results,
    }


_PTYPE_RANK = {"note": 2, "lexical": 1, "semantic": 0}


def _dedupe_passages(ps: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Collapse passages at (nearly) the same moment, preferring a note, then a
    lexical (carries highlight offsets), then by score. Sorted best-score first."""
    best: dict[int, dict[str, Any]] = {}
    for p in ps:
        key = int(p["start_ms"] / 1000)  # 1 s bucket
        cur = best.get(key)
        if cur is None:
            best[key] = p
            continue
        pr, cr = _PTYPE_RANK.get(p["match_type"], 0), _PTYPE_RANK.get(cur["match_type"], 0)
        if pr > cr or (pr == cr and p["score"] > cur["score"]):
            best[key] = p
    return sorted(best.values(), key=lambda p: p["score"], reverse=True)


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
