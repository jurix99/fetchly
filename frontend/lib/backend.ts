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
  current_thumbnail?: string
  current_percent: number
  current_speed: string
  files: string[]
  playlist_title?: string
  watch_id?: string | null
  created_at: number
}

export interface BackendWatch {
  id: string
  url: string
  quality: string | null
  subfolder?: string
  date_after?: string
  title: string
  thumbnail?: string | null
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
  max_concurrent: number
  download_dir: string
  qualities: string[]
  // Media options (applied to yt-dlp).
  subtitles?: boolean
  subtitle_langs?: string
  embed_subtitles?: boolean
  embed_thumbnail?: boolean
  embed_metadata?: boolean
  embed_chapters?: boolean
  sponsorblock?: boolean
  sponsorblock_mode?: string
  bandwidth_limit?: number
  download_archive?: boolean
  min_free_gb?: number
  nfo_export?: boolean
}

export interface BackendDisk {
  free: number
  total: number
  used: number
  percent: number
  free_gb: number
  total_gb: number
  min_free_gb: number
  low: boolean
}

export type MediaSettings = Partial<{
  subtitles: boolean
  subtitle_langs: string
  embed_subtitles: boolean
  embed_thumbnail: boolean
  embed_metadata: boolean
  embed_chapters: boolean
  sponsorblock: boolean
  sponsorblock_mode: string
  bandwidth_limit: number
  download_archive: boolean
  min_free_gb: number
  nfo_export: boolean
}>

export interface BackendNotifications {
  enabled: boolean
  urls: string[]
  on_video?: boolean
  on_error?: boolean
  on_summary?: boolean
  available?: boolean
}

export interface SubscribedChannel {
  url: string
  name: string
  avatar?: string
  followed?: boolean
}

export interface BackendCookies {
  present: boolean
  count: number
  source: "uploaded" | "mounted" | null
  updated_at: number | null
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
  avatar?: string
  count?: number
  videos?: ExtractedVideo[]
  error?: string
}

export interface SearchResult {
  query: string
  videos: ExtractedVideo[]
  channels: { name: string; url: string }[]
  error?: string
}

export interface ChannelInfoResult {
  name: string
  avatar: string
  url: string
  subscribers?: number | null
  count?: number | null
  error?: string
}

export interface ChannelVideosResult {
  videos: ExtractedVideo[]
  offset: number
  limit: number
  has_more: boolean
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
  extract: (url: string, limit?: number) =>
    call<ExtractResult>("POST", "/api/extract", { url, limit }),
  channelInfo: (url: string) => call<ChannelInfoResult>("POST", "/api/channel", { url }),
  channelVideos: (url: string, offset: number, limit: number) =>
    call<ChannelVideosResult>("POST", "/api/channel/videos", { url, offset, limit }),
  search: (query: string) => call<SearchResult>("POST", "/api/search", { query }),
  watches: () => call<BackendWatch[]>("GET", "/api/watches"),
  addWatch: (b: {
    url: string
    quality: string
    backfill: boolean
    subfolder: string
    date_after: string
    title?: string
    thumbnail?: string
  }) => call<BackendWatch & { error?: string }>("POST", "/api/watches", b),
  patchWatch: (
    id: string,
    b: Partial<{ enabled: boolean; quality: string; subfolder: string; date_after: string }>,
  ) => call<BackendWatch>("PATCH", `/api/watches/${id}`, b),
  removeWatch: (id: string) => call<{ removed: boolean }>("DELETE", `/api/watches/${id}`),
  checkWatch: (id: string) => call<{ status: string }>("POST", `/api/watches/${id}/check`),
  youtubeSubscriptions: () =>
    call<{ channels?: SubscribedChannel[]; error?: string }>(
      "GET",
      "/api/youtube/subscriptions",
    ),
  followSubscriptions: (channels: { url: string; title: string; avatar?: string }[], backfill = false) =>
    call<{ added?: number; error?: string }>("POST", "/api/youtube/subscriptions/follow", {
      channels,
      backfill,
    }),
  settings: () => call<BackendSettings>("GET", "/api/settings"),
  saveSettings: (
    b: Partial<{
      default_quality: string
      watch_interval_minutes: number
      organize: string
      max_concurrent: number
    }> &
      MediaSettings,
  ) => call<BackendSettings>("POST", "/api/settings", b),
  files: () => call<BackendFile[]>("GET", "/api/files"),
  disk: () => call<BackendDisk>("GET", "/api/disk"),
  notifications: () => call<BackendNotifications>("GET", "/api/notifications"),
  saveNotifications: (b: {
    enabled?: boolean
    urls?: string[]
    on_video?: boolean
    on_error?: boolean
    on_summary?: boolean
  }) => call<BackendNotifications>("POST", "/api/notifications", b),
  testNotifications: (b: { urls?: string[] }) =>
    call<{ ok: boolean; message: string }>("POST", "/api/notifications/test", b),
  cookies: () => call<BackendCookies>("GET", "/api/cookies"),
  saveCookies: (content: string) =>
    call<BackendCookies & { ok: boolean; message: string }>("POST", "/api/cookies", { content }),
  clearCookies: () => call<BackendCookies & { removed: boolean }>("DELETE", "/api/cookies"),
}

// --- quality label mapping (frontend <-> backend) ---
const Q_TO_BACKEND: Record<string, string> = {
  Auto: "best",
  "2160p (4K)": "2160",
  "1440p": "1440",
  "1080p": "1080",
  "720p": "720",
  "480p": "480",
  "Audio seul": "audio",
}
const Q_TO_FRONTEND: Record<string, string> = {
  best: "Auto",
  "2160": "2160p (4K)",
  "1440": "1440p",
  "1080": "1080p",
  "720": "720p",
  "480": "480p",
  audio: "Audio seul",
}

const FRONTEND_QUALITIES = ["Auto", "2160p (4K)", "1440p", "1080p", "720p", "480p", "Audio seul"]

export const qualityToBackend = (q: string) => Q_TO_BACKEND[q] ?? q
export const qualityToFrontend = (q: string | null | undefined) =>
  (q && (Q_TO_FRONTEND[q] ?? (FRONTEND_QUALITIES.includes(q) ? q : "Auto"))) || "Auto"
