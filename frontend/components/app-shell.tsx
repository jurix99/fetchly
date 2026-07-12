"use client"

import { useCallback, useEffect, useState } from "react"
import dynamic from "next/dynamic"

import { backend } from "@/lib/backend"
import { Sidebar } from "@/components/sidebar"
import { TopBar } from "@/components/top-bar"
import { HomeView } from "@/components/views/home-view"
import { YoutubeView } from "@/components/views/youtube-view"
import { LibraryView } from "@/components/views/library-view"
import { SearchView } from "@/components/views/search-view"
import { SubscriptionsView } from "@/components/views/subscriptions-view"
import { DownloadsView } from "@/components/views/downloads-view"
import { SettingsView } from "@/components/views/settings-view"
import { ContentDetailView } from "@/components/views/content-detail-view"
import { ClipboardWatcher } from "@/components/clipboard-watcher"

// Lazy: the palette (and the whole search stack) is only fetched on first open,
// so the top-bar and initial paint stay light.
const CommandPalette = dynamic(
  () => import("@/components/command-palette").then((m) => m.CommandPalette),
  { ssr: false },
)

export type View = "home" | "library" | "search" | "explorer" | "subscriptions" | "downloads" | "settings"

/** A content opened in the detail view, optionally at a start timestamp (the
 *  contract search uses: ?content=<id>&t=<seconds>). */
export interface ContentTarget {
  id: string
  startAt?: number
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
  // `booted` avoids a flash of the wrong default before we know the library size.
  const [booted, setBooted] = useState(false)
  const [view, setView] = useState<View>("home")
  const [content, setContent] = useState<ContentTarget | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteMounted, setPaletteMounted] = useState(false)

  // Startup routing: deep links win; otherwise the Library becomes the default
  // entry once it holds anything (phase-3 home), else the onboarding Home.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search)
    const id = p.get("content")
    const q = p.get("q")
    if (id) {
      const t = p.get("t")
      setContent({ id, startAt: t ? Number(t) : undefined })
      setBooted(true)
      return
    }
    if (q) {
      setSearchQuery(q)
      setView("search")
      setBooted(true)
      return
    }
    backend
      .library({ limit: 1 })
      .then((page) => setView(page.total > 0 ? "library" : "home"))
      .catch(() => setView("home"))
      .finally(() => setBooted(true))
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

  function navigate(v: View) {
    setContent(null)
    if (v !== "search") setParam("q", null)
    setView(v)
  }

  const openContent = useCallback((id: string, startAt?: number, queryHash?: string) => {
    // North-star instrumentation (LOCAL): a search that led to opening a result.
    if (queryHash) backend.searchFeedback(queryHash).catch(() => {})
    setContent({ id, startAt })
  }, [])

  const openSearch = useCallback((query: string) => {
    setSearchQuery(query)
    setContent(null)
    setView("search")
    setParam("q", query || null)
  }, [])

  const syncSearchParam = useCallback((query: string) => setParam("q", query || null), [])

  if (!booted) {
    return <div className="h-dvh bg-background" />
  }

  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar active={view} onNavigate={navigate} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar active={view} onNavigate={navigate} onOpenSearch={openPalette} />
        <main className="flex-1 overflow-y-auto">
          {content ? (
            <ContentDetailView
              key={content.id}
              contentId={content.id}
              startAt={content.startAt}
              onBack={() => setContent(null)}
              onNavigate={navigate}
              onOpenContent={openContent}
            />
          ) : (
            <>
              {view === "home" && <HomeView onNavigate={navigate} />}
              {view === "library" && <LibraryView onOpen={openContent} onNavigate={navigate} />}
              {view === "search" && (
                <SearchView
                  key={searchQuery}
                  initialQuery={searchQuery}
                  onQueryChange={syncSearchParam}
                  onOpen={openContent}
                  onNavigate={navigate}
                />
              )}
              {view === "explorer" && <YoutubeView />}
              {view === "subscriptions" && <SubscriptionsView />}
              {view === "downloads" && <DownloadsView onNavigate={navigate} />}
              {view === "settings" && <SettingsView />}
            </>
          )}
        </main>
      </div>
      <ClipboardWatcher />
      {paletteMounted && (
        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          onOpen={openContent}
          onSeeAll={openSearch}
        />
      )}
    </div>
  )
}
