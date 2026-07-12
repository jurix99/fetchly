"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  FileTextIcon,
  PlayIcon,
  SearchIcon,
  SparklesIcon,
  SlidersHorizontalIcon,
} from "lucide-react"

import { cn } from "@/lib/utils"
import {
  backend,
  type LibrarySearchResponse,
  type LibrarySearchResult,
  type SearchFilters,
  type SearchPassage,
} from "@/lib/backend"
import type { View } from "@/components/app-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
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
import { InlineFeedback } from "@/components/inline-feedback"
import { SourceBadge } from "@/components/source-badge"
import { HighlightedText } from "@/components/highlighted-text"

const RECALL_S = 2

function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

type Period = "" | "week" | "month" | "quarter" | "year"
type Dur = "" | "short" | "medium" | "long"

const DUR_RANGE: Record<Exclude<Dur, "">, { min?: number; max?: number }> = {
  short: { max: 240 },
  medium: { min: 240, max: 1200 },
  long: { min: 1200 },
}

export function SearchView({
  initialQuery,
  onQueryChange,
  onOpen,
  onNavigate,
}: {
  initialQuery: string
  onQueryChange: (q: string) => void
  onOpen: (id: string, startAt: number, queryHash?: string) => void
  onNavigate: (v: View) => void
}) {
  const [q, setQ] = useState(initialQuery)
  const [resp, setResp] = useState<LibrarySearchResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [source, setSource] = useState("")
  const [channel, setChannel] = useState("")
  const [period, setPeriod] = useState<Period>("")
  const [dur, setDur] = useState<Dur>("")
  const abortRef = useRef<AbortController | null>(null)

  const filters: SearchFilters = useMemo(() => {
    const range = dur ? DUR_RANGE[dur] : {}
    return {
      source: source || undefined,
      channel: channel || undefined,
      period: period || undefined,
      min_duration: range.min,
      max_duration: range.max,
    }
  }, [source, channel, period, dur])

  // Live search: 250 ms debounce, cancel any stale in-flight request.
  useEffect(() => {
    const query = q.trim()
    if (!query) {
      abortRef.current?.abort()
      setResp(null)
      setLoading(false)
      return
    }
    setLoading(true)
    const t = setTimeout(async () => {
      abortRef.current?.abort()
      const ctrl = new AbortController()
      abortRef.current = ctrl
      try {
        const r = await backend.searchLibrary(query, "all", 30, filters, ctrl.signal)
        if (!ctrl.signal.aborted) setResp(r)
      } catch {
        /* aborted / failed — keep prior */
      } finally {
        if (!ctrl.signal.aborted) setLoading(false)
      }
    }, 250)
    return () => clearTimeout(t)
  }, [q, filters])

  // Keep the URL query param in sync (shareable /?q=…).
  useEffect(() => {
    onQueryChange(q.trim())
  }, [q, onQueryChange])

  const results = resp?.results ?? []
  // Facets derived from the current result set (lightweight, no extra endpoint).
  const sources = useMemo(
    () => Array.from(new Set(results.map((r) => r.source).filter(Boolean))).sort(),
    [results],
  )
  const channels = useMemo(
    () => Array.from(new Set(results.map((r) => r.channel).filter(Boolean))).sort(),
    [results],
  )

  const openAt = useCallback(
    (id: string, start_ms: number) => {
      onOpen(id, Math.max(0, start_ms / 1000 - RECALL_S), resp?.query_hash)
    },
    [onOpen, resp?.query_hash],
  )

  const hasQuery = q.trim().length > 0
  const indexPartial = resp && resp.total > resp.indexed

  return (
    <TooltipProvider>
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 sm:p-6 lg:p-8">
        {/* Query bar */}
        <div className="relative">
          <SearchIcon className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Rechercher dans tout ce que vous avez archivé…"
            aria-label="Rechercher"
            className="h-11 pl-10 text-base"
          />
        </div>

        {/* Response meta — speed is a product argument, so we surface it. */}
        {hasQuery && resp && !loading && (
          <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
            <span className="font-medium text-foreground tabular-nums">{resp.count}</span>{" "}
            {resp.count === 1 ? "résultat" : "résultats"}
            <span className="mx-1.5">·</span>
            <span className="tabular-nums">{resp.took_ms} ms</span>
            {resp.semantic ? null : (
              <span className="ml-2 text-xs">(recherche lexicale seule)</span>
            )}
          </p>
        )}

        <div className="flex flex-col gap-4 lg:flex-row">
          {/* Filters */}
          <aside className="flex shrink-0 flex-col gap-3 lg:w-52">
            <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <SlidersHorizontalIcon className="size-3.5" /> Filtres
            </div>
            <FacetSelect
              label="Source"
              value={source}
              onChange={setSource}
              options={sources}
              allLabel="Toutes les sources"
            />
            <FacetSelect
              label="Chaîne"
              value={channel}
              onChange={setChannel}
              options={channels}
              allLabel="Toutes les chaînes"
            />
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Période</label>
              <Select value={period || "all"} onValueChange={(v) => setPeriod((v === "all" ? "" : v) as Period)}>
                <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Toute période</SelectItem>
                  <SelectItem value="week">7 derniers jours</SelectItem>
                  <SelectItem value="month">30 derniers jours</SelectItem>
                  <SelectItem value="quarter">3 derniers mois</SelectItem>
                  <SelectItem value="year">12 derniers mois</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Durée</label>
              <Select value={dur || "all"} onValueChange={(v) => setDur((v === "all" ? "" : v) as Dur)}>
                <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Toute durée</SelectItem>
                  <SelectItem value="short">Court (&lt; 4 min)</SelectItem>
                  <SelectItem value="medium">Moyen (4–20 min)</SelectItem>
                  <SelectItem value="long">Long (&gt; 20 min)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </aside>

          {/* Results */}
          <div className="min-w-0 flex-1">
            {!hasQuery ? (
              <InlineFeedback
                state="empty"
                icon={SearchIcon}
                title="Retrouvez une phrase en quelques secondes"
                description="Tapez des mots entendus dans une vidéo — même approximatifs. La recherche couvre tout ce qui est transcrit et indexé."
              />
            ) : loading && !resp ? (
              <ResultsSkeleton />
            ) : resp && resp.total === 0 ? (
              <InlineFeedback
                state="empty"
                icon={FileTextIcon}
                title="Rien n'est encore interrogeable"
                description="Transcrivez votre bibliothèque pour la rendre interrogeable."
                action={
                  <Button size="sm" onClick={() => onNavigate("settings")}>
                    <FileTextIcon data-icon="inline-start" /> Réglages de transcription
                  </Button>
                }
              />
            ) : results.length === 0 ? (
              <InlineFeedback
                state="empty"
                icon={SearchIcon}
                title="Aucun passage trouvé"
                description={`La recherche couvre les contenus transcrits et indexés (${resp?.indexed}/${resp?.total}).`}
                action={
                  indexPartial ? (
                    <Button size="sm" variant="outline" onClick={() => onNavigate("settings")}>
                      Transcrire les contenus manquants
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <div className="flex flex-col gap-3">
                {results.map((r) => (
                  <ResultCard key={r.id} result={r} query={q.trim()} onSeek={openAt} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </TooltipProvider>
  )
}

function FacetSelect({
  label,
  value,
  onChange,
  options,
  allLabel,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: string[]
  allLabel: string
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-muted-foreground">{label}</label>
      <Select value={value || "all"} onValueChange={(v) => onChange(v === "all" ? "" : v)}>
        <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{allLabel}</SelectItem>
          {options.map((o) => (
            <SelectItem key={o} value={o}>{o}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function ResultCard({
  result,
  query,
  onSeek,
}: {
  result: LibrarySearchResult
  query: string
  onSeek: (id: string, start_ms: number) => void
}) {
  const [extra, setExtra] = useState<SearchPassage[] | null>(null)
  const [expanding, setExpanding] = useState(false)
  const shown = result.passages
  const remaining = (result.passage_total ?? shown.length) - shown.length

  async function expand() {
    if (extra) {
      setExtra(null)
      return
    }
    setExpanding(true)
    try {
      // Passage pagination: fetch the full per-content passage list on demand.
      const r = await backend.searchLibrary(query, result.id, 1, { passage_limit: 20 })
      const all = r.results[0]?.passages ?? []
      const seen = new Set(shown.map((p) => Math.floor(p.start_ms / 1000)))
      setExtra(all.filter((p) => !seen.has(Math.floor(p.start_ms / 1000))))
    } catch {
      setExtra([])
    } finally {
      setExpanding(false)
    }
  }

  const passages = extra ? [...shown, ...extra] : shown

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-3 sm:flex-row">
      {/* Content identity */}
      <button
        type="button"
        onClick={() => onSeek(result.id, passages[0]?.start_ms ?? 0)}
        className="flex shrink-0 gap-3 text-left sm:w-56 sm:flex-col"
      >
        <div className="relative aspect-video w-28 shrink-0 overflow-hidden rounded-lg bg-muted sm:w-full">
          {result.thumbnail_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={result.thumbnail_url} alt="" className="size-full object-cover" />
          ) : (
            <div className="flex size-full items-center justify-center text-muted-foreground">
              <PlayIcon className="size-6" />
            </div>
          )}
        </div>
        <div className="min-w-0">
          <p className="line-clamp-2 text-sm font-medium leading-snug">{result.title}</p>
          <div className="mt-1 flex items-center gap-2">
            <SourceBadge source={result.source} className="text-[10px]" />
            <span className="truncate text-xs text-muted-foreground">{result.channel}</span>
          </div>
        </div>
      </button>

      {/* Passages */}
      <div className="min-w-0 flex-1">
        <ul className="flex flex-col divide-y divide-border/60">
          {passages.map((p, i) => (
            <li key={`${p.start_ms}-${i}`}>
              <button
                type="button"
                onClick={() => onSeek(result.id, p.start_ms)}
                className="group flex w-full items-start gap-2.5 py-2 text-left"
              >
                <span className="mt-0.5 shrink-0 rounded bg-primary/10 px-1.5 py-0.5 font-mono text-xs tabular-nums text-primary group-hover:bg-primary/20">
                  {fmtMs(p.start_ms)}
                </span>
                <span className="min-w-0 text-sm text-foreground/90">
                  <HighlightedText text={p.text} highlights={p.highlights} />
                  {p.match_type === "semantic" && (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Badge
                            variant="outline"
                            className="ml-1.5 gap-1 border-info/30 bg-info/10 align-[1px] text-[10px] text-info"
                          >
                            <SparklesIcon className="size-2.5" /> correspondance de sens
                          </Badge>
                        }
                      />
                      <TooltipContent>
                        Trouvé par similarité, pas par mot exact.
                      </TooltipContent>
                    </Tooltip>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>

        {remaining > 0 && (
          <button
            type="button"
            onClick={expand}
            disabled={expanding}
            className="mt-1 text-xs font-medium text-primary hover:underline disabled:opacity-60"
          >
            {expanding
              ? "Chargement…"
              : extra
                ? "Réduire les passages"
                : `Voir les ${remaining} autre${remaining > 1 ? "s" : ""} passage${remaining > 1 ? "s" : ""}`}
          </button>
        )}
      </div>
    </div>
  )
}

function ResultsSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex gap-3 rounded-xl border border-border bg-card p-3">
          <Skeleton className="aspect-video w-28 shrink-0 rounded-lg sm:w-56" />
          <div className="flex flex-1 flex-col gap-2 py-1">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="mt-2 h-3 w-full" />
            <Skeleton className="h-3 w-5/6" />
          </div>
        </div>
      ))}
    </div>
  )
}
