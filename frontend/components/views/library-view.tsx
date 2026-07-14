"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  CheckIcon,
  CircleCheckIcon,
  ClockIcon,
  FileTextIcon,
  LayoutGridIcon,
  ListIcon,
  Loader2Icon,
  MapIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import { backend, type Content, type LibraryQuery } from "@/lib/backend"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { SourceBadge } from "@/components/source-badge"
import { InlineFeedback } from "@/components/inline-feedback"
import { ContentSteps, isEnriching } from "@/components/content-steps"
import { MemoryMap } from "@/components/memory-map"
import { CitationsView } from "@/components/views/citations-view"

const PAGE = 24

function fmtDuration(sec: number | null): string {
  if (!sec) return ""
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`
}

function relativeDate(epoch: number | null): string {
  if (!epoch) return ""
  const diff = Date.now() - epoch * 1000
  const d = Math.floor(diff / 86_400_000)
  if (d <= 0) return "aujourd'hui"
  if (d === 1) return "hier"
  if (d < 30) return `il y a ${d} j`
  if (d < 365) return `il y a ${Math.floor(d / 30)} mois`
  return `il y a ${Math.floor(d / 365)} an(s)`
}

/** Mémoire — the complete library. Contenus | Citations, grid/list (+ a Carte
 *  mode landing next prompt), sort/filter, processing indicators, and the
 *  progressive enrichment chips on any still-processing card. */
export function MemoryView({
  onOpen,
  onAddSource,
  mapCenter,
}: {
  onOpen: (id: string, startAt?: number) => void
  onAddSource: (url?: string) => void
  mapCenter?: string | null
}) {
  const [items, setItems] = useState<Content[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [mode, setMode] = useState<"grid" | "list" | "map">(mapCenter ? "map" : "grid")
  const [sort, setSort] = useState<NonNullable<LibraryQuery["sort"]>>("downloaded_at")
  const [kind, setKind] = useState<"all" | "video" | "audio">("all")
  const [transcribed, setTranscribed] = useState<"all" | "yes" | "no">("all")
  const [q, setQ] = useState("")
  const [tab, setTab] = useState<"contents" | "citations">("contents")

  // "Ouvrir la carte" (from a fiche) selects the Carte mode centred on a content.
  useEffect(() => {
    if (mapCenter) setMode("map")
  }, [mapCenter])

  const query = useCallback(
    (offset: number): LibraryQuery => ({
      limit: PAGE,
      offset,
      sort,
      order: sort === "title" ? "asc" : "desc",
      kind: kind === "all" ? undefined : kind,
      transcribed: transcribed === "all" ? undefined : transcribed,
      q: q.trim() || undefined,
    }),
    [sort, kind, transcribed, q],
  )

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const page = await backend.library(query(0))
      setItems(page.items)
      setTotal(page.total)
    } catch {
      setItems([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [query])

  // Silent reload (no skeleton flash): refresh statuses in place and surface any
  // brand-new pending card at the top — used by polling + the capture grace window.
  const refresh = useCallback(async () => {
    try {
      const page = await backend.library(query(0))
      setTotal(page.total)
      setItems((prev) => {
        if (prev.length <= PAGE) return page.items
        const byId = new Map(page.items.map((c) => [c.id, c]))
        const known = new Set(prev.map((c) => c.id))
        const fresh = page.items.filter((c) => !known.has(c.id))
        return [...fresh, ...prev.map((c) => byId.get(c.id) ?? c)]
      })
    } catch {
      /* keep prior items */
    }
  }, [query])

  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      load()
      return
    }
    const t = setTimeout(load, 250)
    return () => clearTimeout(t)
  }, [load])

  // Capture grace window: a just-captured pending card may land a beat after we
  // mount — refetch a couple of times so it appears within a few seconds.
  useEffect(() => {
    const t1 = setTimeout(refresh, 2000)
    const t2 = setTimeout(refresh, 5000)
    return () => {
      clearTimeout(t1)
      clearTimeout(t2)
    }
  }, [refresh])

  // While anything is still enriching, poll silently so the step-chips advance live.
  useEffect(() => {
    if (!items.some(isEnriching)) return
    const t = setInterval(refresh, 3000)
    return () => clearInterval(t)
  }, [items, refresh])

  async function loadMore() {
    setLoadingMore(true)
    try {
      const page = await backend.library(query(items.length))
      setItems((prev) => [...prev, ...page.items])
      setTotal(page.total)
    } finally {
      setLoadingMore(false)
    }
  }

  async function rescan() {
    try {
      await backend.rescanLibrary()
      toast.success("Analyse de la bibliothèque lancée", {
        description: "Progression visible dans l'activité.",
      })
    } catch {
      toast.error("Impossible de lancer l'analyse")
    }
  }

  const hasMore = items.length < total

  return (
    <TooltipProvider>
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 sm:p-6 lg:p-8">
        <div className="flex w-fit items-center rounded-lg border border-border p-0.5 text-sm">
          <button
            type="button"
            onClick={() => setTab("contents")}
            className={cn(
              "rounded-md px-3 py-1 font-medium transition-colors",
              tab === "contents" ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            Contenus
          </button>
          <button
            type="button"
            onClick={() => setTab("citations")}
            className={cn(
              "rounded-md px-3 py-1 font-medium transition-colors",
              tab === "citations" ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            Citations
          </button>
        </div>

        {tab === "citations" ? (
          <CitationsView onOpen={onOpen} />
        ) : (
          <>
            {/* Toolbar */}
            <div className="flex flex-wrap items-center gap-2">
              {mode !== "map" && (
                <>
                  <div className="relative min-w-48 flex-1">
                    <SearchIcon className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={q}
                      onChange={(e) => setQ(e.target.value)}
                      placeholder="Rechercher un titre ou une chaîne…"
                      className="pl-8"
                      aria-label="Rechercher dans la bibliothèque"
                    />
                  </div>
                  <Select value={sort} onValueChange={(v) => setSort((v as LibraryQuery["sort"]) ?? "downloaded_at")}>
                    <SelectTrigger size="sm" className="w-40" aria-label="Trier">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="downloaded_at">Récents</SelectItem>
                      <SelectItem value="title">Titre (A→Z)</SelectItem>
                      <SelectItem value="duration_seconds">Durée</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={kind} onValueChange={(v) => setKind((v as "all" | "video" | "audio") ?? "all")}>
                    <SelectTrigger size="sm" className="w-32" aria-label="Type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Tous types</SelectItem>
                      <SelectItem value="video">Vidéo</SelectItem>
                      <SelectItem value="audio">Audio</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={transcribed} onValueChange={(v) => setTranscribed((v as "all" | "yes" | "no") ?? "all")}>
                    <SelectTrigger size="sm" className="w-36" aria-label="Transcription">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Transcription</SelectItem>
                      <SelectItem value="yes">Transcrit</SelectItem>
                      <SelectItem value="no">Non transcrit</SelectItem>
                    </SelectContent>
                  </Select>
                </>
              )}
              {mode === "map" && (
                <p className="min-w-48 flex-1 text-sm text-muted-foreground">
                  Les liens entre vos contenus, toujours centrés sur l&apos;un d&apos;eux.
                </p>
              )}
              <div className="flex items-center rounded-lg border border-border">
                <Button
                  size="icon-sm"
                  variant={mode === "grid" ? "secondary" : "ghost"}
                  onClick={() => setMode("grid")}
                  aria-label="Vue grille"
                >
                  <LayoutGridIcon />
                </Button>
                <Button
                  size="icon-sm"
                  variant={mode === "list" ? "secondary" : "ghost"}
                  onClick={() => setMode("list")}
                  aria-label="Vue liste"
                >
                  <ListIcon />
                </Button>
                <Button
                  size="icon-sm"
                  variant={mode === "map" ? "secondary" : "ghost"}
                  onClick={() => setMode("map")}
                  aria-label="Vue carte"
                >
                  <MapIcon />
                </Button>
              </div>
              {mode !== "map" && (
                <Button size="sm" variant="ghost" onClick={rescan}>
                  <RefreshCwIcon data-icon="inline-start" /> Analyser
                </Button>
              )}
            </div>

            {mode === "map" ? (
              <MemoryMap key={mapCenter ?? "start"} initialCenterId={mapCenter ?? null} onOpen={onOpen} />
            ) : loading ? (
              <LibrarySkeleton layout={mode === "list" ? "list" : "grid"} />
            ) : items.length === 0 ? (
              <InlineFeedback
                state="empty"
                icon={PlusIcon}
                title="Mémoire vide"
                description="Ajoutez une source — une chaîne, une playlist ou une vidéo — pour commencer à archiver."
                action={
                  <Button size="sm" onClick={() => onAddSource()}>
                    <PlusIcon data-icon="inline-start" /> Ajouter une source
                  </Button>
                }
              />
            ) : mode === "grid" ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {items.map((c) => (
                  <GridCard key={c.id} content={c} onOpen={onOpen} />
                ))}
              </div>
            ) : (
              <div className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border">
                {items.map((c) => (
                  <ListRow key={c.id} content={c} onOpen={onOpen} />
                ))}
              </div>
            )}

            {mode !== "map" && !loading && hasMore && (
              <div className="flex justify-center pt-2">
                <Button variant="outline" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? "Chargement…" : `Charger plus (${total - items.length})`}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </TooltipProvider>
  )
}

const TRANSCRIPT_META: Record<
  string,
  { icon: typeof FileTextIcon; className: string; label: string; spin?: boolean }
> = {
  none: { icon: FileTextIcon, className: "text-muted-foreground/40", label: "Non transcrit" },
  queued: { icon: ClockIcon, className: "text-muted-foreground", label: "En file de transcription" },
  running: { icon: Loader2Icon, className: "text-primary", label: "Transcription en cours", spin: true },
  done: { icon: CircleCheckIcon, className: "text-success", label: "Transcrit" },
  error: { icon: TriangleAlertIcon, className: "text-destructive", label: "Échec de transcription" },
  skipped: { icon: CheckIcon, className: "text-muted-foreground", label: "Sous-titres source utilisés" },
}

function TranscriptDot({ content }: { content: Content }) {
  const meta = TRANSCRIPT_META[content.transcript_status] ?? TRANSCRIPT_META.none
  const Icon = meta.icon
  const transcribed = content.transcript_status === "done" || content.transcript_status === "skipped"
  const tip = `${transcribed ? "transcrit ✓" : meta.label}${
    content.index_status === "done" ? " · indexé ✓" : ""
  }`
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className={cn("flex items-center", meta.className)}>
            <Icon className={cn("size-3.5", meta.spin && "animate-spin")} />
          </span>
        }
      />
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  )
}

function ChapteredBadge() {
  return (
    <span
      className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary"
      title="Chapitres disponibles"
    >
      <ListIcon className="size-3" /> chapitré
    </span>
  )
}

function Thumb({ content, className }: { content: Content; className?: string }) {
  return (
    <div className={cn("relative overflow-hidden rounded-md bg-muted", className)}>
      {content.thumbnail_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={content.thumbnail_url} alt="" className="size-full object-cover" />
      ) : (
        <div className="flex size-full items-center justify-center text-muted-foreground">
          <PlayIcon className="size-6" />
        </div>
      )}
      {content.lifecycle === "pending" && (
        <span className="absolute inset-0 flex items-center justify-center bg-black/40 text-[10px] font-medium text-white">
          <Loader2Icon className="mr-1 size-3.5 animate-spin" />
          {content.download_progress != null ? `${Math.round(content.download_progress)}%` : "…"}
        </span>
      )}
      {content.duration_seconds ? (
        <span className="absolute bottom-1 right-1 rounded bg-black/80 px-1 text-[10px] text-white tabular-nums">
          {fmtDuration(content.duration_seconds)}
        </span>
      ) : null}
    </div>
  )
}

function GridCard({ content, onOpen }: { content: Content; onOpen: (id: string) => void }) {
  const pending = content.lifecycle === "pending"
  return (
    <button
      type="button"
      onClick={() => !pending && onOpen(content.id)}
      aria-disabled={pending}
      className={cn(
        "group flex flex-col gap-2 rounded-lg border border-transparent p-1 text-left transition-colors",
        pending ? "cursor-default" : "hover:bg-muted/50",
      )}
    >
      <Thumb content={content} className="aspect-video w-full" />
      <div className="flex flex-col gap-1 px-1 pb-1">
        <p className="line-clamp-2 text-sm font-medium leading-snug">{content.title}</p>
        {isEnriching(content) ? (
          <ContentSteps content={content} className="mt-0.5" />
        ) : content.summary_short ? (
          <p className="line-clamp-2 text-xs text-muted-foreground">{content.summary_short}</p>
        ) : (
          <p className="truncate text-xs text-muted-foreground">{content.channel}</p>
        )}
        {!isEnriching(content) && (
          <div className="mt-0.5 flex items-center gap-2">
            <SourceBadge source={content.source} className="text-[10px]" />
            {content.chapter_count > 0 && <ChapteredBadge />}
            <span className="text-[11px] text-muted-foreground">{relativeDate(content.downloaded_at)}</span>
            <span className="ml-auto">
              <TranscriptDot content={content} />
            </span>
          </div>
        )}
      </div>
    </button>
  )
}

function ListRow({ content, onOpen }: { content: Content; onOpen: (id: string) => void }) {
  const pending = content.lifecycle === "pending"
  return (
    <button
      type="button"
      onClick={() => !pending && onOpen(content.id)}
      aria-disabled={pending}
      className={cn(
        "flex items-center gap-3 p-2 text-left transition-colors",
        pending ? "cursor-default" : "hover:bg-muted/50",
      )}
    >
      <Thumb content={content} className="aspect-video w-28 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="line-clamp-1 text-sm font-medium">{content.title}</p>
        {isEnriching(content) ? (
          <ContentSteps content={content} className="mt-1" />
        ) : content.summary_short ? (
          <p className="line-clamp-1 text-xs text-muted-foreground">{content.summary_short}</p>
        ) : (
          <p className="truncate text-xs text-muted-foreground">{content.channel}</p>
        )}
      </div>
      {!isEnriching(content) && (
        <>
          {content.chapter_count > 0 && <ChapteredBadge />}
          <SourceBadge source={content.source} className="hidden text-[10px] sm:inline-flex" />
          <span className="hidden w-20 text-right text-[11px] text-muted-foreground sm:block">
            {relativeDate(content.downloaded_at)}
          </span>
          <TranscriptDot content={content} />
        </>
      )}
    </button>
  )
}

function LibrarySkeleton({ layout }: { layout: "grid" | "list" }) {
  if (layout === "list") {
    return (
      <div className="flex flex-col gap-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="aspect-video w-28 shrink-0 rounded-md" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </div>
        ))}
      </div>
    )
  }
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex flex-col gap-2">
          <Skeleton className="aspect-video w-full rounded-md" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  )
}
