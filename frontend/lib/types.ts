export type DownloadStatus =
  | "queued"
  | "downloading"
  | "converting"
  | "completed"
  | "failed"
  | "paused"
  | "canceled"

export type Quality = "Auto" | "1080p" | "720p" | "480p" | "Audio seul"
export type Format = "MP4" | "MKV" | "MP3" | "M4A"

/** One plugin's outcome in the post-download pipeline (shown on the card). */
export interface PipelineReport {
  plugin?: string
  label: string
  ok: boolean
  detail?: string
}

export interface DownloadItem {
  id: string
  title: string
  thumbnail: string
  sourceUrl: string
  source: string // youtube, vimeo, etc.
  channel?: string
  quality: string
  format: string
  status: DownloadStatus
  progress: number // 0-100
  speed?: string // ex. "4.2 MB/s"
  eta?: string // ex. "00:45"
  sizeDownloaded?: string
  sizeTotal?: string
  error?: string
  createdAt: string
  filePath?: string
  reports?: PipelineReport[]
}

export interface VideoPreview {
  id: string
  title: string
  thumbnail: string
  duration: string // "12:34"
  channel: string
  source: string
  url?: string // direct watch URL (used to download an individual result)
  views?: string
  uploaded?: string
  isShort?: boolean
  isLive?: boolean
}

export interface ChannelResult {
  name: string
  url: string
  avatar?: string
}

export interface ChannelPreview {
  id: string
  name: string
  avatar: string
  url: string
  subscribers: string
  videoCount: number
  description: string
}

export interface PlaylistPreview {
  id: string
  title: string
  thumbnail: string
  url: string
  channel: string
  videoCount: number
}

export interface SubscriptionFilters {
  minDuration?: number // MINUTES (UI unit; converted to seconds at the API)
  maxDuration?: number // MINUTES
  excludeShorts: boolean
  excludeLives: boolean
  // Keyword semantics: include = OU (au moins un présent) ; exclude = OU (un
  // seul suffit à rejeter) ; exclude gagne sur include.
  includeKeywords: string[]
  excludeKeywords: string[]
  keepLastN?: number
}

/** Effect of the filters at the last subscription check (from the backend). */
export interface SubscriptionLastCheck {
  listed: number
  matched: number
  rejectedByFilters: number
  downloaded: number
}

export interface Subscription {
  id: string
  type: "channel" | "playlist"
  name: string
  avatar: string
  url: string
  checkIntervalHours: number
  active: boolean
  lastChecked: string
  dateAfter?: string // ISO "YYYY-MM-DD"; only sync uploads on/after this date
  filters: SubscriptionFilters
  lastCheck?: SubscriptionLastCheck | null
  defaultQuality: string
  defaultFormat: string
}

export interface Settings {
  downloadDir: string
  defaultQuality: string
  defaultFormat: string
  filenameTemplate: string
  organizeBySubfolder: boolean
  subtitles: { enabled: boolean; languages: string[]; embed: boolean }
  embedMetadata: boolean
  embedThumbnail: boolean
  embedChapters: boolean
  maxConcurrent: number
  bandwidthLimit?: string
  proxy?: string
  sponsorBlock: boolean
  sponsorBlockMode: "skip" | "mark"
  cookiesImport: boolean
  downloadArchive: boolean
  nfoExport: boolean
  theme: "light" | "dark" | "system"
}

export type UrlKind = "video" | "channel" | "playlist" | "unknown"
