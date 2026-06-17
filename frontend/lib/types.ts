export type DownloadStatus =
  | "queued"
  | "downloading"
  | "converting"
  | "completed"
  | "failed"
  | "paused"

export type Quality = "Auto" | "1080p" | "720p" | "480p" | "Audio seul"
export type Format = "MP4" | "MKV" | "MP3" | "M4A"

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
  minDuration?: number
  maxDuration?: number
  excludeShorts: boolean
  excludeLives: boolean
  includeKeywords: string[]
  excludeKeywords: string[]
  keepLastN?: number
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
  theme: "light" | "dark" | "system"
}

export type UrlKind = "video" | "channel" | "playlist" | "unknown"
