"use client"

import { useEffect, useState } from "react"
import {
  BellPlusIcon,
  ClockIcon,
  DownloadIcon,
  Loader2Icon,
  RssIcon,
  SearchIcon,
  ThumbsUpIcon,
  TvIcon,
  VideoIcon,
} from "lucide-react"
import { toast } from "sonner"

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
import { backend } from "@/lib/backend"
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
import { ChannelDialog } from "@/components/channel-dialog"
import { SubscriptionsPanel } from "@/components/subscriptions-panel"
import { SubscriptionsPicker } from "@/components/subscriptions-picker"

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
  // Channel picked from search results -> opens the actions dialog.
  const [channelDialog, setChannelDialog] = useState<ChannelPreview | null>(null)
  // Real channel logos fetched lazily for the search results (search itself
  // doesn't carry avatars), keyed by channel URL.
  const [channelAvatars, setChannelAvatars] = useState<Record<string, string>>({})

  // When a search returns channels, fill in their real logos in the background
  // (search results don't carry avatars). Runs once per new search result.
  useEffect(() => {
    if (result?.kind !== "search") return
    let cancelled = false
    result.channels.forEach((c) => {
      fetchChannelInfo(c.url)
        .then((info) => {
          if (!cancelled) setChannelAvatars((m) => ({ ...m, [c.url]: info.avatar }))
        })
        .catch(() => {})
    })
    return () => {
      cancelled = true
    }
  }, [result])

  function onUrlChange(value: string) {
    setUrl(value)
    setDetected(detectUrlKind(value))
  }

  // forceKind lets the "Mon YouTube" tiles load a special source (e.g.
  // ":ytsubscriptions") that the URL sniffer wouldn't classify on its own.
  // limit bounds enumeration for unbounded feeds (the subscriptions firehose).
  async function run(input?: string, forceKind?: UrlKind, limit?: number) {
    const q = (input ?? url).trim()
    if (!q) return
    if (input !== undefined) {
      setUrl(input)
      setDetected(forceKind ?? detectUrlKind(input))
    }
    const kind = forceKind ?? detectUrlKind(q)
    setLoading(true)
    setResult(null)
    try {
      if (kind === "channel") {
        // Fast metadata only; the video list loads lazily on expand.
        const channel = await fetchChannelInfo(q)
        setResult({ kind: "channel", channel, videos: [] })
      } else if (kind === "playlist") {
        const { playlist, videos } = await fetchPlaylistVideos(q, limit)
        setResult({ kind: "playlist", playlist, videos })
      } else if (kind === "video") {
        const video = await fetchUrlMetadata(q)
        setResult({ kind: "video", video })
      } else {
        // Free text → search YouTube for channels + videos.
        const { videos, channels } = await searchYoutube(q)
        setResult({ kind: "search", videos, channels })
      }
    } catch (e) {
      // Most "Mon YouTube" failures are missing/expired cookies — guide the user.
      toast.error(
        e instanceof Error && /cookie|sign in|login|private/i.test(e.message)
          ? "Connexion YouTube requise — ajoute tes cookies dans Réglages."
          : e instanceof Error
            ? e.message
            : "Échec du chargement",
      )
    } finally {
      setLoading(false)
    }
  }

  // Click a channel (from a search result) -> open the actions dialog (Suivre /
  // Voir les vidéos) rather than re-running a search with its URL.
  async function onChannelClick(channelUrl: string) {
    const cached = channelAvatars[channelUrl]
    try {
      const channel = await fetchChannelInfo(channelUrl)
      setChannelDialog({ ...channel, avatar: channel.avatar || cached || "" })
    } catch {
      /* ignore — leave the dialog closed on failure */
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
          <MyYoutube onPick={run} disabled={loading} />

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
              url={result.channel.url}
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
              avatars={channelAvatars}
              quality={quality}
              format={format}
              onQuality={setQuality}
              onFormat={setFormat}
              onOpenChannel={onChannelClick}
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

      <ChannelDialog
        key={channelDialog?.url ?? "none"}
        channel={channelDialog}
        open={!!channelDialog}
        onOpenChange={(o) => !o && setChannelDialog(null)}
      />
    </div>
  )
}

// One-click access to the signed-in user's own YouTube lists. These resolve via
// yt-dlp using the stored cookies — no URL to paste. Watch Later / Liked are the
// strongest "download intent" sources; subscriptions is the recent uploads feed.
type MySource = {
  key: string
  label: string
  hint: string
  url: string
  kind: UrlKind
  limit?: number
  Icon: typeof ClockIcon
  follow?: boolean // show a "Suivre" action (auto-sync new items) for this list
  importSubs?: boolean // show an "Importer" action (follow every subscription)
}

const MY_SOURCES: MySource[] = [
  {
    key: "wl",
    label: "À regarder plus tard",
    hint: "Ta playlist Watch Later",
    url: "https://www.youtube.com/playlist?list=WL",
    kind: "playlist",
    Icon: ClockIcon,
    follow: true,
  },
  {
    key: "ll",
    label: "Vidéos likées",
    hint: "Tout ce que tu as aimé",
    url: "https://www.youtube.com/playlist?list=LL",
    kind: "playlist",
    Icon: ThumbsUpIcon,
    follow: true,
  },
  {
    key: "subs",
    label: "Abonnements",
    hint: "50 uploads récents · ou tout importer",
    url: ":ytsubscriptions",
    kind: "playlist",
    // The subscriptions feed is every upload from every sub — bound it or it
    // paginates forever.
    limit: 50,
    Icon: RssIcon,
    importSubs: true,
  },
]

function MyYoutube({
  onPick,
  disabled,
}: {
  onPick: (url: string, kind: UrlKind, limit?: number) => void
  disabled?: boolean
}) {
  const [hasCookies, setHasCookies] = useState<boolean | null>(null)
  const [following, setFollowing] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    backend
      .cookies()
      .then((c) => !cancelled && setHasCookies(!!c.present))
      .catch(() => !cancelled && setHasCookies(false))
    return () => {
      cancelled = true
    }
  }, [])

  async function follow(src: MySource) {
    setFollowing(src.key)
    try {
      // backfill OFF: only sync items added from now on (downloading the entire
      // current list — e.g. all liked videos — could be huge). Use "Voir" to
      // grab what's already in the list.
      const res = await backend.addWatch({
        url: src.url,
        quality: "",
        backfill: false,
        subfolder: "",
        date_after: "",
        title: src.label,
      })
      if (res.error) toast.error(res.error)
      else
        toast.success(
          `Abonné · « ${src.label} » : les nouvelles vidéos se téléchargeront seules (les actuelles via « Voir »).`,
        )
    } catch {
      toast.error("Échec de l'abonnement")
    } finally {
      setFollowing(null)
    }
  }

  // Hidden entirely until we know the cookie state, to avoid a flash.
  if (hasCookies === null) return null

  return (
    <>
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Mon YouTube</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!hasCookies && (
          <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
            Connecte ton compte en ajoutant tes cookies dans{" "}
            <span className="font-medium text-foreground">Réglages → Cookies YouTube</span>{" "}
            pour accéder à ta liste « À regarder plus tard », tes vidéos likées et tes
            abonnements.
          </p>
        )}
        <div className="flex flex-col gap-2">
          {MY_SOURCES.map((src) => {
            const { key, label, hint, url, kind, limit, Icon } = src
            return (
              <div
                key={key}
                className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
                  <Icon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{label}</p>
                  <p className="truncate text-xs text-muted-foreground">{hint}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={disabled || !hasCookies}
                    onClick={() => onPick(url, kind, limit)}
                  >
                    Voir
                  </Button>
                  {src.follow && (
                    <Button
                      size="sm"
                      disabled={!hasCookies || following === key}
                      onClick={() => void follow(src)}
                    >
                      {following === key ? (
                        <Loader2Icon className="size-4 animate-spin" />
                      ) : (
                        <BellPlusIcon className="size-4" />
                      )}
                      Suivre
                    </Button>
                  )}
                  {src.importSubs && (
                    <Button
                      size="sm"
                      disabled={!hasCookies}
                      onClick={() => setPickerOpen(true)}
                    >
                      <BellPlusIcon className="size-4" />
                      Choisir…
                    </Button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
    <SubscriptionsPicker open={pickerOpen} onOpenChange={setPickerOpen} />
    </>
  )
}

function SearchResults({
  videos,
  channels,
  avatars,
  quality,
  format,
  onQuality,
  onFormat,
  onOpenChannel,
  onDownload,
}: {
  videos: VideoPreview[]
  channels: ChannelResult[]
  avatars: Record<string, string>
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
                  {/* Real logo arrives asynchronously (avatars map); until then
                      the initial shows instead of a blank placeholder. */}
                  {avatars[c.url] ? (
                    <AvatarImage src={avatars[c.url]} alt={c.name} />
                  ) : null}
                  <AvatarFallback className="text-xs font-medium">
                    {c.name.charAt(0).toUpperCase() || <TvIcon className="size-4" />}
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
