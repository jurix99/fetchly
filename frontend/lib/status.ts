import {
  BanIcon,
  CheckIcon,
  ClockIcon,
  DownloadIcon,
  Loader2Icon,
  PauseIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from "lucide-react"

import type { DownloadStatus } from "./types"

export interface StatusMeta {
  /** French label — the only user-facing wording for this status. */
  label: string
  /** Tailwind classes for the status badge (background + text + border). */
  className: string
  /** Solid color class for dots / progress accents. */
  dot: string
  /** Lucide icon that represents this status. */
  icon: LucideIcon
  /** Extra classes for the icon (e.g. animation for active states). */
  iconClassName?: string
  /** Strike-through the label (canceled). */
  strike?: boolean
}

/**
 * SINGLE SOURCE OF TRUTH for download/job statuses.
 *
 * Every status = one palette token + one lucide icon + one FR label.
 * Do NOT introduce colors outside the design tokens (see frontend/DESIGN.md).
 *
 * Concept (DESIGN.md) → code identifier used here:
 *   queued              → queued       (neutre)
 *   downloading/running → downloading  (primaire animé)
 *   processing          → converting   (primaire)
 *   paused              → paused       (ambre / warning)
 *   done                → completed    (vert / success)
 *   error               → failed       (rouge / destructive)
 *   canceled            → canceled     (gris barré)
 */
export const STATUS_META: Record<DownloadStatus, StatusMeta> = {
  queued: {
    label: "En file",
    className: "bg-muted text-muted-foreground border-border",
    dot: "bg-muted-foreground",
    icon: ClockIcon,
  },
  downloading: {
    label: "Téléchargement",
    className: "bg-primary/15 text-primary border-primary/30",
    dot: "bg-primary",
    icon: DownloadIcon,
    iconClassName: "animate-pulse",
  },
  converting: {
    label: "Conversion",
    className: "bg-primary/15 text-primary border-primary/30",
    dot: "bg-primary",
    icon: Loader2Icon,
    iconClassName: "animate-spin",
  },
  completed: {
    label: "Terminé",
    className: "bg-success/15 text-success border-success/30",
    dot: "bg-success",
    icon: CheckIcon,
  },
  failed: {
    label: "Échec",
    className: "bg-destructive/15 text-destructive border-destructive/30",
    dot: "bg-destructive",
    icon: TriangleAlertIcon,
  },
  paused: {
    label: "En pause",
    className: "bg-warning/15 text-warning border-warning/30",
    dot: "bg-warning",
    icon: PauseIcon,
  },
  canceled: {
    label: "Annulé",
    className: "bg-muted text-muted-foreground border-border",
    dot: "bg-muted-foreground",
    icon: BanIcon,
    strike: true,
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
