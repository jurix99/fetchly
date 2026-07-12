"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  CheckIcon,
  CircleCheckIcon,
  ClockIcon,
  CompassIcon,
  FileTextIcon,
  LayoutGridIcon,
  ListIcon,
  Loader2Icon,
  PlayIcon,
  RefreshCwIcon,
  SearchIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import { backend, type Content, type LibraryQuery } from "@/lib/backend"
import { getRecentlyPlayed, type PlaybackEntry } from "@/lib/playback"
import type { View } from "@/components/app-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
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

export function LibraryView({
  onOpen,
  onNavigate,
}: {
  onOpen: (id: string, startAt?: number) => void
  onNavigate: (v: View) => void
}) {
  const [items, setItems] = useState<Content[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [layout, setLayout] = useState<"grid" | "list">("grid")
  const [sort, setSort] = useState<NonNullable<LibraryQuery["sort"]>>("downloaded_at")
  const [kind, setKind] = useState<"all" | "video" | "audio">("all")
  const [transcribed, setTranscribed] = useState<"all" | "yes" | "no">("all")
  const [q, setQ] = useState("")

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

  // Debounce filter/sort changes into a reload.
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
        description: "Progression visible dans Téléchargements.",
      })
    } catch {
      toast.error("Impossible de lancer l'analyse")
    }
  }

  const hasMore = items.length < total

  return (
    <TooltipProvider>
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 sm:p-6 lg:p-8">
        {/* Composable home sections. Phase-3 "Digest" will slot in ABOVE these
            without any refonte — same stacked-section structure. Hidden while
            searching so the query drives the grid. */}
        {q.trim() === "" && <LibraryHome onOpen={onOpen} />}

        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-48">
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
          <div className="flex items-center rounded-lg border border-border">
            <Button
              size="icon-sm"
              variant={layout === "grid" ? "secondary" : "ghost"}
              onClick={() => setLayout("grid")}
              aria-label="Vue grille"
            >
              <LayoutGridIcon />
            </Button>
            <Button
              size="icon-sm"
              variant={layout === "list" ? "secondary" : "ghost"}
              onClick={() => setLayout("list")}
              aria-label="Vue liste"
            >
              <ListIcon />
            </Button>
          </div>
          <Button size="sm" variant="ghost" onClick={rescan}>
            <RefreshCwIcon data-icon="inline-start" /> Analyser
          </Button>
        </div>

        {loading ? (
          <LibrarySkeleton layout={layout} />
        ) : items.length === 0 ? (
          <InlineFeedback
            state="empty"
            icon={CompassIcon}
            title="Bibliothèque vide"
            description="Vos téléchargements apparaîtront ici automatiquement."
            action={
              <Button size="sm" onClick={() => onNavigate("explorer")}>
                <CompassIcon data-icon="inline-start" /> Explorer des contenus
              </Button>
            }
          />
        ) : layout === "grid" ? (
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

        {!loading && hasMore && (
          <div className="flex justify-center pt-2">
            <Button variant="outline" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? "Chargement…" : `Charger plus (${total - items.length})`}
            </Button>
          </div>
        )}
      </div>
    </TooltipProvider>
  )
}

/** Live transcription indicator, driven by transcript_status. */
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

/** Discreet "chaptered" marker shown on cards when a content has chapters. */
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
      {content.duration_seconds ? (
        <span className="absolute bottom-1 right-1 rounded bg-black/80 px-1 text-[10px] text-white tabular-nums">
          {fmtDuration(content.duration_seconds)}
        </span>
      ) : null}
    </div>
  )
}

function GridCard({ content, onOpen }: { content: Content; onOpen: (id: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(content.id)}
      className="group flex flex-col gap-2 rounded-lg border border-transparent p-1 text-left transition-colors hover:bg-muted/50"
    >
      <Thumb content={content} className="aspect-video w-full" />
      <div className="flex flex-col gap-1 px-1 pb-1">
        <p className="line-clamp-2 text-sm font-medium leading-snug">{content.title}</p>
        {content.summary_short ? (
          <p className="line-clamp-2 text-xs text-muted-foreground">{content.summary_short}</p>
        ) : (
          <p className="truncate text-xs text-muted-foreground">{content.channel}</p>
        )}
        <div className="mt-0.5 flex items-center gap-2">
          <SourceBadge source={content.source} className="text-[10px]" />
          {content.chapter_count > 0 && <ChapteredBadge />}
          <span className="text-[11px] text-muted-foreground">{relativeDate(content.downloaded_at)}</span>
          <span className="ml-auto">
            <TranscriptDot content={content} />
          </span>
        </div>
      </div>
    </button>
  )
}

function ListRow({ content, onOpen }: { content: Content; onOpen: (id: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(content.id)}
      className="flex items-center gap-3 p-2 text-left transition-colors hover:bg-muted/50"
    >
      <Thumb content={content} className="aspect-video w-28 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="line-clamp-1 text-sm font-medium">{content.title}</p>
        {content.summary_short ? (
          <p className="line-clamp-1 text-xs text-muted-foreground">{content.summary_short}</p>
        ) : (
          <p className="truncate text-xs text-muted-foreground">{content.channel}</p>
        )}
      </div>
      {content.chapter_count > 0 && <ChapteredBadge />}
      <SourceBadge source={content.source} className="hidden text-[10px] sm:inline-flex" />
      <span className="hidden w-20 text-right text-[11px] text-muted-foreground sm:block">
        {relativeDate(content.downloaded_at)}
      </span>
      <TranscriptDot content={content} />
    </button>
  )
}

/** Stacked home sections for the Library-as-home. Each block self-hides when it
 *  has nothing to show, so the header stays calm (DESIGN: calme par défaut). */
function LibraryHome({ onOpen }: { onOpen: (id: string, startAt?: number) => void }) {
  return (
    <div className="flex flex-col gap-6">
      {/* Phase 3: <DigestSection /> inserts here, above Reprendre. */}
      <ResumeSection onOpen={onOpen} />
      <RecentSection onOpen={onOpen} />
    </div>
  )
}

/** "Reprendre" — the 3 last-played contents with a remembered position
 *  (localStorage). Resumes exactly where playback stopped. */
function ResumeSection({ onOpen }: { onOpen: (id: string, startAt?: number) => void }) {
  const [items, setItems] = useState<{ content: Content; entry: PlaybackEntry }[]>([])

  useEffect(() => {
    let alive = true
    const entries = getRecentlyPlayed(3)
    if (entries.length === 0) {
      setItems([])
      return
    }
    Promise.all(
      entries.map((e) =>
        backend
          .libraryItem(e.id)
          .then((c) => (c && !("error" in c && c.error) ? { content: c as Content, entry: e } : null))
          .catch(() => null),
      ),
    ).then((rows) => {
      if (alive) setItems(rows.filter((r): r is { content: Content; entry: PlaybackEntry } => !!r))
    })
    return () => {
      alive = false
    }
  }, [])

  if (items.length === 0) return null

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold">Reprendre</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {items.map(({ content, entry }) => (
          <ResumeCard key={content.id} content={content} entry={entry} onOpen={onOpen} />
        ))}
      </div>
    </section>
  )
}

function ResumeCard({
  content,
  entry,
  onOpen,
}: {
  content: Content
  entry: PlaybackEntry
  onOpen: (id: string, startAt?: number) => void
}) {
  const pct = entry.duration > 0 ? Math.min(100, (entry.position / entry.duration) * 100) : 0
  return (
    <button
      type="button"
      onClick={() => onOpen(content.id, entry.position)}
      className="group flex gap-3 rounded-xl border border-border bg-card p-2 text-left transition-colors hover:border-primary/40"
    >
      <div className="relative aspect-video w-28 shrink-0 overflow-hidden rounded-lg bg-muted">
        {content.thumbnail_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={content.thumbnail_url} alt="" className="size-full object-cover" />
        ) : (
          <div className="flex size-full items-center justify-center text-muted-foreground">
            <PlayIcon className="size-5" />
          </div>
        )}
        <span className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-black/60 px-1 py-0.5 text-[10px] font-medium text-white">
          <PlayIcon className="size-2.5" /> {fmtDuration(entry.position)}
        </span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="line-clamp-2 text-sm font-medium leading-snug">{content.title}</p>
        <p className="truncate text-xs text-muted-foreground">{content.channel}</p>
        <Progress value={pct} className="mt-auto h-1" />
      </div>
    </button>
  )
}

/** "Ajouts récents" — everything downloaded in the last 7 days. */
function RecentSection({ onOpen }: { onOpen: (id: string, startAt?: number) => void }) {
  const [items, setItems] = useState<Content[] | null>(null)

  useEffect(() => {
    let alive = true
    backend
      .library({ sort: "downloaded_at", order: "desc", limit: 12 })
      .then((page) => {
        if (!alive) return
        const cutoff = Date.now() / 1000 - 7 * 86400
        setItems(page.items.filter((c) => (c.downloaded_at ?? 0) >= cutoff).slice(0, 8))
      })
      .catch(() => alive && setItems([]))
    return () => {
      alive = false
    }
  }, [])

  if (!items || items.length === 0) return null

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold">Ajouts récents</h2>
      <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-1">
        {items.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => onOpen(c.id)}
            className="group flex w-40 shrink-0 flex-col gap-1.5 rounded-lg border border-transparent p-1 text-left transition-colors hover:bg-muted/50"
          >
            <Thumb content={c} className="aspect-video w-full" />
            <p className="line-clamp-2 text-xs font-medium leading-snug">{c.title}</p>
            <p className="truncate text-[11px] text-muted-foreground">{c.channel}</p>
          </button>
        ))}
      </div>
    </section>
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
