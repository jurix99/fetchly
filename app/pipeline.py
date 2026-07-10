"""Sequential, journalled event bus that runs a finished download through the
enabled processor and output plugins.

Flow (per job):
  content_downloaded → each ProcessorPlugin (in order) → content_ready
                     → each OutputPlugin (in order)

Every step is timed and written to the `pipeline_runs` table (job_id, plugin_id,
stage, status, duration, error) for observability. A processor/output that
raises is logged and marked "partial" — it NEVER fails the download itself.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from . import db
from .plugins.base import DownloadResult
from .plugins.registry import registry

log = logging.getLogger("pipeline")


def run(job_id: str, result: DownloadResult) -> DownloadResult:
    """Run processors then outputs for a completed download. Returns the
    (possibly enriched) result. Safe: exceptions are contained per-plugin."""
    result = _run_processors(job_id, result)
    _run_outputs(job_id, result)
    return result


def _run_processors(job_id: str, result: DownloadResult) -> DownloadResult:
    for pid, plugin, ctx in registry.processors():
        start = time.monotonic()
        try:
            enriched = plugin.on_content_downloaded(result, ctx)
            if isinstance(enriched, DownloadResult):
                result = enriched
            db.record_pipeline_run(job_id, pid, "content_downloaded", "ok",
                                    time.monotonic() - start)
        except Exception as exc:  # noqa: BLE001 — a processor never fails the DL
            log.warning("processor %s failed on job %s: %s", pid, job_id, exc)
            db.record_pipeline_run(job_id, pid, "content_downloaded", "error",
                                   time.monotonic() - start, str(exc))
    return result


def _run_outputs(job_id: str, result: DownloadResult) -> None:
    for pid, plugin, ctx in registry.outputs():
        start = time.monotonic()
        try:
            plugin.on_content_ready(result, ctx)
            db.record_pipeline_run(job_id, pid, "content_ready", "ok",
                                   time.monotonic() - start)
        except Exception as exc:  # noqa: BLE001
            log.warning("output %s failed on job %s: %s", pid, job_id, exc)
            db.record_pipeline_run(job_id, pid, "content_ready", "error",
                                   time.monotonic() - start, str(exc))


def has_consumers() -> bool:
    """Whether any processor/output is enabled (skip pipeline work otherwise)."""
    return bool(registry.processors() or registry.outputs())
