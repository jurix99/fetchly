"use client"

import { useState } from "react"
import {
  DownloadIcon,
  Loader2Icon,
  SearchIcon,
  VideoIcon,
} from "lucide-react"

import {
  detectUrlKind,
  fetchChannelVideos,
  fetchPlaylistVideos,
  fetchUrlMetadata,
} from "@/lib/api"
import type {
  ChannelPreview,
  PlaylistPreview,
  UrlKind,
  VideoPreview,
} from "@/lib/types"
import { useStore } from "@/components/store-provider"
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

  async function analyze() {
    if (!url.trim()) return
    const kind = detectUrlKind(url)
    setLoading(true)
    setResult(null)
    try {
      if (kind === "channel") {
        const { channel, videos } = await fetchChannelVideos(url)
        setResult({ kind: "channel", channel, videos })
      } else if (kind === "playlist") {
        const { playlist, videos } = await fetchPlaylistVideos(url)
        setResult({ kind: "playlist", playlist, videos })
      } else {
        const video = await fetchUrlMetadata(url)
        setResult({ kind: "video", video })
      }
    } finally {
      setLoading(false)
    }
  }

  const kindLabel: Record<UrlKind, string> = {
    video: "Vidéo simple",
    channel: "Chaîne",
    playlist: "Playlist",
    unknown: "—",
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
                Coller une URL YouTube
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  value={url}
                  onChange={(e) => onUrlChange(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && analyze()}
                  placeholder="Vidéo, chaîne (@nom) ou playlist…"
                  className="h-10 flex-1"
                  aria-label="URL YouTube"
                />
                <Button
                  size="lg"
                  className="h-10"
                  onClick={analyze}
                  disabled={!url.trim() || loading}
                >
                  {loading ? (
                    <Loader2Icon className="animate-spin" data-icon="inline-start" />
                  ) : (
                    <SearchIcon data-icon="inline-start" />
                  )}
                  Analyser
                </Button>
              </div>
              {detected !== "unknown" && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>Type détecté :</span>
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

          {!result && !loading && (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border py-12 text-center">
              <VideoIcon className="size-8 text-muted-foreground" />
              <p className="text-sm font-medium">Aucune analyse en cours</p>
              <p className="max-w-xs text-balance text-sm text-muted-foreground">
                Collez l&apos;URL d&apos;une vidéo, d&apos;une chaîne ou d&apos;une
                playlist pour commencer.
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
