"use client"

import { useEffect, useState } from "react"
import {
  ArrowLeftIcon,
  BellPlusIcon,
  CalendarIcon,
  CheckIcon,
  CompassIcon,
  DownloadIcon,
  FlaskConicalIcon,
  HistoryIcon,
  ListVideoIcon,
  Loader2Icon,
  RssIcon,
  TvIcon,
  UploadIcon,
} from "lucide-react"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import {
  detectSource,
  detectUrlKind,
  fetchChannelInfo,
  fetchPlaylistVideos,
  fetchUrlMetadata,
} from "@/lib/api"
import { backend, filtersToBackend } from "@/lib/backend"
import type { Subscription, SubscriptionFilters, UrlKind } from "@/lib/types"
import { useStore, type BackfillOptions } from "@/components/store-provider"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"
import { QualitySelect, FormatSelect } from "@/components/option-selects"
import { YoutubeView } from "@/components/views/youtube-view"

type Tab = "add" | "browse"
type Mode = "future" | "all" | "since"

interface Preview {
  kind: UrlKind
  title: string
  avatar: string
  channel?: string
  thumbnail?: string
  count?: number
  url: string
}

const EMPTY_FILTERS: SubscriptionFilters = {
  excludeShorts: false,
  excludeLives: false,
  includeKeywords: [],
  excludeKeywords: [],
}

/** "Ajouter une source" — one URL field detects the type and previews it, then
 *  offers the right action: subscribe (channel/playlist, with backfill + filter
 *  test) or capture once (a lone video). "Parcourir" embeds the catalogue search
 *  for when the URL isn't known. Bulk import lives here too. */
export function AddSourceDialog({
  open,
  initialUrl,
  onOpenChange,
  onGoToMemory,
}: {
  open: boolean
  initialUrl: string
  onOpenChange: (o: boolean) => void
  onGoToMemory: () => void
}) {
  const { settings, addDownload, addSubscription } = useStore()
  const [tab, setTab] = useState<Tab>("add")
  const [url, setUrl] = useState("")
  const [loading, setLoading] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [quality, setQuality] = useState(settings.defaultQuality)
  const [format, setFormat] = useState(settings.defaultFormat)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkText, setBulkText] = useState("")

  // Reset when (re)opened; prefill any URL passed in (e.g. from a paste toast).
  useEffect(() => {
    if (!open) return
    setTab("add")
    setUrl(initialUrl)
    setPreview(null)
    setBulkOpen(false)
    setBulkText("")
    if (initialUrl) void analyze(initialUrl)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialUrl])

  async function analyze(value?: string) {
    const q = (value ?? url).trim()
    if (!q) return
    setLoading(true)
    setPreview(null)
    try {
      const kind = detectUrlKind(q)
      if (kind === "channel") {
        const c = await fetchChannelInfo(q)
        setPreview({ kind, title: c.name, avatar: c.avatar, count: c.videoCount, url: q })
      } else if (kind === "playlist") {
        const { playlist } = await fetchPlaylistVideos(q, 1)
        setPreview({ kind, title: playlist.title, avatar: "", thumbnail: playlist.thumbnail, count: playlist.videoCount, url: q })
      } else {
        const v = await fetchUrlMetadata(q)
        setPreview({ kind: "video", title: v.title, avatar: "", thumbnail: v.thumbnail, channel: v.channel, url: q })
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Analyse impossible")
    } finally {
      setLoading(false)
    }
  }

  function captureVideo() {
    if (!preview) return
    addDownload({
      url: preview.url,
      title: preview.title,
      thumbnail: preview.thumbnail,
      quality,
      format,
      channel: preview.channel || detectSource(preview.url),
    })
    onOpenChange(false)
    onGoToMemory()
  }

  function runBulkImport(raw: string) {
    const urls = raw
      .split(/[\n,\s]+/)
      .map((u) => u.trim())
      .filter((u) => /^https?:\/\//.test(u))
    if (urls.length === 0) {
      toast.error("Aucune URL valide trouvée")
      return
    }
    urls.forEach((u) =>
      addDownload({
        url: u,
        title: "Capture en cours…",
        quality,
        format,
        channel: detectSource(u),
      }),
    )
    toast.success(`${urls.length} URL(s) ajoutée(s)`)
    onOpenChange(false)
    onGoToMemory()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="border-b border-border p-4">
          <DialogTitle>Ajouter une source</DialogTitle>
          <DialogDescription>
            Une source alimente votre mémoire — une chaîne, une playlist ou une vidéo.
          </DialogDescription>
          <div className="mt-2 flex w-fit items-center rounded-lg border border-border p-0.5 text-sm">
            <TabBtn active={tab === "add"} onClick={() => setTab("add")}>
              Coller une URL
            </TabBtn>
            <TabBtn active={tab === "browse"} onClick={() => setTab("browse")}>
              <CompassIcon className="size-3.5" /> Parcourir
            </TabBtn>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {tab === "browse" ? (
            <div className="p-0">
              <p className="px-6 pt-4 text-xs text-muted-foreground">
                Vous ne connaissez pas l&apos;URL&nbsp;? Cherchez une chaîne ou une vidéo, puis
                suivez-la ou téléchargez-la.
              </p>
              <YoutubeView />
            </div>
          ) : (
            <div className="flex flex-col gap-4 p-4 sm:p-6">
              {/* Step ① — the single URL field */}
              <div className="flex items-center gap-2">
                <Input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && analyze()}
                  placeholder="Collez une URL (chaîne, playlist, vidéo…)"
                  className="h-10 flex-1"
                  aria-label="URL de la source"
                  autoFocus
                />
                <Button className="h-10" onClick={() => analyze()} disabled={!url.trim() || loading}>
                  {loading ? <Loader2Icon className="animate-spin" /> : "Analyser"}
                </Button>
              </div>

              {/* Step ② — preview + the right action for the detected type */}
              {loading && <p className="text-sm text-muted-foreground">Détection du type…</p>}

              {preview && !loading && (
                <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4">
                  <div className="flex items-center gap-3">
                    {preview.kind === "channel" ? (
                      <Avatar className="size-12">
                        <AvatarImage src={preview.avatar} alt={preview.title} />
                        <AvatarFallback>{preview.title[0]}</AvatarFallback>
                      </Avatar>
                    ) : (
                      <div className="relative aspect-video w-24 shrink-0 overflow-hidden rounded-md bg-muted">
                        {preview.thumbnail ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={preview.thumbnail} alt="" className="size-full object-cover" />
                        ) : null}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <KindBadge kind={preview.kind} />
                      </div>
                      <p className="mt-1 line-clamp-2 text-sm font-medium">{preview.title}</p>
                      {typeof preview.count === "number" && preview.count > 0 && (
                        <p className="text-xs text-muted-foreground">{preview.count} vidéos</p>
                      )}
                    </div>
                  </div>

                  <Separator />

                  {preview.kind === "video" ? (
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex items-center gap-2">
                        <QualitySelect value={quality} onChange={setQuality} size="sm" />
                        <FormatSelect value={format} onChange={setFormat} size="sm" />
                      </div>
                      <Button onClick={captureVideo}>
                        <DownloadIcon data-icon="inline-start" /> Capturer maintenant
                      </Button>
                    </div>
                  ) : (
                    <SubscribeForm
                      preview={preview}
                      quality={quality}
                      format={format}
                      onQuality={setQuality}
                      onFormat={setFormat}
                      onSubscribe={(sub, opts) => {
                        addSubscription(sub, opts)
                        onOpenChange(false)
                      }}
                    />
                  )}
                </div>
              )}

              {/* Bulk import (preserved from the old home). */}
              <div className="rounded-xl border border-border">
                <button
                  type="button"
                  onClick={() => setBulkOpen((o) => !o)}
                  className="flex w-full items-center gap-2 p-3 text-left text-sm font-medium"
                >
                  <UploadIcon className="size-4 text-muted-foreground" />
                  Importer plusieurs URLs
                </button>
                {bulkOpen && (
                  <div className="flex flex-col gap-2 border-t border-border p-3">
                    <Textarea
                      value={bulkText}
                      onChange={(e) => setBulkText(e.target.value)}
                      placeholder={"https://youtube.com/watch?v=…\nhttps://vimeo.com/…"}
                      className="min-h-24 font-mono text-xs"
                    />
                    <Button
                      size="sm"
                      className="w-fit"
                      onClick={() => runBulkImport(bulkText)}
                      disabled={!bulkText.trim()}
                    >
                      <DownloadIcon data-icon="inline-start" /> Tout capturer
                    </Button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function SubscribeForm({
  preview,
  quality,
  format,
  onQuality,
  onFormat,
  onSubscribe,
}: {
  preview: Preview
  quality: string
  format: string
  onQuality: (v: string) => void
  onFormat: (v: string) => void
  onSubscribe: (sub: Subscription, opts: BackfillOptions) => void
}) {
  const [mode, setMode] = useState<Mode>("future")
  const [date, setDate] = useState("")
  const [filters, setFilters] = useState<SubscriptionFilters>(EMPTY_FILTERS)
  const [previewing, setPreviewing] = useState(false)
  const [impact, setImpact] = useState<{ listed: number; kept: number; rejected: number } | null>(null)

  const MODES: { id: Mode; icon: typeof RssIcon; title: string; desc: string }[] = [
    { id: "future", icon: RssIcon, title: "Seulement les prochaines", desc: "Ignore l'historique." },
    { id: "all", icon: HistoryIcon, title: "Toutes les anciennes", desc: "Tout l'historique, puis les nouveautés." },
    { id: "since", icon: CalendarIcon, title: "À partir d'une date", desc: "Après une date précise." },
  ]

  async function test() {
    setPreviewing(true)
    setImpact(null)
    try {
      const r = await backend.previewFilters(preview.url, filtersToBackend(filters))
      if (r.error) toast.error(r.error)
      else setImpact({ listed: r.listed, kept: r.kept, rejected: r.rejected })
    } catch {
      toast.error("Échec du test des filtres")
    } finally {
      setPreviewing(false)
    }
  }

  function subscribe() {
    const opts: BackfillOptions =
      mode === "future" ? { backfill: false } : mode === "all" ? { backfill: true } : { backfill: true, dateAfter: date }
    const sub: Subscription = {
      id: "",
      type: preview.kind === "playlist" ? "playlist" : "channel",
      name: preview.title,
      avatar: preview.avatar || preview.thumbnail || "",
      url: preview.url,
      checkIntervalHours: 6,
      active: true,
      lastChecked: new Date().toISOString(),
      dateAfter: mode === "since" ? date : "",
      filters,
      lastCheck: null,
      defaultQuality: quality,
      defaultFormat: format,
      podcastFeed: false,
    }
    onSubscribe(sub, opts)
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="text-sm">Qualité</span>
        <QualitySelect value={quality} onChange={onQuality} size="sm" />
        <FormatSelect value={format} onChange={onFormat} size="sm" />
      </div>

      <div className="flex flex-col gap-2">
        {MODES.map((o) => {
          const Icon = o.icon
          const selected = mode === o.id
          return (
            <button
              key={o.id}
              type="button"
              onClick={() => setMode(o.id)}
              className={cn(
                "flex items-start gap-3 rounded-lg border p-2.5 text-left transition-colors",
                selected ? "border-primary/50 bg-primary/5" : "border-border hover:bg-muted/50",
              )}
            >
              <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{o.title}</span>
                  {selected && <CheckIcon className="size-4 text-primary" />}
                </div>
                <p className="text-xs text-muted-foreground">{o.desc}</p>
              </div>
            </button>
          )
        })}
        {mode === "since" && (
          <Input
            type="date"
            value={date}
            max={new Date().toISOString().slice(0, 10)}
            onChange={(e) => setDate(e.target.value)}
            className="w-48"
          />
        )}
      </div>

      {/* Quick filters + impact test */}
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={filters.excludeShorts}
            onCheckedChange={(v) => {
              setFilters((f) => ({ ...f, excludeShorts: v }))
              setImpact(null)
            }}
            aria-label="Exclure les Shorts"
          />
          Sans Shorts
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={filters.excludeLives}
            onCheckedChange={(v) => {
              setFilters((f) => ({ ...f, excludeLives: v }))
              setImpact(null)
            }}
            aria-label="Exclure les Lives"
          />
          Sans Lives
        </label>
        <Button size="sm" variant="outline" onClick={test} disabled={previewing}>
          {previewing ? (
            <Loader2Icon data-icon="inline-start" className="animate-spin" />
          ) : (
            <FlaskConicalIcon data-icon="inline-start" />
          )}
          Tester les filtres
        </Button>
      </div>
      {impact && (
        <p className="text-sm text-muted-foreground">
          Sur {impact.listed} vidéos : <span className="font-medium text-success">{impact.kept} gardées</span> ·{" "}
          <span className="font-medium text-warning">{impact.rejected} filtrées</span>
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Vous pourrez affiner cadence et filtres avancés depuis la carte de la source.
      </p>

      <Button onClick={subscribe} className="w-fit">
        <BellPlusIcon data-icon="inline-start" /> S&apos;abonner
      </Button>
    </div>
  )
}

function KindBadge({ kind }: { kind: UrlKind }) {
  if (kind === "playlist")
    return (
      <Badge variant="secondary" className="gap-1 text-[10px]">
        <ListVideoIcon className="size-3" /> Playlist
      </Badge>
    )
  if (kind === "channel")
    return (
      <Badge variant="secondary" className="gap-1 text-[10px]">
        <TvIcon className="size-3" /> Chaîne
      </Badge>
    )
  return (
    <Badge variant="secondary" className="gap-1 text-[10px]">
      <DownloadIcon className="size-3" /> Vidéo
    </Badge>
  )
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-3 py-1 font-medium transition-colors",
        active ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  )
}
