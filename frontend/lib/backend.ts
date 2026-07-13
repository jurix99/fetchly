/**
 * Typed client for the FastAPI backend (yt-dlp). Same-origin: the static export
 * is served by FastAPI, so "/api/..." hits the real server.
 */

import type { SubscriptionFilters } from "@/lib/types"

export interface BackendJob {
  id: string
  url: string
  kind: "manual" | "watch"
  quality: string
  status: "queued" | "running" | "paused" | "done" | "error" | "canceled"
  phase?: "downloading" | "processing"
  total: number
  completed: number
  downloaded: number
  current_title: string
  current_thumbnail?: string
  current_percent: number
  current_speed: string
  files: string[]
  error?: string
  playlist_title?: string
  watch_id?: string | null
  created_at: number
  paused_at?: number | null
  canceled_at?: number | null
  finished_at?: number | null
  reports?: { plugin?: string; label: string; ok: boolean; detail?: string }[]
}

/** Content filters as the API stores them (snake_case; durations in SECONDS). */
export interface BackendFilters {
  min_duration?: number | null
  max_duration?: number | null
  exclude_shorts: boolean
  exclude_lives: boolean
  include_keywords: string[]
  exclude_keywords: string[]
  keep_last_n?: number | null
}

/** Effect of the filters at the last check, surfaced on the subscription card. */
export interface BackendLastCheck {
  listed: number
  matched: number
  rejected_by_filters: number
  downloaded: number
  at?: string
}

export interface BackendWatch {
  id: string
  url: string
  quality: string | null
  subfolder?: string
  date_after?: string
  exclude_shorts?: boolean
  exclude_lives?: boolean
  filters?: BackendFilters
  last_check?: BackendLastCheck | null
  title: string
  thumbnail?: string | null
  enabled: boolean
  backfill: boolean
  podcast_feed?: boolean
  synced?: number
  total?: number
  last_checked: string | null
  last_result: string
}

export interface PreviewFiltersResult {
  listed: number
  kept: number
  rejected: number
  rejections: { title: string; reason: string }[]
  error?: string
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

export type PluginFieldType = "bool" | "str" | "int" | "select"

export interface PluginField {
  key: string
  type: PluginFieldType
  label: string
  help: string
  default: unknown
  options: string[] | null
  secret?: boolean
}

export interface PluginAction {
  id: string
  label: string
  kind: "generic" | "test" | "backfill"
  confirm: boolean
}

export interface PluginInfo {
  id: string
  name: string
  type: "source" | "processor" | "output" | "unknown"
  version: string
  description: string
  builtin: boolean
  critical: boolean
  enabled: boolean
  status: "active" | "disabled" | "error"
  error: string
  settings_schema: PluginField[]
  actions: PluginAction[]
  settings: Record<string, unknown>
}

export type TranscriptStatus = "none" | "queued" | "running" | "done" | "error" | "skipped"

export interface Content {
  id: string
  source: string
  source_id: string
  url: string
  title: string
  description: string
  channel: string
  channel_url: string
  duration_seconds: number | null
  uploaded_at: string
  downloaded_at: number | null
  filepath: string
  filesize: number | null
  thumbnail_path: string | null
  watch_id: string | null
  kind: "video" | "audio"
  transcript_status: TranscriptStatus
  index_status: "none" | "done" | "stale"
  // intelligence brick (summary + chapters)
  summary_short: string | null
  summary_long: string | null
  summary_model: string | null
  summary_generated_at: number | null
  generation_status: GenerationStatus
  chapter_count: number
  // digest (phase 3)
  seen_at: number | null
  watch_later: boolean
  // added by the API serializer
  thumbnail_url: string | null
  stream_url: string
  file_exists: boolean
}

export type GenerationStatus = "none" | "queued" | "running" | "done" | "error"

/** LLM provider config. `has_key` replaces the secret in responses. */
export interface IntelligenceSettings {
  preset: string
  protocol: "openai_compatible" | "anthropic"
  base_url: string
  model: string
  style: "concis" | "détaillé"
  output_language: string
  has_key: boolean
}

export interface IntelligencePreset {
  id: string
  label: string
  protocol: "openai_compatible" | "anthropic"
  base_url: string
  model: string
  needs_key: boolean
  key_url: string
  cost_hint: string
  install_hint: string
  local: boolean
}

export interface TestConnectionResult {
  ok: boolean
  message: string
  model?: string
  sample?: string
}

export interface GenerationJob {
  id: string
  content_id: string
  task: string
  title: string
  status: "queued" | "running" | "done" | "error" | "canceled"
  error: string
  model: string
  calls: number
  created_at: number
}

export interface Chapter {
  start_ms: number
  title: string
}

// --- Highlights + clips (attention capteurs) ------------------------------
export interface Highlight {
  id: number
  content_id: string
  start_ms: number
  end_ms: number
  text: string
  note: string | null
  color: string
  created_at: number
  // present on the global /api/highlights list
  content_title?: string
  content_channel?: string
  content_thumbnail_url?: string | null
}

export interface Clip {
  id: string
  content_id: string
  path: string
  format: "video" | "audio"
  start_ms: number
  end_ms: number
  created_at: number
  name: string
  url: string
  exists: boolean
}

// --- Podcast feeds --------------------------------------------------------
export interface FeedsConfig {
  enabled: boolean
  audio_format: "m4a" | "opus"
  bitrate: string
  token: string
  public_base_url: string
  all_feed_url: string
  stats: { active_feeds: number; episodes_ready: number; audio_bytes: number }
}

export interface WatchFeedStatus {
  watch_id: string
  podcast_feed: boolean
  has_base: boolean
  url: string
  episodes_ready: number
  missing_count: number
}

export interface LibraryPage {
  items: Content[]
  total: number
  limit: number
  offset: number
}

export interface LibraryQuery {
  limit?: number
  offset?: number
  sort?: "downloaded_at" | "title" | "duration_seconds"
  order?: "asc" | "desc"
  source?: string
  watch_id?: string
  kind?: "video" | "audio"
  q?: string
  transcribed?: "yes" | "no"
}

export interface TranscriptSegment {
  start_ms: number
  end_ms: number
  text: string
}

export interface TranscriptJob {
  id: string
  content_id: string
  title: string
  status: "queued" | "running" | "done" | "error" | "canceled"
  progress: number
  model: string
  engine?: "local" | "cloud"
  created_at: number
  duration_ms?: number | null
  error?: string
}

export interface TranscriptStatusInfo {
  enabled: boolean
  device: string
  model: string
  model_size: string
  last_speed: string | null
  active: number
  schedule: string
  window_open: boolean
  // Cloud engine (optional; default local)
  engine?: "local" | "cloud"
  cloud_preset?: string
  cloud_minutes?: number
  cloud_month?: string
}

export interface TranscriptDetail {
  status: TranscriptStatus
  language: string | null
  segments: TranscriptSegment[]
  source_subs: boolean
  srt_url: string | null
  vtt_url: string | null
  job: TranscriptJob | null
  error?: string
}

export interface IndexStats {
  total: number
  indexed: number
  chunks: number
  db_bytes: number
  vec_ok: boolean
  semantic: boolean
  embedding_model: string
  embedding_lang: string
}

export interface SearchPassage {
  start_ms: number
  text: string
  /** Char offsets [start, end) of highlighted spans within `text` (lexical only). */
  highlights?: [number, number][]
  match_type: "lexical" | "semantic" | "note"
  /** For a "note" passage: the highlighted verbatim behind the note. */
  verbatim?: string
  highlight_id?: number
  score: number
}

export interface LibrarySearchResult {
  id: string
  title: string
  channel: string
  source: string
  duration_seconds: number | null
  thumbnail_url: string | null
  score: number
  passages: SearchPassage[]
  passage_total?: number
}

export interface LibrarySearchResponse {
  query: string
  query_hash: string
  took_ms: number
  count: number
  /** Index coverage context for pedagogical empty/partial states. */
  indexed: number
  total: number
  semantic: boolean
  results: LibrarySearchResult[]
}

/** Optional facet filters for the full results page (durations in SECONDS). */
export interface SearchFilters {
  source?: string
  channel?: string
  period?: "week" | "month" | "quarter" | "year"
  min_duration?: number
  max_duration?: number
  passage_limit?: number
}

/** One content close to the current one (shared "Dans votre bibliothèque"). */
export interface RelatedResult {
  id: string
  title: string
  channel: string
  source: string
  duration_seconds: number | null
  thumbnail_url: string | null
  score: number
  pair?: {
    a_start_ms: number
    a_text: string
    b_start_ms: number
    b_text: string
    score: number
  }
}

export interface RelatedResponse {
  content_id: string
  results: RelatedResult[]
}

export interface SearchMetrics {
  retrievals_week: number
  searches_week: number
  retrievals_total: number
  window_days: number
}

// --- Digest ---------------------------------------------------------------
export interface DigestItem {
  id: string
  title: string
  channel: string
  source: string
  duration_seconds: number | null
  thumbnail_url: string | null
  summary_short: string
  transcript_status: TranscriptStatus
  generation_status: GenerationStatus
  watch_id: string | null
  watch_later: boolean
  downloaded_at: number | null
}

export interface DigestSubscription {
  watch_id: string | null
  name: string
  avatar: string
  count: number
  items: DigestItem[]
}

export interface DigestDay {
  date: string // YYYY-MM-DD
  subscriptions: DigestSubscription[]
}

export interface DigestEcho {
  new: DigestItem
  old: DigestItem
  score: number
  pair: {
    a_start_ms: number
    a_text: string
    b_start_ms: number
    b_text: string
    score: number
  }
}

export interface DigestResponse {
  since: number
  stats: { count: number; total_duration_s: number; watches_count: number }
  new: DigestDay[]
  echoes: DigestEcho[]
  watch_later: DigestItem[]
}

export interface DigestSettings {
  last_seen_at: string
  email_enabled: boolean
  email_day: number // 0=Mon … 6=Sun
  email_hour: number
  email_last_sent: string
  public_base_url: string
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

/** Like `call` but abortable — used to cancel stale live-search requests. The
 *  AbortError propagates so callers can ignore superseded responses. */
async function callSignal<T>(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  })
  return res.json().catch(() => ({})) as Promise<T>
}

/** Result of a job-control call; carries `error` (+ HTTP 409) on invalid transitions. */
export interface JobActionResult {
  status?: string
  error?: string
}

export const backend = {
  jobs: () => call<BackendJob[]>("GET", "/api/jobs"),
  jobsRestored: () => call<{ count: number; at: number }>("GET", "/api/jobs/restored"),
  jobStatus: (id: string) =>
    call<{ status?: string; log?: string[]; error?: string }>("GET", `/api/status/${id}`),
  download: (b: { url: string; quality: string; format: string; subfolder?: string }) =>
    call<{ job_id?: string; error?: string }>("POST", "/api/download", b),
  pauseJob: (id: string) => call<JobActionResult>("POST", `/api/jobs/${id}/pause`),
  resumeJob: (id: string) => call<JobActionResult>("POST", `/api/jobs/${id}/resume`),
  cancelJob: (id: string) => call<JobActionResult>("POST", `/api/jobs/${id}/cancel`),
  retryJob: (id: string) => call<JobActionResult>("POST", `/api/jobs/${id}/retry`),
  pauseAll: () => call<{ paused: number }>("POST", "/api/jobs/pause-all"),
  resumeAll: () => call<{ resumed: number }>("POST", "/api/jobs/resume-all"),
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
    exclude_shorts?: boolean
    exclude_lives?: boolean
    filters?: BackendFilters
  }) => call<BackendWatch & { error?: string }>("POST", "/api/watches", b),
  patchWatch: (
    id: string,
    b: Partial<{
      enabled: boolean
      quality: string
      subfolder: string
      date_after: string
      exclude_shorts: boolean
      exclude_lives: boolean
      filters: BackendFilters
      podcast_feed: boolean
    }>,
  ) => call<BackendWatch>("PATCH", `/api/watches/${id}`, b),
  removeWatch: (id: string) => call<{ removed: boolean }>("DELETE", `/api/watches/${id}`),
  checkWatch: (id: string) => call<{ status: string }>("POST", `/api/watches/${id}/check`),
  previewFilters: (url: string, filters: BackendFilters) =>
    call<PreviewFiltersResult>("POST", "/api/watches/preview-filters", { url, filters }),
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
  library: (query: LibraryQuery = {}) => {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") qs.set(k, String(v))
    }
    const suffix = qs.toString() ? `?${qs}` : ""
    return call<LibraryPage>("GET", `/api/library${suffix}`)
  },
  libraryItem: (id: string) => call<Content & { error?: string }>("GET", `/api/library/${id}`),
  deleteContent: (id: string, deleteFile: boolean) =>
    call<{ removed?: boolean; file_removed?: boolean; error?: string }>(
      "DELETE",
      `/api/library/${id}?delete_file=${deleteFile ? "true" : "false"}`,
    ),
  rescanLibrary: () => call<{ job_id: string; status: string }>("POST", "/api/library/rescan"),
  streamUrl: (id: string) => `/api/library/${id}/stream`,
  // --- transcription ---
  transcriptsStatus: () => call<TranscriptStatusInfo>("GET", "/api/transcripts/status"),
  transcriptJobs: () => call<TranscriptJob[]>("GET", "/api/transcript-jobs"),
  cancelTranscriptJob: (id: string) =>
    call<{ status?: string; error?: string }>("POST", `/api/transcript-jobs/${id}/cancel`),
  transcribeContent: (id: string) =>
    call<{ job_id?: string; error?: string }>("POST", `/api/library/${id}/transcribe`),
  getTranscript: (id: string) => call<TranscriptDetail>("GET", `/api/library/${id}/transcript`),
  backfillTranscripts: (onlyMissing = true) =>
    call<{ queued: number }>("POST", "/api/transcripts/backfill", { only_missing: onlyMissing }),
  // --- intelligence (LLM summaries + chapters) ---
  intelligence: () => call<IntelligenceSettings>("GET", "/api/intelligence"),
  intelligencePresets: () =>
    call<{ presets: IntelligencePreset[] }>("GET", "/api/intelligence/presets"),
  saveIntelligence: (
    b: Partial<{
      preset: string
      protocol: string
      base_url: string
      api_key: string | null
      model: string
      style: string
      output_language: string
    }>,
  ) => call<IntelligenceSettings>("POST", "/api/intelligence", b),
  testIntelligence: () => call<TestConnectionResult>("POST", "/api/intelligence/test"),
  generateContent: (id: string) =>
    call<{ job_id?: string; status?: string; error?: string }>("POST", `/api/library/${id}/generate`),
  generateBackfill: (onlyMissing = true) =>
    call<{ queued?: number; error?: string }>("POST", "/api/generate/backfill", {
      only_missing: onlyMissing,
    }),
  generationJobs: () => call<GenerationJob[]>("GET", "/api/generation-jobs"),
  cancelGenerationJob: (id: string) =>
    call<{ status: string }>("POST", `/api/generation-jobs/${id}/cancel`),
  getChapters: (id: string) =>
    call<{ content_id: string; chapters: Chapter[] }>("GET", `/api/library/${id}/chapters`),
  // --- digest ---
  digest: () => call<DigestResponse>("GET", "/api/digest"),
  digestNewCount: () => call<{ count: number }>("GET", "/api/digest/new-count"),
  digestSeen: (b: { content_ids?: string[]; all?: boolean }) =>
    call<{ ok: boolean }>("POST", "/api/digest/seen", b),
  digestSettings: () => call<DigestSettings>("GET", "/api/digest/settings"),
  saveDigestSettings: (
    b: Partial<{ email_enabled: boolean; email_day: number; email_hour: number; public_base_url: string }>,
  ) => call<DigestSettings>("POST", "/api/digest/settings", b),
  digestEmailPreview: () =>
    call<{ ok: boolean; message: string }>("POST", "/api/digest/email-preview"),
  setWatchLater: (id: string, value: boolean) =>
    call<{ id: string; watch_later: boolean }>("POST", `/api/library/${id}/watch-later`, { value }),
  // --- highlights + notes + clips ---
  createHighlight: (id: string, start_ms: number, end_ms: number) =>
    call<Highlight & { error?: string }>("POST", `/api/library/${id}/highlights`, { start_ms, end_ms }),
  updateHighlightNote: (highlightId: number, note: string | null) =>
    call<Highlight & { error?: string }>("PATCH", `/api/highlights/${highlightId}`, { note }),
  deleteHighlight: (highlightId: number) =>
    call<{ removed?: boolean; error?: string }>("DELETE", `/api/highlights/${highlightId}`),
  highlights: (contentId?: string, limit = 50, offset = 0, sort = "recent") => {
    const qs = new URLSearchParams({ limit: String(limit), offset: String(offset), sort })
    if (contentId) qs.set("content_id", contentId)
    return call<{ items: Highlight[]; total: number }>("GET", `/api/highlights?${qs}`)
  },
  createClip: (id: string, b: { start_ms: number; end_ms: number; format: "video" | "audio" }) =>
    call<{ job_id?: string; status?: string; error?: string }>("POST", `/api/library/${id}/clip`, b),
  listClips: (id: string) =>
    call<{ content_id: string; clips: Clip[] }>("GET", `/api/library/${id}/clips`),
  // --- podcast feeds ---
  feedsConfig: () => call<FeedsConfig>("GET", "/api/feeds/config"),
  saveFeedsConfig: (
    b: Partial<{ enabled: boolean; audio_format: string; bitrate: string }>,
  ) => call<FeedsConfig>("POST", "/api/feeds/config", b),
  regenerateFeedsToken: () => call<{ token: string }>("POST", "/api/feeds/token/regenerate"),
  watchFeedStatus: (watchId: string) =>
    call<WatchFeedStatus>("GET", `/api/feeds/watch/${watchId}`),
  feedsBackfill: (watchId?: string) =>
    call<{ job_id?: string; error?: string }>("POST", "/api/feeds/backfill", { watch_id: watchId }),
  // --- search & index ---
  searchLibrary: (
    q: string,
    scope = "all",
    limit = 20,
    filters?: SearchFilters,
    signal?: AbortSignal,
  ) => {
    const qs = new URLSearchParams({ q, scope, limit: String(limit) })
    if (filters) {
      for (const [k, v] of Object.entries(filters)) {
        if (v !== undefined && v !== null && v !== "") qs.set(k, String(v))
      }
    }
    return callSignal<LibrarySearchResponse>("GET", `/api/search?${qs}`, undefined, signal)
  },
  /** LOCAL north-star: mark that a search led to opening a result. */
  searchFeedback: (query_hash: string, clicked = true) =>
    call<{ ok: boolean }>("POST", "/api/search/feedback", { query_hash, clicked }),
  searchMetrics: () => call<SearchMetrics>("GET", "/api/search/metrics"),
  related: (id: string, limit = 5) =>
    call<RelatedResponse>("GET", `/api/library/${id}/related?limit=${limit}`),
  indexStats: () => call<IndexStats>("GET", "/api/index/stats"),
  indexBackfill: () => call<{ job_id: string }>("POST", "/api/index/backfill"),
  indexRebuild: () => call<{ job_id: string }>("POST", "/api/index/rebuild"),
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
  plugins: () => call<PluginInfo[]>("GET", "/api/plugins"),
  enablePlugin: (id: string) =>
    call<{ id?: string; enabled?: boolean; error?: string }>("POST", `/api/plugins/${id}/enable`),
  disablePlugin: (id: string) =>
    call<{ id?: string; enabled?: boolean; error?: string }>("POST", `/api/plugins/${id}/disable`),
  savePluginSettings: (id: string, settings: Record<string, unknown>) =>
    call<{ id?: string; settings?: Record<string, unknown>; error?: string }>(
      "PATCH",
      `/api/plugins/${id}/settings`,
      { settings },
    ),
  runPluginAction: (id: string, action: string, body?: Record<string, unknown>) =>
    call<{ ok?: boolean; message?: string; job_id?: string; error?: string }>(
      "POST",
      `/api/plugins/${id}/actions/${action}`,
      body ?? {},
    ),
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

// --- subscription filters mapping (frontend minutes <-> backend seconds) ---

/** UI filters (durations in MINUTES) → API filters (durations in SECONDS). */
export function filtersToBackend(f: SubscriptionFilters): BackendFilters {
  return {
    min_duration: f.minDuration != null ? Math.round(f.minDuration * 60) : null,
    max_duration: f.maxDuration != null ? Math.round(f.maxDuration * 60) : null,
    exclude_shorts: !!f.excludeShorts,
    exclude_lives: !!f.excludeLives,
    include_keywords: f.includeKeywords ?? [],
    exclude_keywords: f.excludeKeywords ?? [],
    keep_last_n: f.keepLastN != null ? f.keepLastN : null,
  }
}

/** API filters (SECONDS) → UI filters (MINUTES). Missing object = no filters. */
export function filtersToFrontend(b?: BackendFilters | null): SubscriptionFilters {
  return {
    minDuration: b?.min_duration != null ? Math.round(b.min_duration / 60) : undefined,
    maxDuration: b?.max_duration != null ? Math.round(b.max_duration / 60) : undefined,
    excludeShorts: !!b?.exclude_shorts,
    excludeLives: !!b?.exclude_lives,
    includeKeywords: b?.include_keywords ?? [],
    excludeKeywords: b?.exclude_keywords ?? [],
    keepLastN: b?.keep_last_n != null ? b.keep_last_n : undefined,
  }
}
