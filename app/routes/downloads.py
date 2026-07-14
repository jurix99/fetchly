"""Download + job-control routes (thin: delegate to the jobs engine)."""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from .. import jobs, store
from ..runtime import _GB, _check_disk_alert, _disk_info, _disk_too_full
from ..schemas import DownloadRequest

router = APIRouter()


@router.post("/api/download")
async def start_download(req: DownloadRequest) -> JSONResponse:
    if not req.url.strip():
        return JSONResponse({"error": "URL is required"}, status_code=400)
    if _disk_too_full():
        free = round(_disk_info()["free"] / _GB, 1)
        _check_disk_alert()
        return JSONResponse(
            {"error": f"Espace disque insuffisant ({free} Go libres). Libère de la place."},
            status_code=507,
        )
    quality = req.quality or store.get_settings()["default_quality"]
    # Extraction metadata (if the client sent a preview) seeds a 'pending' content
    # card so it appears in Mémoire immediately.
    meta = None
    if req.title or req.thumbnail or req.channel:
        meta = {
            "title": req.title,
            "thumbnail_path": req.thumbnail,
            "channel": req.channel,
            "duration_seconds": req.duration_seconds,
            "source": req.source,
            "url": req.url.strip(),
        }
    job_id = jobs.create_download(
        req.url,
        quality,
        req.format or "MP4",
        req.subfolder,
        use_archive=bool(store.get_settings().get("download_archive", False)),
        meta=meta,
    )
    return JSONResponse({"job_id": job_id})


@router.get("/api/status/{job_id}")
async def status(job_id: str) -> JSONResponse:
    payload = jobs.status_payload(job_id)
    if payload is None:
        return JSONResponse({"error": "Unknown job"}, status_code=404)
    return JSONResponse(payload)


@router.get("/api/jobs")
async def list_jobs() -> JSONResponse:
    return JSONResponse(jobs.list_payload())


@router.get("/api/jobs/restored")
async def jobs_restored() -> JSONResponse:
    return JSONResponse(jobs.restored_state())


@router.post("/api/jobs/pause-all")
async def pause_all() -> JSONResponse:
    return JSONResponse(jobs.pause_all())


@router.post("/api/jobs/resume-all")
async def resume_all() -> JSONResponse:
    return JSONResponse(jobs.resume_all())


@router.post("/api/jobs/{job_id}/pause")
async def pause_job(job_id: str) -> JSONResponse:
    body, code = jobs.pause(job_id)
    return JSONResponse(body, status_code=code)


@router.post("/api/jobs/{job_id}/resume")
async def resume_job(job_id: str) -> JSONResponse:
    body, code = jobs.resume(job_id)
    return JSONResponse(body, status_code=code)


@router.post("/api/jobs/{job_id}/cancel")
async def cancel_job(job_id: str) -> JSONResponse:
    body, code = jobs.cancel(job_id)
    return JSONResponse(body, status_code=code)


@router.post("/api/jobs/{job_id}/retry")
async def retry_job(job_id: str) -> JSONResponse:
    body, code = jobs.retry(job_id)
    return JSONResponse(body, status_code=code)
