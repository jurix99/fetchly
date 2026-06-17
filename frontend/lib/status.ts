import type { DownloadStatus } from "./types"

interface StatusMeta {
  label: string
  /** Tailwind classes for the status badge (background + text). */
  className: string
  /** Color class for progress bars / dots. */
  dot: string
}

export const STATUS_META: Record<DownloadStatus, StatusMeta> = {
  queued: {
    label: "En file",
    className: "bg-muted text-muted-foreground",
    dot: "bg-muted-foreground",
  },
  downloading: {
    label: "Téléchargement",
    className: "bg-info/15 text-info border-info/30",
    dot: "bg-info",
  },
  converting: {
    label: "Conversion",
    className: "bg-warning/15 text-warning border-warning/30",
    dot: "bg-warning",
  },
  completed: {
    label: "Terminé",
    className: "bg-success/15 text-success border-success/30",
    dot: "bg-success",
  },
  failed: {
    label: "Échec",
    className: "bg-destructive/15 text-destructive border-destructive/30",
    dot: "bg-destructive",
  },
  paused: {
    label: "En pause",
    className: "bg-muted text-muted-foreground border-border",
    dot: "bg-muted-foreground",
  },
}

export const QUALITIES = [
  "Auto",
  "2160p (4K)",
  "1440p",
  "1080p",
  "720p",
  "480p",
  "Audio seul",
] as const
export const FORMATS = ["MP4", "MKV", "MP3", "M4A"] as const
