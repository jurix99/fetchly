"use client"

import { useCallback, useEffect, useState } from "react"
import dynamic from "next/dynamic"
import { toast } from "sonner"

import { backend } from "@/lib/backend"
import { useStore } from "@/components/store-provider"
import { Sidebar } from "@/components/sidebar"
import { TopBar } from "@/components/top-bar"
import { TodayView } from "@/components/views/today-view"
import { MemoryView } from "@/components/views/library-view"
import { SearchView } from "@/components/views/search-view"
import { SourcesView } from "@/components/views/sources-view"
import { SettingsView } from "@/components/views/settings-view"
import { ContentDetailView } from "@/components/views/content-detail-view"
import { ClipboardWatcher } from "@/components/clipboard-watcher"
import { ActivityTray } from "@/components/activity-tray"
import { AddSourceDialog } from "@/components/add-source-dialog"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"

// Lazy: the palette (and the whole search stack) is only fetched on first open,
// so the top-bar and initial paint stay light.
const CommandPalette = dynamic(
  () => import("@/components/command-palette").then((m) => m.CommandPalette),
  { ssr: false },
)

/** The four first-level destinations + the two non-nav surfaces (search results,
 *  and the content detail which is driven by ?content=). Downloads is no longer a
 *  destination — it lives in the activity tray. */
export type View = "today" | "memory" | "sources" | "search" | "settings"

/** Old view ids kept working: deep links and any stray caller are remapped so no
 *  link is dead after the reorganization. */
const LEGACY: Record<string, View> = {
  home: "today",
  library: "memory",
  explorer: "sources",
  subscriptions: "sources",
  downloads: "memory", // downloads is now the tray; fall back to Mémoire
}

export function normalizeView(v: string | null | undefined): View {
  if (!v) return "today"
  if (["today", "memory", "sources", "search", "settings"].includes(v)) return v as View
  return LEGACY[v] ?? "today"
}

/** A content opened in the detail view, optionally at a start timestamp (the
 *  contract search uses: ?content=<id>&t=<seconds>). */
export interface ContentTarget {
  id: string
  startAt?: number
}

/** The one-time first-transcript "aha" callout state. */
export interface Celebration {
  show: boolean
  contentId: string | null
}

/** Sync a shallow query param without a navigation (static export, no router). */
function setParam(key: string, value: string | null) {
  if (typeof window === "undefined") return
  const url = new URL(window.location.href)
  if (value) url.searchParams.set(key, value)
  else url.searchParams.delete(key)
  window.history.replaceState(null, "", url.toString())
}

export function AppShell() {
  const { capture } = useStore()
  const [booted, setBooted] = useState(false)
  const [view, setView] = useState<View>("today")
  const [content, setContent] = useState<ContentTarget | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteMounted, setPaletteMounted] = useState(false)
  const [trayOpen, setTrayOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [addSource, setAddSource] = useState<{ open: boolean; url: string }>({ open: false, url: "" })
  const [celebration, setCelebration] = useState<Celebration>({ show: false, contentId: null })
  // Memory's Carte mode centre (set by "Ouvrir la carte" from a fiche).
  const [mapCenter, setMapCenter] = useState<string | null>(null)

  // Startup routing: deep links win; otherwise "Aujourd'hui" is the home ("/").
  useEffect(() => {
    const p = new URLSearchParams(window.location.search)
    const id = p.get("content")
    const q = p.get("q")
    if (id) {
      const t = p.get("t")
      setContent({ id, startAt: t ? Number(t) : undefined })
    } else if (q) {
      setSearchQuery(q)
      setView("search")
    } else {
      setView(normalizeView(p.get("view")))
    }
    setBooted(true)
  }, [])

  // The first-transcript "aha" callout: fetched once at boot.
  useEffect(() => {
    backend.celebration().then(setCelebration).catch(() => {})
  }, [])

  // Cmd/Ctrl+K opens the palette from anywhere; mount it lazily on first use.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault()
        setPaletteMounted(true)
        setPaletteOpen((o) => !o)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const openPalette = useCallback(() => {
    setPaletteMounted(true)
    setPaletteOpen(true)
  }, [])

  const navigate = useCallback((v: View) => {
    setContent(null)
    if (v !== "search") setParam("q", null)
    setView(v)
  }, [])

  const dismissCelebration = useCallback(() => {
    setCelebration((c) => ({ ...c, show: false }))
    backend.dismissCelebration().catch(() => {})
  }, [])

  const openContent = useCallback(
    (id: string, startAt?: number, queryHash?: string) => {
      // North-star instrumentation (LOCAL): a search that led to opening a result.
      // That first successful "retrouvaille" also retires the aha callout.
      if (queryHash) {
        backend.searchFeedback(queryHash).catch(() => {})
        dismissCelebration()
      }
      setContent({ id, startAt })
    },
    [dismissCelebration],
  )

  const openSearch = useCallback((query: string) => {
    setSearchQuery(query)
    setContent(null)
    setView("search")
    setParam("q", query || null)
  }, [])

  const syncSearchParam = useCallback((query: string) => setParam("q", query || null), [])

  // One-gesture capture (palette / paste / "+"): start the download and land the
  // user in Mémoire where the pending card is already enriching.
  const onCapture = useCallback(
    (url: string) => {
      capture(url)
      setContent(null)
      setView("memory")
      toast.success("Capture lancée", { description: "La carte apparaît dans Mémoire." })
    },
    [capture],
  )

  const openAddSource = useCallback((url = "") => setAddSource({ open: true, url }), [])

  // "Ouvrir la carte" — Mémoire in Carte mode, centred on a content.
  const openMap = useCallback((id: string) => {
    setContent(null)
    setMapCenter(id)
    setView("memory")
  }, [])

  if (!booted) {
    return <div className="h-dvh bg-background" />
  }

  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar active={view} onNavigate={navigate} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          active={view}
          onNavigate={navigate}
          onOpenSearch={openPalette}
          onOpenTray={() => setTrayOpen(true)}
          onAddSource={() => openAddSource()}
        />
        <main className="flex-1 overflow-y-auto">
          {content ? (
            <ContentDetailView
              key={content.id}
              contentId={content.id}
              startAt={content.startAt}
              celebration={celebration}
              onDismissCelebration={dismissCelebration}
              onOpenPalette={openPalette}
              onOpenMap={openMap}
              onBack={() => setContent(null)}
              onNavigate={navigate}
              onOpenContent={openContent}
            />
          ) : (
            <>
              {view === "today" && (
                <TodayView
                  onOpen={openContent}
                  onNavigate={navigate}
                  onAddSource={openAddSource}
                  celebration={celebration}
                  onDismissCelebration={dismissCelebration}
                  onOpenPalette={openPalette}
                />
              )}
              {view === "memory" && (
                <MemoryView onOpen={openContent} onAddSource={openAddSource} mapCenter={mapCenter} />
              )}
              {view === "search" && (
                <SearchView
                  key={searchQuery}
                  initialQuery={searchQuery}
                  onQueryChange={syncSearchParam}
                  onOpen={openContent}
                  onNavigate={navigate}
                />
              )}
              {view === "sources" && <SourcesView onAddSource={openAddSource} />}
              {view === "settings" && <SettingsView />}
            </>
          )}
        </main>
      </div>

      <ClipboardWatcher onCapture={onCapture} />
      <ActivityTray
        open={trayOpen}
        onOpenChange={setTrayOpen}
        onOpenHistory={() => {
          setTrayOpen(false)
          setHistoryOpen(true)
        }}
      />
      {historyOpen && (
        <DownloadsHistorySheet open={historyOpen} onOpenChange={setHistoryOpen} onNavigate={navigate} />
      )}
      <AddSourceDialog
        open={addSource.open}
        initialUrl={addSource.url}
        onOpenChange={(o) => setAddSource((s) => ({ ...s, open: o }))}
        onGoToMemory={() => navigate("memory")}
      />
      {paletteMounted && (
        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          onOpen={openContent}
          onSeeAll={openSearch}
          onCapture={onCapture}
          onNavigate={navigate}
          onOpenTray={() => setTrayOpen(true)}
          onAddSource={() => openAddSource()}
        />
      )}
    </div>
  )
}

/** The complete downloads history, opened from the tray as a full-height sheet.
 *  Lazy so the DownloadsView stack loads only when the user asks for it. */
const DownloadsView = dynamic(
  () => import("@/components/views/downloads-view").then((m) => m.DownloadsView),
  { ssr: false },
)

function DownloadsHistorySheet({
  open,
  onOpenChange,
  onNavigate,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onNavigate: (v: View) => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="full" className="p-0">
        <SheetHeader>
          <SheetTitle>Historique des téléchargements</SheetTitle>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <DownloadsView
            onNavigate={(v: View) => {
              onOpenChange(false)
              onNavigate(v)
            }}
          />
        </div>
      </SheetContent>
    </Sheet>
  )
}
