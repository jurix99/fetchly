/**
 * Typed client for the FastAPI backend (yt-dlp). Same-origin: the static export
 * is served by FastAPI, so "/api/..." hits the real server.
 */

export interface BackendJob {
  id: string
  url: string
  kind: "manual" | "watch"
  quality: string
  status: "queued" | "running" | "done" | "error"
  phase?: "downloading" | "processing"
  total: number
  completed: number
  downloaded: number
  current_title: string
  current_percent: number
  current_speed: string
  files: string[]
  created_at: number
}

export interface BackendWatch {
  id: string
  url: string
  quality: string | null
  subfolder?: string
  date_after?: string
  title: string
  enabled: boolean
  backfill: boolean
  synced?: number
  total?: number
  last_checked: string | null
  last_result: string
}

export interface BackendSettings {
  default_quality: string
  watch_interval_minutes: number
  organize: string
  download_dir: string
  qualities: string[]
}

export interface BackendFile {
  name: string
  folder: string
  url: string
  thumb: string | null
  size: number
  mtime: number
}

export interface ExtractedVideo {
  id: string
  title: string
  thumbnail: string
  duration: string
  channel: string
  source: string
  url: string
  uploaded?: string
}

export interface ExtractResult extends ExtractedVideo {
  kind: "video" | "playlist"
  uploader?: string
  count?: number
  videos?: ExtractedVideo[]
  error?: string
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return res.json().catch(() => ({})) as Promise<T>
}

export const backend = {
  jobs: () => call<BackendJob[]>("GET", "/api/jobs"),
  download: (b: { url: string; quality: string; format: string; subfolder?: string }) =>
    call<{ job_id?: string; error?: string }>("POST", "/api/download", b),
  extract: (url: string) => call<ExtractResult>("POST", "/api/extract", { url }),
  watches: () => call<BackendWatch[]>("GET", "/api/watches"),
  addWatch: (b: {
    url: string
    quality: string
    backfill: boolean
    subfolder: string
    date_after: string
  }) => call<BackendWatch & { error?: string }>("POST", "/api/watches", b),
  patchWatch: (id: string, b: Partial<{ enabled: boolean; quality: string; subfolder: string }>) =>
    call<BackendWatch>("PATCH", `/api/watches/${id}`, b),
  removeWatch: (id: string) => call<{ removed: boolean }>("DELETE", `/api/watches/${id}`),
  checkWatch: (id: string) => call<{ status: string }>("POST", `/api/watches/${id}/check`),
  settings: () => call<BackendSettings>("GET", "/api/settings"),
  saveSettings: (b: Partial<{ default_quality: string; watch_interval_minutes: number; organize: string }>) =>
    call<BackendSettings>("POST", "/api/settings", b),
  files: () => call<BackendFile[]>("GET", "/api/files"),
}

// --- quality label mapping (frontend <-> backend) ---
const Q_TO_BACKEND: Record<string, string> = {
  Auto: "best",
  "1080p": "1080",
  "720p": "720",
  "480p": "480",
  "Audio seul": "audio",
}
const Q_TO_FRONTEND: Record<string, string> = {
  best: "Auto",
  "2160": "1080p",
  "1440": "1080p",
  "1080": "1080p",
  "720": "720p",
  "480": "480p",
  audio: "Audio seul",
}

export const qualityToBackend = (q: string) => Q_TO_BACKEND[q] ?? q
export const qualityToFrontend = (q: string | null | undefined) =>
  (q && (Q_TO_FRONTEND[q] ?? (["Auto", "1080p", "720p", "480p", "Audio seul"].includes(q) ? q : "Auto"))) || "Auto"
