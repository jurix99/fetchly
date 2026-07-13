"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  BookmarkIcon,
  CheckIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  PlayIcon,
  SparklesIcon,
} from "lucide-react"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import { backend, type DigestItem, type DigestResponse } from "@/lib/backend"
import { useStore } from "@/components/store-provider"
import { Button } from "@/components/ui/button"

const RECALL_S = 2

function fmtDur(sec: number | null | undefined): string {
  if (!sec) return ""
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h}:${String(m).padStart(2, "0")}` : `${m} min`
}

function fmtTotal(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return h ? `${h} h ${String(m).padStart(2, "0")}` : `${m} min`
}

function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

/** "Aujourd'hui / Hier / 12 juil." from a YYYY-MM-DD day key. */
function dayLabel(dateStr: string): string {
  const today = new Date()
  const y = new Date(today)
  y.setDate(today.getDate() - 1)
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  if (dateStr === iso(today)) return "Aujourd'hui"
  if (dateStr === iso(y)) return "Hier"
  try {
    return new Date(dateStr + "T00:00:00").toLocaleDateString("fr-FR", { day: "numeric", month: "long" })
  } catch {
    return dateStr
  }
}

export function DigestSection({ onOpen }: { onOpen: (id: string, startAt?: number) => void }) {
  const { refreshDigestCount } = useStore()
  const [data, setData] = useState<DigestResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [dismissed, setDismissed] = useState(false)
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [later, setLater] = useState<Record<string, boolean>>({})
  const [wlOpen, setWlOpen] = useState(false)
  const seenTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingAll = useRef(false)

  useEffect(() => {
    let alive = true
    backend
      .digest()
      .then((d) => alive && setData(d))
      .catch(() => alive && setData(null))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [])

  const hide = useCallback((id: string) => {
    setHidden((s) => new Set(s).add(id))
  }, [])

  const markSeen = useCallback(
    (id: string) => {
      hide(id)
      backend.digestSeen({ content_ids: [id] }).then(refreshDigestCount).catch(() => {})
    },
    [hide, refreshDigestCount],
  )

  /** Opening also marks seen server-side (detail route) — reflect it locally. */
  const openItem = useCallback(
    (id: string, startAt?: number) => {
      hide(id)
      onOpen(id, startAt)
      refreshDigestCount()
    },
    [hide, onOpen, refreshDigestCount],
  )

  const toggleLater = useCallback(
    (item: DigestItem) => {
      const cur = later[item.id] ?? item.watch_later
      const next = !cur
      setLater((s) => ({ ...s, [item.id]: next }))
      backend.setWatchLater(item.id, next).catch(() => {})
      toast[next ? "success" : "info"](next ? "Ajouté à « À regarder plus tard »" : "Retiré de la liste")
    },
    [later],
  )

  /** Mark-all-seen: optimistic hide + 5 s undo toast; the server call is deferred
   *  so "Annuler" simply cancels it (no server-side undo needed). */
  const markAllSeen = useCallback(() => {
    setDismissed(true)
    pendingAll.current = true
    if (seenTimer.current) clearTimeout(seenTimer.current)
    seenTimer.current = setTimeout(() => {
      pendingAll.current = false
      backend.digestSeen({ all: true }).then(refreshDigestCount).catch(() => {})
      seenTimer.current = null
    }, 5000)
    toast("Digest marqué comme vu", {
      duration: 5000,
      action: {
        label: "Annuler",
        onClick: () => {
          if (seenTimer.current) clearTimeout(seenTimer.current)
          seenTimer.current = null
          pendingAll.current = false
          setDismissed(false)
        },
      },
    })
  }, [refreshDigestCount])

  // On unmount, flush a still-pending "mark all seen" so navigating away within
  // the undo window doesn't silently drop it (only Annuler cancels it).
  useEffect(
    () => () => {
      if (seenTimer.current) clearTimeout(seenTimer.current)
      if (pendingAll.current) backend.digestSeen({ all: true }).catch(() => {})
    },
    [],
  )

  if (loading || !data) return null // stay calm during load; other sections render

  // Filter out individually-hidden items and recompute what's left.
  const days = data.new
    .map((day) => ({
      ...day,
      subscriptions: day.subscriptions
        .map((sub) => ({ ...sub, items: sub.items.filter((it) => !hidden.has(it.id)) }))
        .filter((sub) => sub.items.length > 0),
    }))
    .filter((day) => day.subscriptions.length > 0)

  const remaining = days.reduce((n, d) => n + d.subscriptions.reduce((m, s) => m + s.items.length, 0), 0)
  const showNew = !dismissed && remaining > 0
  const echoes = dismissed ? [] : data.echoes
  const watchLater = data.watch_later.filter((it) => (later[it.id] ?? it.watch_later))

  return (
    <div className="flex flex-col gap-4">
      {/* Header + accroche */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="text-sm font-semibold">Depuis votre dernière visite</h2>
        {showNew ? (
          <>
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground tabular-nums">{data.stats.count}</span>{" "}
              nouveauté{data.stats.count > 1 ? "s" : ""} ·{" "}
              <span className="tabular-nums">{fmtTotal(data.stats.total_duration_s)}</span>
              {data.stats.watches_count > 0 && (
                <>
                  {" "}· <span className="tabular-nums">{data.stats.watches_count}</span> chaîne
                  {data.stats.watches_count > 1 ? "s" : ""}
                </>
              )}
            </p>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={markAllSeen}>
              <CheckIcon data-icon="inline-start" /> Tout marquer comme vu
            </Button>
          </>
        ) : (
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <CheckIcon className="size-4 text-success" /> Vous êtes à jour
          </p>
        )}
      </div>

      {/* New, grouped by day → subscription */}
      {showNew &&
        days.map((day) => (
          <div key={day.date} className="flex flex-col gap-2">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {dayLabel(day.date)}
            </p>
            {day.subscriptions.map((sub) => (
              <SubscriptionGroup
                key={(sub.watch_id ?? "manual") + day.date}
                name={sub.name}
                avatar={sub.avatar}
                count={sub.items.length}
                items={sub.items}
                later={later}
                onOpen={openItem}
                onSeen={markSeen}
                onLater={toggleLater}
              />
            ))}
          </div>
        ))}

      {/* Echoes — the memory resurfacing (discreet, max 3) */}
      {echoes.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <SparklesIcon className="size-3.5 text-primary" /> En écho à vos archives
          </h3>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {echoes.map((e, i) => (
              <div key={i} className="flex flex-col gap-2 rounded-xl border border-border bg-muted/30 p-3">
                <p className="line-clamp-1 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{e.new.title}</span> fait écho à un contenu plus ancien
                </p>
                <button
                  type="button"
                  onClick={() => openItem(e.new.id, Math.max(0, e.pair.a_start_ms / 1000 - RECALL_S))}
                  className="flex flex-col gap-0.5 rounded-lg border border-border bg-card p-2 text-left transition-colors hover:border-primary/40"
                >
                  <span className="flex items-center gap-1.5 text-xs font-medium text-primary">
                    <PlayIcon className="size-3" /> Ici · {fmtMs(e.pair.a_start_ms)}
                  </span>
                  <span className="line-clamp-1 text-[11px] text-foreground/80">{e.pair.a_text}</span>
                </button>
                <button
                  type="button"
                  onClick={() => onOpen(e.old.id, Math.max(0, e.pair.b_start_ms / 1000 - RECALL_S))}
                  className="flex flex-col gap-0.5 rounded-lg border border-border bg-card p-2 text-left transition-colors hover:border-primary/40"
                >
                  <span className="flex items-center gap-1.5 text-xs font-medium text-primary">
                    <ExternalLinkIcon className="size-3" /> Là-bas · {fmtMs(e.pair.b_start_ms)}
                  </span>
                  <span className="line-clamp-1 text-[11px] text-foreground/80">
                    {e.old.title} — {e.pair.b_text}
                  </span>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Watch later (collapsed) */}
      {watchLater.length > 0 && (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setWlOpen((o) => !o)}
            className="flex items-center gap-2 text-sm font-semibold"
          >
            <ChevronDownIcon className={cn("size-4 transition-transform", !wlOpen && "-rotate-90")} />
            À regarder plus tard
            <span className="rounded bg-muted px-1.5 text-xs font-normal text-muted-foreground">
              {watchLater.length}
            </span>
          </button>
          {wlOpen && (
            <div className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-lg border border-border">
              {watchLater.map((it) => (
                <DigestRow
                  key={it.id}
                  item={it}
                  later={later}
                  onOpen={openItem}
                  onSeen={markSeen}
                  onLater={toggleLater}
                  compact
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function SubscriptionGroup({
  name,
  avatar,
  count,
  items,
  later,
  onOpen,
  onSeen,
  onLater,
}: {
  name: string
  avatar: string
  count: number
  items: DigestItem[]
  later: Record<string, boolean>
  onOpen: (id: string, startAt?: number) => void
  onSeen: (id: string) => void
  onLater: (item: DigestItem) => void
}) {
  const [open, setOpen] = useState(true)
  return (
    <div className="rounded-xl border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 p-2.5 text-left"
      >
        <ChevronDownIcon className={cn("size-4 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")} />
        {avatar ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={avatar} alt="" className="size-6 shrink-0 rounded-full object-cover" />
        ) : (
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground">
            {name.slice(0, 1).toUpperCase()}
          </span>
        )}
        <span className="truncate text-sm font-medium">{name}</span>
        <span className="rounded bg-muted px-1.5 text-xs text-muted-foreground">{count}</span>
      </button>
      {open && (
        <div className="flex flex-col divide-y divide-border/60 border-t border-border">
          {items.map((it) => (
            <DigestRow key={it.id} item={it} later={later} onOpen={onOpen} onSeen={onSeen} onLater={onLater} />
          ))}
        </div>
      )}
    </div>
  )
}

function DigestRow({
  item,
  later,
  onOpen,
  onSeen,
  onLater,
  compact,
}: {
  item: DigestItem
  later: Record<string, boolean>
  onOpen: (id: string, startAt?: number) => void
  onSeen: (id: string) => void
  onLater: (item: DigestItem) => void
  compact?: boolean
}) {
  const saved = later[item.id] ?? item.watch_later
  return (
    <div className="group flex items-start gap-3 p-2.5">
      <button
        type="button"
        onClick={() => onOpen(item.id)}
        className="relative aspect-video w-24 shrink-0 overflow-hidden rounded-md bg-muted"
        aria-label={`Ouvrir ${item.title}`}
      >
        {item.thumbnail_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.thumbnail_url} alt="" className="size-full object-cover" />
        ) : (
          <span className="flex size-full items-center justify-center text-muted-foreground">
            <PlayIcon className="size-5" />
          </span>
        )}
        {item.duration_seconds ? (
          <span className="absolute bottom-1 right-1 rounded bg-black/80 px-1 text-[10px] text-white tabular-nums">
            {fmtDur(item.duration_seconds)}
          </span>
        ) : null}
      </button>

      <div className="min-w-0 flex-1">
        <button type="button" onClick={() => onOpen(item.id)} className="block w-full text-left">
          <p className="line-clamp-1 text-sm font-medium">{item.title}</p>
        </button>
        {item.summary_short && !compact && (
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{item.summary_short}</p>
        )}
      </div>

      {/* Actions — always visible on touch, emphasised on hover on desktop. */}
      <div className="flex shrink-0 items-center gap-0.5 opacity-100 transition-opacity md:opacity-60 md:group-hover:opacity-100">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={saved ? "Retirer de plus tard" : "Regarder plus tard"}
          onClick={() => onLater(item)}
        >
          <BookmarkIcon className={cn("size-4", saved && "fill-primary text-primary")} />
        </Button>
        {!compact && (
          <Button size="icon-sm" variant="ghost" aria-label="Marquer comme vu" onClick={() => onSeen(item.id)}>
            <CheckIcon className="size-4" />
          </Button>
        )}
      </div>
    </div>
  )
}
