"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ActivityIcon,
  CornerDownLeftIcon,
  DownloadIcon,
  LibraryIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  RadioTowerIcon,
  SearchIcon,
  SettingsIcon,
  SparklesIcon,
  StickyNoteIcon,
  SunriseIcon,
} from "lucide-react"

import { cn } from "@/lib/utils"
import {
  backend,
  type LibrarySearchResponse,
  type LibrarySearchResult,
  type SearchPassage,
} from "@/lib/backend"
import type { View } from "@/components/app-shell"
import { useStore } from "@/components/store-provider"
import { HighlightedText } from "@/components/highlighted-text"
import { Dialog, DialogContent } from "@/components/ui/dialog"

const RECALL_S = 2

function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

function bestPassage(r: LibrarySearchResult): SearchPassage | undefined {
  return r.passages?.[0]
}

interface Command {
  id: string
  label: string
  icon: typeof SearchIcon
  run: () => void
  keywords: string
}

/** Omnipresent palette (Cmd/Ctrl+K): the app's navigation + capture organ, not
 *  just search. A pasted URL turns into "Capturer cette URL"; typed text runs the
 *  live transcript search; and navigation/actions are always one Enter away. */
export function CommandPalette({
  open,
  onOpenChange,
  onOpen,
  onSeeAll,
  onCapture,
  onNavigate,
  onOpenTray,
  onAddSource,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpen: (id: string, startAt: number, queryHash?: string) => void
  onSeeAll: (query: string) => void
  onCapture: (url: string) => void
  onNavigate: (v: View) => void
  onOpenTray: () => void
  onAddSource: (url?: string) => void
}) {
  const { pauseAll } = useStore()
  const [q, setQ] = useState("")
  const [resp, setResp] = useState<LibrarySearchResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const query = q.trim()
  const isUrl = /^https?:\/\/\S+$/i.test(query)
  const results = isUrl ? [] : resp?.results ?? []

  const allCommands: Command[] = useMemo(
    () => [
      { id: "nav-today", label: "Aller à : Aujourd'hui", icon: SunriseIcon, run: () => onNavigate("today"), keywords: "accueil aujourdhui home digest" },
      { id: "nav-memory", label: "Aller à : Mémoire", icon: LibraryIcon, run: () => onNavigate("memory"), keywords: "bibliotheque memoire library contenus" },
      { id: "nav-sources", label: "Aller à : Sources", icon: RadioTowerIcon, run: () => onNavigate("sources"), keywords: "sources abonnements chaines explorer" },
      { id: "nav-settings", label: "Aller à : Réglages", icon: SettingsIcon, run: () => onNavigate("settings"), keywords: "reglages settings parametres" },
      { id: "add-source", label: "Ajouter une source", icon: PlusIcon, run: () => onAddSource(), keywords: "ajouter source capturer chaine playlist" },
      { id: "open-tray", label: "Ouvrir l'activité", icon: ActivityIcon, run: onOpenTray, keywords: "activite telechargements files jobs" },
      { id: "pause-all", label: "Tout suspendre", icon: PauseIcon, run: pauseAll, keywords: "pause suspendre stop" },
    ],
    [onNavigate, onAddSource, onOpenTray, pauseAll],
  )

  const commands = useMemo(() => {
    if (isUrl) return []
    if (!query) return allCommands
    const needle = query.toLowerCase()
    return allCommands.filter((c) => c.label.toLowerCase().includes(needle) || c.keywords.includes(needle))
  }, [allCommands, query, isUrl])

  // Combined, keyboard-navigable rows: [capture?] + commands + search results.
  type Row =
    | { kind: "capture"; url: string }
    | { kind: "command"; cmd: Command }
    | { kind: "result"; result: LibrarySearchResult }
  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    if (isUrl) out.push({ kind: "capture", url: query })
    for (const cmd of commands) out.push({ kind: "command", cmd })
    for (const result of results) out.push({ kind: "result", result })
    return out
  }, [isUrl, query, commands, results])

  // Live search: debounce 250 ms, cancel stale. Skipped when the input is a URL.
  useEffect(() => {
    if (!query || isUrl) {
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
        /* aborted or failed */
      } finally {
        if (!ctrl.signal.aborted) setLoading(false)
      }
    }, 250)
    return () => clearTimeout(t)
  }, [query, isUrl])

  useEffect(() => {
    if (!open) {
      setQ("")
      setResp(null)
      setActive(0)
      abortRef.current?.abort()
      return
    }
    const t = setTimeout(() => inputRef.current?.focus(), 30)
    return () => clearTimeout(t)
  }, [open])

  useEffect(() => {
    setActive((i) => Math.min(i, Math.max(0, rows.length - 1)))
  }, [rows.length])

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
    el?.scrollIntoView({ block: "nearest" })
  }, [active])

  const runRow = useCallback(
    (row: Row) => {
      if (row.kind === "capture") {
        onCapture(row.url)
      } else if (row.kind === "command") {
        row.cmd.run()
      } else {
        const p = bestPassage(row.result)
        const startAt = p ? Math.max(0, p.start_ms / 1000 - RECALL_S) : 0
        onOpen(row.result.id, startAt, resp?.query_hash)
      }
      onOpenChange(false)
    },
    [onCapture, onOpen, onOpenChange, resp?.query_hash],
  )

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, rows.length - 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === "Enter") {
      e.preventDefault()
      const row = rows[active]
      if (row) runRow(row)
      else if (query && !isUrl) {
        onSeeAll(query)
        onOpenChange(false)
      }
    }
  }

  const hasQuery = query.length > 0
  const emptyIndex = !isUrl && resp && resp.total === 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="top-[12%] max-w-xl translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl"
        aria-label="Recherche et commandes"
      >
        <div className="flex items-center gap-2 border-b border-border px-3">
          <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Rechercher un passage, coller une URL, ou naviguer…"
            aria-label="Rechercher ou commander"
            role="combobox"
            aria-expanded={rows.length > 0}
            aria-controls="cmdk-list"
            className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          {loading && <span className="size-2 shrink-0 animate-pulse rounded-full bg-primary" />}
        </div>

        <div ref={listRef} id="cmdk-list" role="listbox" className="max-h-[min(60vh,26rem)] overflow-y-auto p-1.5">
          {rows.length === 0 ? (
            emptyIndex ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                Rien n&apos;est encore indexé. Transcrivez votre bibliothèque pour la rendre
                interrogeable.
              </p>
            ) : hasQuery && !loading ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                Aucun résultat pour «&nbsp;{query}&nbsp;».
              </p>
            ) : (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                Tapez pour retrouver une phrase — ou collez une URL pour la capturer.
              </p>
            )
          ) : (
            rows.map((row, i) => (
              <RowItem
                key={rowKey(row, i)}
                row={row}
                idx={i}
                active={i === active}
                onHover={() => setActive(i)}
                onClick={() => runRow(row)}
              />
            ))
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
          {hasQuery && !isUrl && results.length > 0 ? (
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
            <span>valider</span>
            <Kbd>esc</Kbd>
            <span>fermer</span>
          </span>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function rowKey(row: { kind: string }, i: number): string {
  return `${row.kind}-${i}`
}

function RowItem({
  row,
  idx,
  active,
  onHover,
  onClick,
}: {
  row:
    | { kind: "capture"; url: string }
    | { kind: "command"; cmd: Command }
    | { kind: "result"; result: LibrarySearchResult }
  idx: number
  active: boolean
  onHover: () => void
  onClick: () => void
}) {
  const base = cn(
    "flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left",
    active ? "bg-accent" : "hover:bg-muted/60",
  )
  if (row.kind === "capture") {
    return (
      <button type="button" data-idx={idx} role="option" aria-selected={active} onMouseMove={onHover} onClick={onClick} className={base}>
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
          <DownloadIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Capturer cette URL</p>
          <p className="line-clamp-1 text-xs text-muted-foreground">{row.url}</p>
        </div>
        {active && <CornerDownLeftIcon className="size-3.5 shrink-0 text-muted-foreground" />}
      </button>
    )
  }
  if (row.kind === "command") {
    const Icon = row.cmd.icon
    return (
      <button type="button" data-idx={idx} role="option" aria-selected={active} onMouseMove={onHover} onClick={onClick} className={base}>
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <Icon className="size-4" />
        </span>
        <p className="flex-1 text-sm font-medium">{row.cmd.label}</p>
        {active && <CornerDownLeftIcon className="size-3.5 shrink-0 text-muted-foreground" />}
      </button>
    )
  }
  const r = row.result
  const p = bestPassage(r)
  return (
    <button
      type="button"
      data-idx={idx}
      role="option"
      aria-selected={active}
      onMouseMove={onHover}
      onClick={onClick}
      className={cn("flex w-full items-start gap-3 rounded-lg px-2.5 py-2 text-left", active ? "bg-accent" : "hover:bg-muted/60")}
    >
      <div className="relative aspect-video w-16 shrink-0 overflow-hidden rounded bg-muted">
        {r.thumbnail_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={r.thumbnail_url} alt="" className="size-full object-cover" />
        ) : (
          <div className="flex size-full items-center justify-center text-muted-foreground">
            <PlayIcon className="size-4" />
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="line-clamp-1 text-sm font-medium">{r.title}</p>
        <p className="line-clamp-1 text-xs text-muted-foreground">{r.channel}</p>
        {p && (
          <p className="mt-0.5 line-clamp-1 text-xs text-foreground/80">
            <span className="mr-1.5 font-mono tabular-nums text-primary">{fmtMs(p.start_ms)}</span>
            {p.match_type === "semantic" ? (
              <SparklesIcon className="mr-1 inline size-3 align-[-1px] text-info" />
            ) : p.match_type === "note" ? (
              <StickyNoteIcon className="mr-1 inline size-3 align-[-1px] text-warning" />
            ) : null}
            <HighlightedText text={p.text} highlights={p.highlights} />
          </p>
        )}
      </div>
      {active && <CornerDownLeftIcon className="mt-1 size-3.5 shrink-0 text-muted-foreground" />}
    </button>
  )
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-background px-1 font-sans text-[10px] font-medium text-muted-foreground">
      {children}
    </kbd>
  )
}
