"""Fetchly — self-hosted media downloader/archiver.

This file is intentionally thin: it assembles the FastAPI app, wires the route
modules, and runs startup. All behaviour lives in focused modules:

  runtime.py            shared paths + disk/memory helpers
  db.py / store.py      SQLite jobs + JSON config
  jobs.py               download job engine (status, persistence, control)
  watches.py            subscription scheduler + checks
  pipeline.py           processor/output event bus
  plugins/              plugin system (base contracts, registry)
  plugins/builtin/      the yt-dlp source plugin (the ONLY yt_dlp importer)
  routes/               HTTP endpoints (thin; delegate to the modules above)

See docs/PLUGINS.md for the plugin architecture.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from . import db, generate, jobs, library, store, transcribe, watches
from .plugins.registry import registry
from .runtime import DOWNLOAD_DIR, WEB_DIR
from .routes import (
    annotations,
    content,
    digest as digest_routes,
    downloads,
    feeds,
    files,
    generate as generate_routes,
    intelligence,
    library as library_routes,
    plugins,
    search,
    settings,
    system,
    transcripts,
    watches as watches_routes,
)

app = FastAPI(title="Fetchly — Video Downloader", version="0.2.0")

# Serve downloaded media so videos/thumbnails can be browsed from the UI.
app.mount("/media", StaticFiles(directory=str(DOWNLOAD_DIR)), name="media")

# API routers (registered before the SPA catch-all mount below).
for module in (
    downloads, watches_routes, content, settings, files, system, plugins,
    library_routes, transcripts, search, intelligence, generate_routes,
    digest_routes, annotations, feeds,
):
    app.include_router(module.router)


@app.on_event("startup")
def _on_startup() -> None:
    db.init()
    # Sweep index rows orphaned by crashes or off-band file removal (keepLastN),
    # so the KNN isn't polluted by vectors pointing at gone contents.
    gc = db.gc_orphans()
    if any(gc.values()):
        print(f"[startup] gc: {gc}", flush=True)
    # Load builtin + user plugins (failures are isolated, never block boot).
    registry.discover()
    # Rebuild the job cache and re-queue anything a restart interrupted. Only run
    # the blanket .part sweep when there is nothing to resume.
    resumed = jobs.restore()
    if not resumed:
        watches.cleanup_partials()
    jobs._prune_jobs()
    jobs.set_concurrency(store.get_settings().get("max_concurrent", 3))
    watches.start_scheduler()
    # One-time backfill of the library from the existing downloads (guarded by a
    # DB flag; runs in the background so startup isn't blocked).
    library.migrate_existing()
    # Restore the transcription queue (running → re-queued) and start its worker.
    transcribe.restore_and_start()
    # Restore the generation (summary + chapters) queue and start its worker.
    generate.restore_and_start()


# Mounted LAST so the API routes take precedence; serves the built SPA.
app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="spa")
