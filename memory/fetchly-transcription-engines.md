---
name: fetchly-transcription-engines
description: Fetchly's Transcriber interface (local Whisper vs cloud STT) and how the cloud engine works
metadata:
  type: project
---

Transcription has a **Transcriber interface**: `transcribe.transcribe_media(path, settings, on_progress, cancel) -> (language, segments)` dispatches on `settings["engine"]` (`local` default | `cloud`). Everything downstream (`.srt`/`.vtt`, `db.segments_replace`, search indexing, summary/chapter generation via [[fetchly-intelligence-llm]], statuses, the queue, night window) is identical for both — it only sees `(language, segments)`.

- **LocalWhisper** = `transcribe._local_transcribe_media` (faster-whisper, unchanged default).
- **CloudSTT** = [app/cloud_stt.py](app/cloud_stt.py), stdlib `urllib` multipart. One protocol: OpenAI-compatible `POST {base}/audio/transcriptions` (OpenAI `whisper-1`, Groq `whisper-large-v3-turbo`, Mistral `voxtral-mini-latest`). Always ffmpeg-extracts mono/16 kHz/AAC ~48 kbps first (video never uploaded); if > ~22 MB, splits into 10-min slices with 5 s overlap and re-stitches with timestamp offset + text-similarity dedup at joins (`_merge_overlap`). Parses `verbose_json` `segments` (fallbacks: `words` grouping, then bare `text`). 2 retries on 429/5xx; temp files always deleted.
- **Opt-in only:** default engine `local`; no audio leaves the box unless engine=cloud AND a key is set. Settings live on the **whisper plugin** ([whisper_processor.py](app/plugins/builtin/whisper_processor.py)): `engine`, `cloud_preset`, `cloud_base_url`, `cloud_model`, `cloud_api_key` (secret). Cloud connection test = plugin action `test_cloud` (sends 5 s of ffmpeg silence). Monthly minutes counter in `db.cloud_stt_add_minutes`/`cloud_stt_stats` (meta keys, monthly reset), surfaced in `transcribe.status()`.
- Frontend: engine-aware Whisper card + conditional fields + cloud preset prefill in [plugins-panel.tsx](frontend/components/plugins-panel.tsx); cloud icon on jobs in [downloads-view.tsx](frontend/components/views/downloads-view.tsx). `TJob.engine` carries local/cloud (not persisted — cosmetic).
