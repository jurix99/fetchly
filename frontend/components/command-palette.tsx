"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  CornerDownLeftIcon,
  PlayIcon,
  SearchIcon,
  SparklesIcon,
} from "lucide-react"

import { cn } from "@/lib/utils"
import {
  backend,
  type LibrarySearchResponse,
  type LibrarySearchResult,
  type SearchPassage,
} from "@/lib/backend"
import { HighlightedText } from "@/components/highlighted-text"
import { Dialog, DialogContent } from "@/components/ui/dialog"

/** 2 s recall so the phrase is heard with a little run-up (north-star gesture). */
const RECALL_S = 2

function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

function bestPassage(r: LibrarySearchResult): SearchPassage | undefined {
  return r.passages?.[0]
}

/** Omnipresent search palette (Cmd/Ctrl+K). Live results with 250 ms debounce
 *  and stale-request cancellation; full keyboard control; Enter opens a result
 *  at the exact second. Lazy-loaded — never mounted until first opened. */
export function CommandPalette({
  open,
  onOpenChange,
  onOpen,
  onSeeAll,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpen: (id: string, startAt: number, queryHash?: string) => void
  onSeeAll: (query: string) => void
}) {
  const [q, setQ] = useState("")
  const [resp, setResp] = useState<LibrarySearchResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const results = resp?.results ?? []

  // Live search: debounce 250 ms, cancel any in-flight (stale) request.
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
        const r = await backend.searchLibrary(query, "all", 8, undefined, ctrl.signal)
        if (!ctrl.signal.aborted) {
          setResp(r)
          setActive(0)
        }
      } catch {
        /* aborted or failed — keep prior results */
      } finally {
        if (!ctrl.signal.aborted) setLoading(false)
      }
    }, 250)
    return () => clearTimeout(t)
  }, [q])

  // Reset transient state whenever the palette closes; focus the input on open.
  useEffect(() => {
    if (!open) {
      setQ("")
      setResp(null)
      setActive(0)
      abortRef.current?.abort()
      return
    }
    // Focus after the dialog has mounted/animated so typing starts immediately.
    const t = setTimeout(() => inputRef.current?.focus(), 30)
    return () => clearTimeout(t)
  }, [open])

  // Keep the active row scrolled into view during keyboard navigation.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
    el?.scrollIntoView({ block: "nearest" })
  }, [active])

  const openResult = useCallback(
    (r: LibrarySearchResult) => {
      const p = bestPassage(r)
      const startAt = p ? Math.max(0, p.start_ms / 1000 - RECALL_S) : 0
      onOpen(r.id, startAt, resp?.query_hash)
      onOpenChange(false)
    },
    [onOpen, onOpenChange, resp?.query_hash],
  )

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === "Enter") {
      e.preventDefault()
      const r = results[active]
      if (r) openResult(r)
      else if (q.trim()) {
        onSeeAll(q.trim())
        onOpenChange(false)
      }
    }
    // Esc is handled by the Dialog (closes + restores focus to the opener).
  }

  const query = q.trim()
  const hasQuery = query.length > 0
  const emptyIndex = resp && resp.total === 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="top-[12%] max-w-xl translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl"
        aria-label="Recherche globale"
      >
        {/* Search input */}
        <div className="flex items-center gap-2 border-b border-border px-3">
          <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Rechercher dans tout ce que vous avez archivé…"
            aria-label="Rechercher"
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls="cmdk-list"
            aria-activedescendant={results[active] ? `cmdk-opt-${active}` : undefined}
            className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          {loading && <span className="size-2 shrink-0 animate-pulse rounded-full bg-primary" />}
        </div>

        {/* Results */}
        <div
          ref={listRef}
          id="cmdk-list"
          role="listbox"
          className="max-h-[min(60vh,26rem)] overflow-y-auto p-1.5"
        >
          {!hasQuery ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              Tapez pour retrouver une phrase entendue — titre, sujet, ou mots exacts.
            </p>
          ) : emptyIndex ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              Rien n&apos;est encore indexé. Transcrivez votre bibliothèque pour la rendre
              interrogeable.
            </p>
          ) : results.length === 0 && !loading ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              Aucun passage pour «&nbsp;{query}&nbsp;».
            </p>
          ) : (
            results.map((r, i) => {
              const p = bestPassage(r)
              return (
                <button
                  key={r.id}
                  type="button"
                  id={`cmdk-opt-${i}`}
                  data-idx={i}
                  role="option"
                  aria-selected={i === active}
                  onMouseMove={() => setActive(i)}
                  onClick={() => openResult(r)}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-lg px-2.5 py-2 text-left",
                    i === active ? "bg-accent" : "hover:bg-muted/60",
                  )}
                >
                  <Thumb result={r} />
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-1 text-sm font-medium">{r.title}</p>
                    <p className="line-clamp-1 text-xs text-muted-foreground">{r.channel}</p>
                    {p && (
                      <p className="mt-0.5 line-clamp-1 text-xs text-foreground/80">
                        <span className="mr-1.5 font-mono tabular-nums text-primary">
                          {fmtMs(p.start_ms)}
                        </span>
                        {p.match_type === "semantic" ? (
                          <SparklesIcon className="mr-1 inline size-3 text-info align-[-1px]" />
                        ) : null}
                        <HighlightedText text={p.text} highlights={p.highlights} />
                      </p>
                    )}
                  </div>
                  {i === active && (
                    <CornerDownLeftIcon className="mt-1 size-3.5 shrink-0 text-muted-foreground" />
                  )}
                </button>
              )
            })
          )}
        </div>

        {/* Footer: see-all + keyboard legend */}
        <div className="flex items-center justify-between gap-2 border-t border-border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
          {hasQuery && results.length > 0 ? (
            <button
              type="button"
              onClick={() => {
                onSeeAll(query)
                onOpenChange(false)
              }}
              className="font-medium text-primary hover:underline"
            >
              Voir tous les résultats ({resp?.count ?? results.length})
              {resp ? ` · ${resp.took_ms} ms` : ""}
            </button>
          ) : (
            <span />
          )}
          <span className="flex items-center gap-2">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            <span>naviguer</span>
            <Kbd>↵</Kbd>
            <span>ouvrir</span>
            <Kbd>esc</Kbd>
            <span>fermer</span>
          </span>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Thumb({ result }: { result: LibrarySearchResult }) {
  return (
    <div className="relative aspect-video w-16 shrink-0 overflow-hidden rounded bg-muted">
      {result.thumbnail_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={result.thumbnail_url} alt="" className="size-full object-cover" />
      ) : (
        <div className="flex size-full items-center justify-center text-muted-foreground">
          <PlayIcon className="size-4" />
        </div>
      )}
    </div>
  )
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-background px-1 font-sans text-[10px] font-medium text-muted-foreground">
      {children}
    </kbd>
  )
}
