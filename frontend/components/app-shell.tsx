"use client"

import { useEffect, useState } from "react"

import { Sidebar } from "@/components/sidebar"
import { TopBar } from "@/components/top-bar"
import { HomeView } from "@/components/views/home-view"
import { YoutubeView } from "@/components/views/youtube-view"
import { LibraryView } from "@/components/views/library-view"
import { SubscriptionsView } from "@/components/views/subscriptions-view"
import { DownloadsView } from "@/components/views/downloads-view"
import { SettingsView } from "@/components/views/settings-view"
import { ContentDetailView } from "@/components/views/content-detail-view"
import { ClipboardWatcher } from "@/components/clipboard-watcher"

export type View = "home" | "library" | "explorer" | "subscriptions" | "downloads" | "settings"

/** A content opened in the detail view, optionally at a start timestamp (the
 *  contract search will use: ?content=<id>&t=<seconds>). */
export interface ContentTarget {
  id: string
  startAt?: number
}

export function AppShell() {
  const [view, setView] = useState<View>("home")
  const [content, setContent] = useState<ContentTarget | null>(null)

  // Deep link: ?content=<id>&t=<seconds> opens a content at a timestamp.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search)
    const id = p.get("content")
    if (id) {
      const t = p.get("t")
      setContent({ id, startAt: t ? Number(t) : undefined })
    }
  }, [])

  function navigate(v: View) {
    setContent(null)
    setView(v)
  }

  function openContent(id: string, startAt?: number) {
    setContent({ id, startAt })
  }

  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar active={view} onNavigate={navigate} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar active={view} onNavigate={navigate} />
        <main className="flex-1 overflow-y-auto">
          {content ? (
            <ContentDetailView
              key={content.id}
              contentId={content.id}
              startAt={content.startAt}
              onBack={() => setContent(null)}
              onNavigate={navigate}
            />
          ) : (
            <>
              {view === "home" && <HomeView onNavigate={navigate} />}
              {view === "library" && <LibraryView onOpen={openContent} onNavigate={navigate} />}
              {view === "explorer" && <YoutubeView />}
              {view === "subscriptions" && <SubscriptionsView />}
              {view === "downloads" && <DownloadsView onNavigate={navigate} />}
              {view === "settings" && <SettingsView />}
            </>
          )}
        </main>
      </div>
      <ClipboardWatcher />
    </div>
  )
}
