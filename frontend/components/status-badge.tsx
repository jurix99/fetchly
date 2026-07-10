import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { STATUS_META } from "@/lib/status"
import type { DownloadStatus } from "@/lib/types"

export function StatusBadge({
  status,
  className,
}: {
  status: DownloadStatus
  className?: string
}) {
  const meta = STATUS_META[status]
  const Icon = meta.icon
  return (
    <Badge variant="outline" className={cn("gap-1.5", meta.className, className)}>
      <Icon className={meta.iconClassName} aria-hidden="true" />
      <span className={cn(meta.strike && "line-through")}>{meta.label}</span>
    </Badge>
  )
}
