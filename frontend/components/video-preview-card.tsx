"use client"

import { ClockIcon, GlobeIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import type { VideoPreview } from "@/lib/types"

export function VideoPreviewCard({ video }: { video: VideoPreview }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
      <div className="relative aspect-video w-full shrink-0 overflow-hidden rounded-lg border border-border sm:w-56">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={video.thumbnail || "/placeholder.svg"}
          alt={video.title}
          className="size-full object-cover"
        />
        <span className="absolute bottom-1.5 right-1.5 rounded bg-black/80 px-1.5 py-0.5 text-[11px] font-medium text-white tabular-nums">
          {video.duration}
        </span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <h3 className="text-pretty text-base font-semibold leading-snug">
          {video.title}
        </h3>
        <p className="text-sm text-muted-foreground">{video.channel}</p>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1 capitalize">
            <GlobeIcon className="size-3.5" />
            {video.source}
          </span>
          <span className="flex items-center gap-1">
            <ClockIcon className="size-3.5" />
            {video.duration}
          </span>
          {video.views && <span>{video.views}</span>}
          {video.uploaded && <span>{video.uploaded}</span>}
          {video.isLive && (
            <Badge className="bg-destructive/15 text-destructive border-destructive/30">
              Live
            </Badge>
          )}
          {video.isShort && <Badge variant="secondary">Short</Badge>}
        </div>
      </div>
    </div>
  )
}
