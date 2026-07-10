"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  CompassIcon,
  FileTextIcon,
  LayoutGridIcon,
  ListIcon,
  PlayIcon,
  RefreshCwIcon,
  SearchIcon,
} from "lucide-react"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import { backend, type Content, type LibraryQuery } from "@/lib/backend"
import type { View } from "@/components/app-shell"
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
  const [q, setQ] = useState("")

  const query = useCallback(
    (offset: number): LibraryQuery => ({
      limit: PAGE,
      offset,
      sort,
      order: sort === "title" ? "asc" : "desc",
      kind: kind === "all" ? undefined : kind,
      q: q.trim() || undefined,
    }),
    [sort, kind, q],
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

/** Small greyed indicator for a future feature (transcription, prompt 6). */
function TranscriptDot({ status }: { status: Content["transcript_status"] }) {
  const done = status === "done"
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "flex items-center",
              done ? "text-success" : "text-muted-foreground/40",
            )}
          >
            <FileTextIcon className="size-3.5" />
          </span>
        }
      />
      <TooltipContent>{done ? "Transcrit" : "Transcription à venir"}</TooltipContent>
    </Tooltip>
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
        <p className="truncate text-xs text-muted-foreground">{content.channel}</p>
        <div className="mt-0.5 flex items-center gap-2">
          <SourceBadge source={content.source} className="text-[10px]" />
          <span className="text-[11px] text-muted-foreground">{relativeDate(content.downloaded_at)}</span>
          <span className="ml-auto">
            <TranscriptDot status={content.transcript_status} />
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
        <p className="truncate text-xs text-muted-foreground">{content.channel}</p>
      </div>
      <SourceBadge source={content.source} className="hidden text-[10px] sm:inline-flex" />
      <span className="hidden w-20 text-right text-[11px] text-muted-foreground sm:block">
        {relativeDate(content.downloaded_at)}
      </span>
      <TranscriptDot status={content.transcript_status} />
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
