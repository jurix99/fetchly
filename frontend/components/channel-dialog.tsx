"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { BellPlusIcon, DownloadIcon, Loader2Icon, UsersIcon } from "lucide-react"
import { fetchChannelVideosPage } from "@/lib/api"
import type { ChannelPreview, Subscription, VideoPreview } from "@/lib/types"
import { useStore, type BackfillOptions } from "@/components/store-provider"
import { FollowDialog } from "@/components/follow-dialog"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Separator } from "@/components/ui/separator"
import { QualitySelect, FormatSelect } from "@/components/option-selects"

const PAGE = 24

/**
 * Opened when a channel is picked from search results. Shows the channel's real
 * logo + stats and lets you subscribe (with backfill options) or browse its
 * videos. Videos load lazily, one page at a time as you scroll — nothing is
 * fetched up front, so it opens instantly.
 */
export function ChannelDialog({
  channel,
  open,
  onOpenChange,
}: {
  channel: ChannelPreview | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { settings, addDownload, addSubscription } = useStore()
  const [quality, setQuality] = useState(settings.defaultQuality)
  const [format, setFormat] = useState(settings.defaultFormat)
  const [followOpen, setFollowOpen] = useState(false)
  const [videos, setVideos] = useState<VideoPreview[]>([])
  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(true)
  const [loading, setLoading] = useState(false)
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  const loadMore = useCallback(async () => {
    if (!channel || loading || !hasMore) return
    setLoading(true)
    try {
      const { videos: page, hasMore: more } = await fetchChannelVideosPage(
        channel.url,
        offset,
        PAGE,
      )
      setVideos((prev) => [...prev, ...page])
      setOffset((o) => o + page.length)
      setHasMore(more && page.length > 0)
    } catch {
      setHasMore(false)
    } finally {
      setLoading(false)
    }
  }, [channel, loading, hasMore, offset])

  // Load the first page as soon as the dialog opens (it remounts per channel).
  useEffect(() => {
    loadMore()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Load the next page when the bottom sentinel scrolls into view.
  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const obs = new IntersectionObserver(
      (entries) => entries[0]?.isIntersecting && loadMore(),
      { rootMargin: "250px" },
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [loadMore])

  if (!channel) return null

  function subscribe(opts: BackfillOptions) {
    if (!channel) return
    const sub: Subscription = {
      id: `s-${Date.now()}`,
      type: "channel",
      name: channel.name,
      avatar: channel.avatar,
      url: channel.url,
      checkIntervalHours: 12,
      active: true,
      lastChecked: new Date().toISOString(),
      filters: {
        excludeShorts: true,
        excludeLives: true,
        includeKeywords: [],
        excludeKeywords: [],
      },
      defaultQuality: quality,
      defaultFormat: format,
    }
    addSubscription(sub, opts)
    onOpenChange(false)
  }

  function downloadVideo(v: VideoPreview) {
    if (!v.url) return
    addDownload({ url: v.url, title: v.title, thumbnail: v.thumbnail, quality, format, channel: channel?.name })
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-lg">
          <DialogHeader>
            <div className="flex items-center gap-3">
              <Avatar className="size-12">
                {channel.avatar ? <AvatarImage src={channel.avatar} alt={channel.name} /> : null}
                <AvatarFallback className="font-medium">
                  {channel.name.charAt(0).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <DialogTitle className="truncate">{channel.name}</DialogTitle>
                <DialogDescription className="flex items-center gap-2">
                  {channel.subscribers !== "—" && (
                    <span className="flex items-center gap-1">
                      <UsersIcon className="size-3.5" />
                      {channel.subscribers}
                    </span>
                  )}
                  {channel.videoCount > 0 && <span>{channel.videoCount} vidéos</span>}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Qualité</span>
              <QualitySelect value={quality} onChange={setQuality} size="sm" />
              <FormatSelect value={format} onChange={setFormat} size="sm" />
            </div>
            <Button size="sm" onClick={() => setFollowOpen(true)}>
              <BellPlusIcon data-icon="inline-start" />
              S&apos;abonner
            </Button>
          </div>

          <Separator />

          {/* Scrollable, lazily-paginated video list */}
          <div className="-mx-2 flex flex-col gap-1.5 overflow-y-auto px-2">
            {videos.map((v) => (
              <div
                key={v.id}
                className="flex items-center gap-3 rounded-lg border border-transparent p-1.5 hover:bg-muted/50"
              >
                <div className="relative aspect-video w-24 shrink-0 overflow-hidden rounded-md border border-border">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={v.thumbnail || "/placeholder.svg"} alt={v.title} className="size-full object-cover" />
                  {v.duration && (
                    <span className="absolute bottom-0.5 right-0.5 rounded bg-black/80 px-1 text-[10px] text-white tabular-nums">
                      {v.duration}
                    </span>
                  )}
                </div>
                <p className="line-clamp-2 min-w-0 flex-1 text-sm font-medium leading-snug">
                  {v.title}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  disabled={!v.url}
                  onClick={() => downloadVideo(v)}
                  aria-label="Télécharger"
                >
                  <DownloadIcon />
                </Button>
              </div>
            ))}

            <div ref={sentinelRef} className="h-px" />
            {loading && (
              <div className="flex items-center justify-center gap-2 py-3 text-xs text-muted-foreground">
                <Loader2Icon className="size-4 animate-spin" />
                Chargement…
              </div>
            )}
            {!hasMore && videos.length > 0 && (
              <p className="py-2 text-center text-xs text-muted-foreground">Fin de la liste</p>
            )}
            {!loading && videos.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">Aucune vidéo</p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <FollowDialog
        open={followOpen}
        onOpenChange={setFollowOpen}
        channelName={channel.name}
        onConfirm={subscribe}
      />
    </>
  )
}
