"use client"

import { useState } from "react"
import {
  DownloadIcon,
  Loader2Icon,
  SearchIcon,
  TvIcon,
  VideoIcon,
} from "lucide-react"

import {
  detectUrlKind,
  fetchChannelInfo,
  fetchPlaylistVideos,
  fetchUrlMetadata,
  searchYoutube,
} from "@/lib/api"
import type {
  ChannelPreview,
  ChannelResult,
  PlaylistPreview,
  UrlKind,
  VideoPreview,
} from "@/lib/types"
import { useStore } from "@/components/store-provider"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Skeleton } from "@/components/ui/skeleton"
import { QualitySelect, FormatSelect } from "@/components/option-selects"
import { VideoPreviewCard } from "@/components/video-preview-card"
import { Separator } from "@/components/ui/separator"
import { ChannelVideoList } from "@/components/channel-video-list"
import { SubscriptionsPanel } from "@/components/subscriptions-panel"

type Result =
  | { kind: "video"; video: VideoPreview }
  | { kind: "channel"; channel: ChannelPreview; videos: VideoPreview[] }
  | { kind: "playlist"; playlist: PlaylistPreview; videos: VideoPreview[] }
  | { kind: "search"; videos: VideoPreview[]; channels: ChannelResult[] }
  | null

export function YoutubeView() {
  const { settings, addDownload } = useStore()
  const [url, setUrl] = useState("")
  const [detected, setDetected] = useState<UrlKind>("unknown")
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<Result>(null)
  const [quality, setQuality] = useState(settings.defaultQuality)
  const [format, setFormat] = useState(settings.defaultFormat)

  function onUrlChange(value: string) {
    setUrl(value)
    setDetected(detectUrlKind(value))
  }

  async function run(input?: string) {
    const q = (input ?? url).trim()
    if (!q) return
    if (input !== undefined) {
      setUrl(input)
      setDetected(detectUrlKind(input))
    }
    const kind = detectUrlKind(q)
    setLoading(true)
    setResult(null)
    try {
      if (kind === "channel") {
        // Fast metadata only; the video list loads lazily on expand.
        const channel = await fetchChannelInfo(q)
        setResult({ kind: "channel", channel, videos: [] })
      } else if (kind === "playlist") {
        const { playlist, videos } = await fetchPlaylistVideos(q)
        setResult({ kind: "playlist", playlist, videos })
      } else if (kind === "video") {
        const video = await fetchUrlMetadata(q)
        setResult({ kind: "video", video })
      } else {
        // Free text → search YouTube for channels + videos.
        const { videos, channels } = await searchYoutube(q)
        setResult({ kind: "search", videos, channels })
      }
    } finally {
      setLoading(false)
    }
  }

  const kindLabel: Record<UrlKind, string> = {
    video: "Vidéo simple",
    channel: "Chaîne",
    playlist: "Playlist",
    unknown: "Recherche",
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 sm:p-6 lg:p-8">
      <Tabs defaultValue="explore" className="gap-6">
        <TabsList>
          <TabsTrigger value="explore">Explorer</TabsTrigger>
          <TabsTrigger value="subscriptions">Abonnements</TabsTrigger>
        </TabsList>

        <TabsContent value="explore" className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Rechercher ou coller une URL
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <Input
                  value={url}
                  onChange={(e) => onUrlChange(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && run()}
                  placeholder="Nom d'un youtubeur, d'une vidéo… ou une URL YouTube"
                  className="h-10 flex-1"
                  aria-label="Recherche ou URL YouTube"
                />
                <Button
                  size="icon-lg"
                  className="size-10 shrink-0"
                  onClick={() => run()}
                  disabled={!url.trim() || loading}
                  aria-label="Rechercher"
                >
                  {loading ? (
                    <Loader2Icon className="animate-spin" />
                  ) : (
                    <SearchIcon />
                  )}
                </Button>
              </div>
              {url.trim() && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>{detected === "unknown" ? "Action :" : "Type détecté :"}</span>
                  <Badge variant="secondary">{kindLabel[detected]}</Badge>
                </div>
              )}
            </CardContent>
          </Card>

          {loading && (
            <Card>
              <CardContent className="flex flex-col gap-3 sm:flex-row">
                <Skeleton className="aspect-video w-full rounded-lg sm:w-56" />
                <div className="flex flex-1 flex-col gap-2">
                  <Skeleton className="h-5 w-3/4" />
                  <Skeleton className="h-4 w-1/3" />
                  <Skeleton className="h-4 w-1/2" />
                </div>
              </CardContent>
            </Card>
          )}

          {result?.kind === "video" && (
            <Card>
              <CardContent className="flex flex-col gap-4">
                <VideoPreviewCard video={result.video} />
                <Separator />
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-2">
                    <QualitySelect value={quality} onChange={setQuality} size="sm" />
                    <FormatSelect value={format} onChange={setFormat} size="sm" />
                  </div>
                  <Button
                    onClick={() =>
                      addDownload({
                        url,
                        title: result.video.title,
                        thumbnail: result.video.thumbnail,
                        quality,
                        format,
                        channel: result.video.channel,
                      })
                    }
                  >
                    <DownloadIcon data-icon="inline-start" />
                    Télécharger
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {result?.kind === "channel" && (
            <ChannelVideoList
              key={result.channel.url}
              type="channel"
              channel={result.channel}
              videos={result.videos}
              url={url}
              quality={quality}
              format={format}
              onQuality={setQuality}
              onFormat={setFormat}
            />
          )}

          {result?.kind === "playlist" && (
            <ChannelVideoList
              key={result.playlist.url}
              type="playlist"
              playlist={result.playlist}
              videos={result.videos}
              url={url}
              quality={quality}
              format={format}
              onQuality={setQuality}
              onFormat={setFormat}
            />
          )}

          {result?.kind === "search" && (
            <SearchResults
              videos={result.videos}
              channels={result.channels}
              quality={quality}
              format={format}
              onQuality={setQuality}
              onFormat={setFormat}
              onOpenChannel={(u) => run(u)}
              onDownload={(v) =>
                addDownload({
                  url: v.url || "",
                  title: v.title,
                  thumbnail: v.thumbnail,
                  quality,
                  format,
                  channel: v.channel,
                })
              }
            />
          )}

          {!result && !loading && (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border py-12 text-center">
              <VideoIcon className="size-8 text-muted-foreground" />
              <p className="text-sm font-medium">Rien à afficher</p>
              <p className="max-w-xs text-balance text-sm text-muted-foreground">
                Tapez le nom d&apos;un youtubeur ou d&apos;une vidéo, ou collez une
                URL pour commencer.
              </p>
            </div>
          )}
        </TabsContent>

        <TabsContent value="subscriptions">
          <SubscriptionsPanel />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function SearchResults({
  videos,
  channels,
  quality,
  format,
  onQuality,
  onFormat,
  onOpenChannel,
  onDownload,
}: {
  videos: VideoPreview[]
  channels: ChannelResult[]
  quality: string
  format: string
  onQuality: (v: string) => void
  onFormat: (v: string) => void
  onOpenChannel: (url: string) => void
  onDownload: (v: VideoPreview) => void
}) {
  if (videos.length === 0 && channels.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border py-12 text-center">
        <SearchIcon className="size-8 text-muted-foreground" />
        <p className="text-sm font-medium">Aucun résultat</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      {channels.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Chaînes</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {channels.map((c) => (
              <button
                key={c.url}
                type="button"
                onClick={() => onOpenChannel(c.url)}
                className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-left transition-colors hover:bg-muted/50"
              >
                <Avatar className="size-8">
                  <AvatarImage src={c.avatar || "/placeholder.svg"} alt={c.name} />
                  <AvatarFallback>
                    <TvIcon className="size-4" />
                  </AvatarFallback>
                </Avatar>
                <span className="text-sm font-medium">{c.name}</span>
              </button>
            ))}
          </CardContent>
        </Card>
      )}

      {videos.length > 0 && (
        <Card>
          <CardHeader className="flex-row items-center justify-between gap-3">
            <CardTitle className="text-base">Vidéos</CardTitle>
            <div className="flex items-center gap-2">
              <QualitySelect value={quality} onChange={onQuality} size="sm" />
              <FormatSelect value={format} onChange={onFormat} size="sm" />
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {videos.map((v) => (
              <div
                key={v.id}
                className="flex items-center gap-3 rounded-lg border border-transparent p-2 hover:bg-muted/50"
              >
                <div className="relative aspect-video w-28 shrink-0 overflow-hidden rounded-md border border-border">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={v.thumbnail || "/placeholder.svg"}
                    alt={v.title}
                    className="size-full object-cover"
                  />
                  {v.duration && (
                    <span className="absolute bottom-0.5 right-0.5 rounded bg-black/80 px-1 text-[10px] text-white tabular-nums">
                      {v.duration}
                    </span>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-sm font-medium leading-snug">{v.title}</p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{v.channel}</p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  disabled={!v.url}
                  onClick={() => onDownload(v)}
                >
                  <DownloadIcon data-icon="inline-start" />
                  Télécharger
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
