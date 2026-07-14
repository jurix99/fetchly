"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ExternalLinkIcon,
  Loader2Icon,
  LocateFixedIcon,
  NetworkIcon,
  PlayIcon,
  SparklesIcon,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { backend, type Content, type ContentMap, type MapEdge, type MapNode } from "@/lib/backend"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet"

const RECALL_S = 2

function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return "0:00"
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

interface Pos {
  x: number
  y: number
  r: number
}

/** Deterministic, hand-rolled radial layout (no graph lib): centre at the middle,
 *  ring-1 neighbours on an inner circle (node radius ∝ score), ring-2 on an outer
 *  circle. Even angular spacing per ring → never an unreadable pile. */
function layout(nodes: MapNode[], w: number, h: number): Map<string, Pos> {
  const cx = w / 2
  const cy = h / 2
  // Reach for most of the canvas so rings sit WELL outside the centre node —
  // otherwise (few nodes) the whole edge hides behind the two circles.
  const base = Math.max(200, Math.min(w, h) / 2 - 28)
  const out = new Map<string, Pos>()
  const ring1 = nodes.filter((n) => n.ring === 1)
  const ring2 = nodes.filter((n) => n.ring === 2)
  const place = (list: MapNode[], radius: number, offset: number, rMin: number, rMax: number) => {
    const n = list.length
    list.forEach((node, i) => {
      const angle = -Math.PI / 2 + ((i + offset) / Math.max(1, n)) * Math.PI * 2
      const nodeR = rMin + (rMax - rMin) * Math.min(1, Math.max(0, node.score_to_center))
      out.set(node.content_id, { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle), r: nodeR })
    })
  }
  for (const n of nodes) if (n.ring === 0) out.set(n.content_id, { x: cx, y: cy, r: 30 })
  place(ring1, base * 0.62, 0, 20, 28)
  place(ring2, base, 0.5, 15, 22)
  return out
}

export function MemoryMap({
  initialCenterId,
  onOpen,
}: {
  initialCenterId: string | null
  onOpen: (id: string, startAt?: number) => void
}) {
  const [centerId, setCenterId] = useState<string | null>(initialCenterId)
  const [depth, setDepth] = useState<1 | 2>(1)
  const [data, setData] = useState<ContentMap | null>(null)
  const [loading, setLoading] = useState(true)
  const [resolving, setResolving] = useState(!initialCenterId)
  const [indexed, setIndexed] = useState<{ indexed: number; total: number; semantic: boolean } | null>(null)
  const [trail, setTrail] = useState<{ id: string; title: string }[]>([])
  const [drawer, setDrawer] = useState<MapNode | null>(null)
  const [hoverEdge, setHoverEdge] = useState<MapEdge | null>(null)
  const [isMobile, setIsMobile] = useState(false)

  const wrapRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const nodeRefs = useRef<Map<string, HTMLButtonElement>>(new Map())

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)")
    const on = () => setIsMobile(mq.matches)
    on()
    mq.addEventListener("change", on)
    return () => mq.removeEventListener("change", on)
  }, [])

  const effectiveDepth: 1 | 2 = isMobile ? 1 : depth

  // Measure the canvas so positions are in real pixels (edges need px too). Keyed
  // on `data` because the canvas only mounts once the graph is ready (after the
  // loading/empty guards) — the observer must (re)attach then.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [data])

  useEffect(() => {
    backend.indexStats().then((s) => setIndexed({ indexed: s.indexed, total: s.total, semantic: s.semantic })).catch(() => {})
  }, [])

  // Resolve a default centre when none was provided (most-connected / last-opened).
  useEffect(() => {
    if (centerId) return
    setResolving(true)
    backend
      .mapStart()
      .then((r) => setCenterId(r.content_id))
      .catch(() => setCenterId(null))
      .finally(() => setResolving(false))
  }, [centerId])

  // Fetch the graph for the current centre + depth.
  useEffect(() => {
    if (!centerId) {
      setData(null)
      setLoading(false)
      return
    }
    let alive = true
    setLoading(true)
    backend
      .contentMap(centerId, effectiveDepth)
      .then((m) => {
        if (!alive) return
        setData(m)
        // Seed / extend the trail (the walk through one's memory).
        setTrail((t) => {
          if (t.some((x) => x.id === centerId)) return t
          const title = m.nodes.find((n) => n.content_id === centerId)?.title || "Contenu"
          return t.length === 0 ? [{ id: centerId, title }] : t
        })
      })
      .catch(() => alive && setData(null))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [centerId, effectiveDepth])

  const positions = useMemo(
    () => (data && size.w > 0 ? layout(data.nodes, size.w, size.h) : new Map<string, Pos>()),
    [data, size],
  )

  const recenter = useCallback(
    (node: MapNode) => {
      setDrawer(null)
      setHoverEdge(null)
      setTrail((t) => {
        const i = t.findIndex((x) => x.id === node.content_id)
        if (i >= 0) return t.slice(0, i + 1)
        return [...t, { id: node.content_id, title: node.title }]
      })
      setCenterId(node.content_id)
    },
    [],
  )

  const jumpTrail = useCallback((idx: number) => {
    setTrail((t) => {
      const target = t[idx]
      if (target) setCenterId(target.id)
      return t.slice(0, idx + 1)
    })
  }, [])

  // Keyboard: arrows move focus between/along rings; Enter opens the drawer.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!data) return
      if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return
      const focusedId = document.activeElement?.getAttribute("data-node-id")
      const rings: MapNode[][] = [0, 1, 2].map((r) => data.nodes.filter((n) => n.ring === r))
      const cur = data.nodes.find((n) => n.content_id === focusedId) ?? data.nodes[0]
      if (!cur) return
      e.preventDefault()
      let target: MapNode | undefined
      const ringList = rings[cur.ring]
      const idx = ringList.findIndex((n) => n.content_id === cur.content_id)
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const d = e.key === "ArrowRight" ? 1 : -1
        target = ringList[(idx + d + ringList.length) % ringList.length]
      } else {
        const dir = e.key === "ArrowDown" ? 1 : -1
        const nextRing = Math.max(0, Math.min(2, cur.ring + dir))
        target = rings[nextRing][0] ?? ringList[idx]
      }
      if (target) nodeRefs.current.get(target.content_id)?.focus()
    },
    [data],
  )

  // --- pedagogical states ---------------------------------------------------
  const busy = resolving || loading
  const underIndexed = indexed && (!indexed.semantic || indexed.indexed < 2)
  const noLinks = data && data.nodes.length <= 1

  if (busy && !data) {
    return (
      <div className="flex h-[60vh] items-center justify-center text-muted-foreground">
        <Loader2Icon className="mr-2 size-4 animate-spin" /> Composition de la carte…
      </div>
    )
  }

  if (underIndexed) {
    return (
      <EmptyMap
        icon={SparklesIcon}
        title="Pas encore assez de mémoire indexée"
        body={
          indexed
            ? `${indexed.indexed} contenu(s) indexé(s) sur ${indexed.total}. Transcrivez et indexez votre bibliothèque : les liens apparaissent quand plusieurs contenus partagent des sujets.`
            : "Transcrivez et indexez votre bibliothèque pour révéler les liens entre contenus."
        }
      />
    )
  }

  if (!centerId || noLinks) {
    return (
      <EmptyMap
        icon={NetworkIcon}
        title="Pas encore de connexions"
        body="Elles apparaissent quand plusieurs contenus partagent des sujets. Continuez à archiver et à indexer votre bibliothèque."
      />
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Breadcrumb (the walk) + controls */}
      <div className="flex flex-wrap items-center gap-2">
        <nav aria-label="Fil de parcours" className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-sm">
          {trail.map((t, i) => (
            <span key={t.id} className="flex items-center gap-1">
              {i > 0 && <span className="text-muted-foreground">›</span>}
              <button
                type="button"
                onClick={() => jumpTrail(i)}
                className={cn(
                  "max-w-40 truncate rounded px-1.5 py-0.5",
                  i === trail.length - 1 ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground hover:underline",
                )}
              >
                {t.title}
              </button>
            </span>
          ))}
        </nav>
        {!isMobile && (
          <div className="flex items-center rounded-lg border border-border p-0.5 text-xs">
            {([1, 2] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDepth(d)}
                className={cn(
                  "rounded-md px-2.5 py-1 font-medium transition-colors",
                  effectiveDepth === d ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                Profondeur {d}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Canvas */}
      <div
        ref={wrapRef}
        role="application"
        aria-label="Carte des liens entre contenus"
        onKeyDown={onKeyDown}
        className="relative h-[68vh] min-h-[460px] w-full overflow-hidden rounded-xl border border-border bg-muted/20"
      >
        {loading && (
          <div className="absolute right-3 top-3 z-20 flex items-center gap-1.5 rounded-full bg-card/90 px-2 py-1 text-xs text-muted-foreground">
            <Loader2Icon className="size-3 animate-spin" /> mise à jour…
          </div>
        )}

        {/* Edges */}
        <svg
          className="absolute inset-0 h-full w-full"
          onClick={() => setHoverEdge(null)}
        >
          {data!.edges.map((e, i) => {
            const pa = positions.get(e.a)
            const pb = positions.get(e.b)
            if (!pa || !pb) return null
            const active = hoverEdge === e
            return (
              <line
                key={i}
                x1={pa.x}
                y1={pa.y}
                x2={pb.x}
                y2={pb.y}
                stroke={active ? "var(--color-primary)" : "var(--color-muted-foreground)"}
                strokeWidth={active ? 2 + Math.min(6, e.score * 6) : 1.5 + Math.min(5, e.score * 5)}
                strokeLinecap="round"
                className={cn(
                  "cursor-pointer transition-all",
                  active ? "[stroke-opacity:1]" : "[stroke-opacity:0.45] hover:[stroke-opacity:0.9]",
                )}
                onMouseEnter={() => !isMobile && setHoverEdge(e)}
                onMouseLeave={() => !isMobile && setHoverEdge((h) => (h === e ? null : h))}
                onClick={(ev) => {
                  ev.stopPropagation()
                  setHoverEdge((h) => (h === e ? null : e))
                }}
              />
            )
          })}
        </svg>

        {/* Edge tooltip (rich passage pair) */}
        {hoverEdge && <EdgeTooltip edge={hoverEdge} data={data!} positions={positions} onOpen={onOpen} />}

        {/* Nodes */}
        {data!.nodes.map((n) => {
          const p = positions.get(n.content_id)
          if (!p) return null
          const isCenter = n.ring === 0
          return (
            <button
              key={n.content_id}
              type="button"
              data-node-id={n.content_id}
              ref={(el) => {
                if (el) nodeRefs.current.set(n.content_id, el)
                else nodeRefs.current.delete(n.content_id)
              }}
              onClick={() => setDrawer(n)}
              title={n.title}
              aria-label={`${n.title}${isCenter ? " (centre)" : ""}`}
              style={{ left: p.x, top: p.y, width: p.r * 2, height: p.r * 2 }}
              className={cn(
                "group absolute z-10 -translate-x-1/2 -translate-y-1/2 rounded-full transition-all duration-300 ease-out",
                "outline-none ring-offset-2 ring-offset-background focus-visible:ring-2 focus-visible:ring-primary",
                isCenter ? "ring-2 ring-primary" : "ring-1 ring-border hover:ring-primary/60",
              )}
            >
              <span className="block size-full overflow-hidden rounded-full bg-muted">
                {n.thumbnail ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={n.thumbnail} alt="" className="size-full object-cover" />
                ) : (
                  <span className="flex size-full items-center justify-center text-muted-foreground">
                    <PlayIcon className="size-4" />
                  </span>
                )}
              </span>
              <span
                className={cn(
                  "pointer-events-none absolute left-1/2 top-full mt-1 w-32 -translate-x-1/2 truncate rounded bg-popover px-1.5 py-0.5 text-center text-[11px] text-popover-foreground ring-1 ring-foreground/10",
                  isCenter ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100",
                )}
              >
                {n.title}
              </span>
            </button>
          )
        })}
      </div>

      {/* Node drawer — the knowledge card + its links (accessible tooltip alt). */}
      <NodeDrawer
        node={drawer}
        data={data}
        onClose={() => setDrawer(null)}
        onOpen={onOpen}
        onRecenter={recenter}
      />
    </div>
  )
}

function EdgeTooltip({
  edge,
  data,
  positions,
  onOpen,
}: {
  edge: MapEdge
  data: ContentMap
  positions: Map<string, Pos>
  onOpen: (id: string, startAt?: number) => void
}) {
  const pa = positions.get(edge.a)
  const pb = positions.get(edge.b)
  if (!pa || !pb) return null
  const mx = (pa.x + pb.x) / 2
  const my = (pa.y + pb.y) / 2
  const titleOf = (id: string) => data.nodes.find((n) => n.content_id === id)?.title || "Contenu"
  return (
    <div
      className="absolute z-30 w-64 -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-popover p-2.5 text-xs shadow-lg"
      style={{ left: mx, top: my }}
    >
      <EdgeEnd label="Ici" title={titleOf(edge.a)} ms={edge.pair.a_start_ms} text={edge.pair.a_text} onJump={() => onOpen(edge.a, Math.max(0, (edge.pair.a_start_ms ?? 0) / 1000 - RECALL_S))} />
      <div className="my-1.5 h-px bg-border" />
      <EdgeEnd label="Là-bas" title={titleOf(edge.b)} ms={edge.pair.b_start_ms} text={edge.pair.b_text} onJump={() => onOpen(edge.b, Math.max(0, (edge.pair.b_start_ms ?? 0) / 1000 - RECALL_S))} />
    </div>
  )
}

function EdgeEnd({
  label,
  title,
  ms,
  text,
  onJump,
}: {
  label: string
  title: string
  ms: number | null
  text: string | null
  onJump: () => void
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1.5">
        <span className="font-medium text-muted-foreground">{label}</span>
        <span className="truncate text-foreground/80">{title}</span>
        <button
          type="button"
          onClick={onJump}
          className="ml-auto flex items-center gap-1 font-mono tabular-nums text-primary hover:underline"
        >
          <PlayIcon className="size-3" /> {fmtMs(ms)}
        </button>
      </div>
      {text && <p className="line-clamp-2 text-foreground/70">{text}</p>}
    </div>
  )
}

function NodeDrawer({
  node,
  data,
  onClose,
  onOpen,
  onRecenter,
}: {
  node: MapNode | null
  data: ContentMap | null
  onClose: () => void
  onOpen: (id: string, startAt?: number) => void
  onRecenter: (n: MapNode) => void
}) {
  const [content, setContent] = useState<Content | null>(null)

  useEffect(() => {
    setContent(null)
    if (!node) return
    backend
      .libraryItem(node.content_id)
      .then((c) => (c && !("error" in c && c.error) ? setContent(c as Content) : undefined))
      .catch(() => {})
  }, [node])

  // Links incident to this node (the keyboard/no-hover accessible path to pairs).
  const links = useMemo(() => {
    if (!node || !data) return []
    return data.edges
      .filter((e) => e.a === node.content_id || e.b === node.content_id)
      .map((e) => {
        const otherId = e.a === node.content_id ? e.b : e.a
        const other = data.nodes.find((n) => n.content_id === otherId)
        const selfMs = e.a === node.content_id ? e.pair.a_start_ms : e.pair.b_start_ms
        const otherMs = e.a === node.content_id ? e.pair.b_start_ms : e.pair.a_start_ms
        return { otherId, other, selfMs, otherMs, score: e.score }
      })
      .sort((a, b) => b.score - a.score)
  }, [node, data])

  return (
    <Sheet open={!!node} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="gap-0 p-0">
        {node && (
          <>
            <SheetHeader>
              <SheetTitle className="pr-8">{node.title}</SheetTitle>
              <SheetDescription>{node.channel}</SheetDescription>
            </SheetHeader>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
              <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-muted">
                {node.thumbnail ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={node.thumbnail} alt="" className="size-full object-cover" />
                ) : (
                  <div className="flex size-full items-center justify-center text-muted-foreground">
                    <PlayIcon className="size-6" />
                  </div>
                )}
              </div>
              {content?.summary_short && (
                <p className="text-sm text-muted-foreground">{content.summary_short}</p>
              )}

              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => onOpen(node.content_id)}>
                  <ExternalLinkIcon data-icon="inline-start" /> Ouvrir
                </Button>
                {node.ring !== 0 && (
                  <Button size="sm" variant="outline" onClick={() => onRecenter(node)}>
                    <LocateFixedIcon data-icon="inline-start" /> Centrer la carte ici
                  </Button>
                )}
              </div>

              {links.length > 0 && (
                <div className="flex flex-col gap-2">
                  <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Liens ({links.length})
                  </p>
                  {links.map((l) => (
                    <div key={l.otherId} className="flex flex-col gap-1 rounded-lg border border-border bg-card p-2.5">
                      <p className="line-clamp-1 text-sm font-medium">{l.other?.title || "Contenu"}</p>
                      <div className="flex items-center gap-3 text-xs">
                        <button
                          type="button"
                          onClick={() => onOpen(node.content_id, Math.max(0, (l.selfMs ?? 0) / 1000 - RECALL_S))}
                          className="flex items-center gap-1 font-mono tabular-nums text-primary hover:underline"
                        >
                          <PlayIcon className="size-3" /> Ici {fmtMs(l.selfMs)}
                        </button>
                        <button
                          type="button"
                          onClick={() => onOpen(l.otherId, Math.max(0, (l.otherMs ?? 0) / 1000 - RECALL_S))}
                          className="flex items-center gap-1 font-mono tabular-nums text-primary hover:underline"
                        >
                          <ExternalLinkIcon className="size-3" /> Là-bas {fmtMs(l.otherMs)}
                        </button>
                        {l.other && (
                          <button
                            type="button"
                            onClick={() => onRecenter(l.other!)}
                            className="ml-auto text-muted-foreground hover:text-foreground hover:underline"
                          >
                            Centrer
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

function EmptyMap({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof NetworkIcon
  title: string
  body: string
}) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-20 text-center">
      <span className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
        <Icon className="size-6" />
      </span>
      <h3 className="text-base font-semibold">{title}</h3>
      <p className="text-balance text-sm text-muted-foreground">{body}</p>
    </div>
  )
}
