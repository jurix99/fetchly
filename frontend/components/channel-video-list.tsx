"use client"

import { useMemo, useState } from "react"
import {
  BellPlusIcon,
  DownloadIcon,
  RadioIcon,
  UsersIcon,
} from "lucide-react"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import type {
  ChannelPreview,
  PlaylistPreview,
  Subscription,
  VideoPreview,
} from "@/lib/types"
import { useStore } from "@/components/store-provider"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Separator } from "@/components/ui/separator"
import { QualitySelect, FormatSelect } from "@/components/option-selects"

const PAGE_SIZE = 6

interface BaseProps {
  videos: VideoPreview[]
  url: string
  quality: string
  format: string
  onQuality: (v: string) => void
  onFormat: (v: string) => void
}

type Props =
  | (BaseProps & { type: "channel"; channel: ChannelPreview; playlist?: never })
  | (BaseProps & { type: "playlist"; playlist: PlaylistPreview; channel?: never })

export function ChannelVideoList(props: Props) {
  const { videos, url, quality, format, onQuality, onFormat } = props
  const { addDownload, addSubscription } = useStore()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [page, setPage] = useState(1)

  const visible = useMemo(() => videos.slice(0, page * PAGE_SIZE), [videos, page])
  const allVisibleSelected =
    visible.length > 0 && visible.every((v) => selected.has(v.id))

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAll() {
    setSelected((prev) => {
      if (allVisibleSelected) {
        const next = new Set(prev)
        visible.forEach((v) => next.delete(v.id))
        return next
      }
      const next = new Set(prev)
      visible.forEach((v) => next.add(v.id))
      return next
    })
  }

  function downloadSelected() {
    const chosen = videos.filter((v) => selected.has(v.id))
    chosen.forEach((v) =>
      addDownload({
        url,
        title: v.title,
        thumbnail: v.thumbnail,
        quality,
        format,
        channel: v.channel,
      }),
    )
    toast.success(`${chosen.length} vidéo(s) ajoutée(s) à la file`)
    setSelected(new Set())
  }

  function follow() {
    const name = props.type === "channel" ? props.channel.name : props.playlist.title
    const avatar =
      props.type === "channel" ? props.channel.avatar : props.playlist.thumbnail
    const sub: Subscription = {
      id: `s-${Date.now()}`,
      type: props.type,
      name,
      avatar,
      url,
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
    addSubscription(sub)
  }

  return (
    <Card>
      <CardHeader className="gap-4">
        {/* Header: channel or playlist */}
        {props.type === "channel" ? (
          <div className="flex items-center gap-3">
            <Avatar className="size-12">
              <AvatarImage src={props.channel.avatar || "/placeholder.svg"} alt={props.channel.name} />
              <AvatarFallback>{props.channel.name[0]}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-lg font-semibold">{props.channel.name}</h3>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <UsersIcon className="size-3.5" />
                  {props.channel.subscribers} abonnés
                </span>
                <span>{props.channel.videoCount} vidéos</span>
              </div>
            </div>
            <Button variant="outline" onClick={follow}>
              <BellPlusIcon data-icon="inline-start" />
              Watch / Suivre
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <div className="relative aspect-video w-28 shrink-0 overflow-hidden rounded-md border border-border">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={props.playlist.thumbnail || "/placeholder.svg"}
                alt={props.playlist.title}
                className="size-full object-cover"
              />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-lg font-semibold">{props.playlist.title}</h3>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>{props.playlist.channel}</span>
                <span>{props.playlist.videoCount} vidéos</span>
              </div>
            </div>
            <Button variant="outline" onClick={follow}>
              <BellPlusIcon data-icon="inline-start" />
              Watch / Suivre
            </Button>
          </div>
        )}

        <Separator />

        {/* Selection toolbar */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={allVisibleSelected} onCheckedChange={toggleAll} />
            <span>
              {selected.size > 0 ? `${selected.size} sélectionnée(s)` : "Tout sélectionner"}
            </span>
          </label>
          <div className="flex items-center gap-2">
            <QualitySelect value={quality} onChange={onQuality} size="sm" />
            <FormatSelect value={format} onChange={onFormat} size="sm" />
            <Button onClick={downloadSelected} disabled={selected.size === 0}>
              <DownloadIcon data-icon="inline-start" />
              Télécharger ({selected.size})
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-2">
        {visible.map((v) => {
          const isSel = selected.has(v.id)
          return (
            <button
              key={v.id}
              type="button"
              onClick={() => toggle(v.id)}
              className={cn(
                "flex items-center gap-3 rounded-lg border p-2 text-left transition-colors",
                isSel
                  ? "border-primary/40 bg-primary/5"
                  : "border-transparent hover:bg-muted/50",
              )}
            >
              <Checkbox checked={isSel} className="pointer-events-none" />
              <div className="relative aspect-video w-24 shrink-0 overflow-hidden rounded-md border border-border">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={v.thumbnail || "/placeholder.svg"}
                  alt={v.title}
                  className="size-full object-cover"
                />
                <span className="absolute bottom-0.5 right-0.5 rounded bg-black/80 px-1 text-[10px] text-white tabular-nums">
                  {v.duration}
                </span>
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{v.title}</p>
                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {v.views && <span>{v.views}</span>}
                  {v.uploaded && <span>{v.uploaded}</span>}
                  {v.isShort && <Badge variant="secondary" className="text-[10px]">Short</Badge>}
                  {v.isLive && (
                    <Badge className="bg-destructive/15 text-destructive border-destructive/30 text-[10px]">
                      <RadioIcon className="size-3" data-icon="inline-start" />
                      Live
                    </Badge>
                  )}
                </div>
              </div>
            </button>
          )
        })}

        {visible.length < videos.length && (
          <Button
            variant="ghost"
            className="mt-1 w-full"
            onClick={() => setPage((p) => p + 1)}
          >
            Charger plus ({videos.length - visible.length} restantes)
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
