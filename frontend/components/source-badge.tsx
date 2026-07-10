import { PlayIcon, TvIcon, type LucideIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"

// Source identity lives here so the app is source-agnostic: a source is a badge
// (icon + name), not a navigation entry. Add new sources by extending this map.
const SOURCES: Record<string, { label: string; icon: LucideIcon }> = {
  youtube: { label: "YouTube", icon: PlayIcon },
}

export function SourceBadge({ source, className }: { source: string; className?: string }) {
  const meta = SOURCES[(source || "").toLowerCase()] ?? { label: source || "Source", icon: TvIcon }
  const Icon = meta.icon
  return (
    <Badge variant="secondary" className={cn("gap-1", className)}>
      <Icon className="size-3" />
      {meta.label}
    </Badge>
  )
}
