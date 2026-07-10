"use client"

import { useState } from "react"

import { Sidebar } from "@/components/sidebar"
import { TopBar } from "@/components/top-bar"
import { HomeView } from "@/components/views/home-view"
import { YoutubeView } from "@/components/views/youtube-view"
import { DownloadsView } from "@/components/views/downloads-view"
import { SettingsView } from "@/components/views/settings-view"
import { ClipboardWatcher } from "@/components/clipboard-watcher"

export type View = "home" | "youtube" | "downloads" | "settings"

export function AppShell() {
  const [view, setView] = useState<View>("home")

  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar active={view} onNavigate={setView} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar active={view} onNavigate={setView} />
        <main className="flex-1 overflow-y-auto">
          {view === "home" && <HomeView onNavigate={setView} />}
          {view === "youtube" && <YoutubeView />}
          {view === "downloads" && <DownloadsView onNavigate={setView} />}
          {view === "settings" && <SettingsView />}
        </main>
      </div>
      <ClipboardWatcher />
    </div>
  )
}
