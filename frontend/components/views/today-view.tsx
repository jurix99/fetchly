"use client"

import { useEffect, useState } from "react"
import { PlayIcon, PlusIcon, SparklesIcon } from "lucide-react"

import { backend, type Content } from "@/lib/backend"
import { getRecentlyPlayed, type PlaybackEntry } from "@/lib/playback"
import type { View } from "@/components/app-shell"
import type { Celebration } from "@/components/app-shell"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { DigestSection } from "@/components/views/digest-section"
import { AhaCallout } from "@/components/aha-callout"

function fmtDuration(sec: number | null): string {
  if (!sec) return ""
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  return h
    ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`
    : `${m}:${String(r).padStart(2, "0")}`
}

/** Aujourd'hui — the home ("/"). What's new since the last visit (digest, echoes,
 *  watch-later), Reprendre, recent additions; and the one-time "aha" callout. */
export function TodayView({
  onOpen,
  onNavigate,
  onAddSource,
  celebration,
  onDismissCelebration,
  onOpenPalette,
}: {
  onOpen: (id: string, startAt?: number) => void
  onNavigate: (v: View) => void
  onAddSource: (url?: string) => void
  celebration: Celebration
  onDismissCelebration: () => void
  onOpenPalette: () => void
}) {
  const [total, setTotal] = useState<number | null>(null)

  useEffect(() => {
    backend
      .library({ limit: 1 })
      .then((p) => setTotal(p.total))
      .catch(() => setTotal(0))
  }, [])

  // First run (nothing archived yet): stage the single gesture — add a source.
  if (total === 0) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col items-center gap-4 p-4 pt-16 text-center sm:p-6">
        <span className="flex size-12 items-center justify-center rounded-2xl bg-primary/15 text-primary">
          <SparklesIcon className="size-6" />
        </span>
        <h2 className="text-2xl font-semibold tracking-tight">Commencez votre mémoire</h2>
        <p className="max-w-md text-balance text-sm text-muted-foreground">
          Ajoutez une source — une chaîne, une playlist ou une simple vidéo. Fetchly la télécharge,
          la transcrit et la rend interrogeable au mot près.
        </p>
        <Button size="lg" onClick={() => onAddSource()}>
          <PlusIcon data-icon="inline-start" /> Ajouter une source
        </Button>
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 sm:p-6 lg:p-8">
      {celebration.show && (
        <AhaCallout onOpenPalette={onOpenPalette} onDismiss={onDismissCelebration} />
      )}
      <DigestSection onOpen={onOpen} />
      <ResumeSection onOpen={onOpen} />
      <RecentSection onOpen={onOpen} />
    </div>
  )
}

/** "Reprendre" — the 3 last-played contents with a remembered position. */
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
        {items.map(({ content, entry }) => {
          const pct = entry.duration > 0 ? Math.min(100, (entry.position / entry.duration) * 100) : 0
          return (
            <button
              key={content.id}
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
        })}
      </div>
    </section>
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
            <div className="relative aspect-video w-full overflow-hidden rounded-md bg-muted">
              {c.thumbnail_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={c.thumbnail_url} alt="" className="size-full object-cover" />
              ) : (
                <div className="flex size-full items-center justify-center text-muted-foreground">
                  <PlayIcon className="size-6" />
                </div>
              )}
            </div>
            <p className="line-clamp-2 text-xs font-medium leading-snug">{c.title}</p>
            <p className="truncate text-[11px] text-muted-foreground">{c.channel}</p>
          </button>
        ))}
      </div>
    </section>
  )
}
