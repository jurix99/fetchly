"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { CopyIcon, PlayIcon, QuoteIcon, SearchIcon, StickyNoteIcon } from "lucide-react"
import { toast } from "sonner"

import { backend, type Highlight } from "@/lib/backend"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { InlineFeedback } from "@/components/inline-feedback"

const PAGE = 50

function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

/** Global "Citations" — every highlight across the library: verbatim, note,
 *  clickable source (→ the exact second) and a copy-citation button. */
export function CitationsView({
  onOpen,
}: {
  onOpen: (id: string, startAt?: number) => void
}) {
  const [items, setItems] = useState<Highlight[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [q, setQ] = useState("")
  const [publicBase, setPublicBase] = useState("")

  useEffect(() => {
    backend
      .highlights(undefined, PAGE, 0, "recent")
      .then((r) => {
        setItems(r.items)
        setTotal(r.total)
      })
      .catch(() => setItems([]))
      .finally(() => setLoading(false))
    backend.digestSettings().then((s) => setPublicBase(s.public_base_url || "")).catch(() => {})
  }, [])

  async function loadMore() {
    setLoadingMore(true)
    try {
      const r = await backend.highlights(undefined, PAGE, items.length, "recent")
      setItems((prev) => [...prev, ...r.items])
      setTotal(r.total)
    } finally {
      setLoadingMore(false)
    }
  }

  const copyCitation = useCallback(
    (h: Highlight) => {
      const sec = Math.floor(h.start_ms / 1000)
      const mmss = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`
      const base = publicBase || (typeof window !== "undefined" ? window.location.origin : "")
      const link = `${base.replace(/\/$/, "")}/?content=${h.content_id}&t=${sec}`
      const citation = `« ${h.text} » — ${h.content_channel ?? ""}, « ${h.content_title ?? ""} » (${mmss})\n${link}`
      navigator.clipboard?.writeText(citation).then(
        () => {
          toast.success("Citation copiée")
          if (!publicBase) toast.info("Configurez l'URL publique (Réglages → Digest) pour des liens partageables.")
        },
        () => toast.error("Copie impossible"),
      )
    },
    [publicBase],
  )

  // Local search over verbatim + note (predictable, client-side).
  const needle = q.trim().toLowerCase()
  const filtered = useMemo(
    () =>
      !needle
        ? items
        : items.filter(
            (h) =>
              h.text.toLowerCase().includes(needle) ||
              (h.note ?? "").toLowerCase().includes(needle) ||
              (h.content_title ?? "").toLowerCase().includes(needle),
          ),
    [items, needle],
  )

  if (loading) {
    return (
      <div className="flex flex-col gap-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-20 w-full rounded-xl" />
        ))}
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <InlineFeedback
        state="empty"
        icon={QuoteIcon}
        title="Aucune citation"
        description="Sélectionnez un passage dans un transcript pour créer votre première citation."
      />
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="relative">
        <SearchIcon className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Rechercher dans vos citations et notes…"
          className="pl-8"
          aria-label="Rechercher dans les citations"
        />
      </div>

      <div className="flex flex-col gap-3">
        {filtered.map((h) => (
          <div key={h.id} className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3">
            {h.note && (
              <p className="flex items-start gap-1.5 text-sm font-medium">
                <StickyNoteIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
                {h.note}
              </p>
            )}
            <p className="border-l-2 border-warning/50 pl-2.5 text-sm italic text-foreground/90">
              « {h.text} »
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => onOpen(h.content_id, Math.max(0, h.start_ms / 1000 - 2))}
                className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs text-muted-foreground hover:text-foreground"
              >
                {h.content_thumbnail_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={h.content_thumbnail_url} alt="" className="h-8 w-14 shrink-0 rounded object-cover" />
                ) : (
                  <span className="flex h-8 w-14 shrink-0 items-center justify-center rounded bg-muted">
                    <PlayIcon className="size-4" />
                  </span>
                )}
                <span className="min-w-0">
                  <span className="line-clamp-1 font-medium text-foreground">{h.content_title}</span>
                  <span className="font-mono tabular-nums text-primary">{fmtMs(h.start_ms)}</span>
                  {h.content_channel ? ` · ${h.content_channel}` : ""}
                </span>
              </button>
              <Button size="sm" variant="ghost" onClick={() => copyCitation(h)}>
                <CopyIcon data-icon="inline-start" /> Copier la citation
              </Button>
            </div>
          </div>
        ))}
        {filtered.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">Aucune citation ne correspond.</p>
        )}
      </div>

      {items.length < total && !needle && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? "Chargement…" : `Charger plus (${total - items.length})`}
          </Button>
        </div>
      )}
    </div>
  )
}
