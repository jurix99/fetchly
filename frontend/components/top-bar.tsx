"use client"

import { useEffect, useState } from "react"
import {
  ActivityIcon,
  CompassIcon,
  DownloadIcon,
  GaugeIcon,
  HomeIcon,
  LibraryIcon,
  MenuIcon,
  RssIcon,
  SearchIcon,
  SettingsIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Separator } from "@/components/ui/separator"
import { ThemeToggle } from "@/components/theme-toggle"
import { useStore } from "@/components/store-provider"
import type { View } from "@/components/app-shell"

const TITLES: Record<View, string> = {
  home: "Accueil",
  library: "Bibliothèque",
  search: "Recherche",
  explorer: "Explorer",
  subscriptions: "Abonnements",
  downloads: "Téléchargements",
  settings: "Réglages",
}

const MOBILE_NAV: { id: View; label: string; icon: typeof HomeIcon }[] = [
  { id: "home", label: "Accueil", icon: HomeIcon },
  { id: "library", label: "Bibliothèque", icon: LibraryIcon },
  { id: "explorer", label: "Explorer", icon: CompassIcon },
  { id: "subscriptions", label: "Abonnements", icon: RssIcon },
  { id: "downloads", label: "Téléchargements", icon: DownloadIcon },
  { id: "settings", label: "Réglages", icon: SettingsIcon },
]

export function TopBar({
  active,
  onNavigate,
  onOpenSearch,
}: {
  active: View
  onNavigate: (v: View) => void
  onOpenSearch: () => void
}) {
  const { activeCount, totalSpeed } = useStore()
  const [isMac, setIsMac] = useState(false)

  useEffect(() => {
    setIsMac(/Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent))
  }, [])

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur-md">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="icon" className="md:hidden" aria-label="Menu">
              <MenuIcon />
            </Button>
          }
        />
        <DropdownMenuContent align="start" className="w-52">
          <DropdownMenuGroup>
            {MOBILE_NAV.map((item) => {
              const Icon = item.icon
              return (
                <DropdownMenuItem key={item.id} onClick={() => onNavigate(item.id)}>
                  <Icon />
                  {item.label}
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <h1 className="shrink-0 text-sm font-semibold tracking-tight">{TITLES[active]}</h1>

      {/* Omnipresent global search — opens the command palette (lazy). */}
      <button
        type="button"
        onClick={onOpenSearch}
        aria-label="Rechercher dans tout ce que vous avez archivé"
        aria-keyshortcuts={isMac ? "Meta+K" : "Control+K"}
        className="group mx-auto hidden h-9 w-full max-w-md items-center gap-2 rounded-lg border border-border bg-card px-3 text-sm text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground sm:flex"
      >
        <SearchIcon className="size-4 shrink-0" />
        <span className="truncate">Rechercher dans tout ce que vous avez archivé…</span>
        <kbd className="ml-auto hidden items-center gap-0.5 rounded border border-border bg-background px-1.5 py-0.5 font-sans text-[10px] font-medium text-muted-foreground md:inline-flex">
          {isMac ? "⌘" : "Ctrl"} K
        </kbd>
      </button>

      <div className="ml-auto flex items-center gap-2 sm:ml-0">
        {/* Compact search trigger on narrow screens. */}
        <Button
          variant="ghost"
          size="icon"
          className="sm:hidden"
          onClick={onOpenSearch}
          aria-label="Rechercher"
        >
          <SearchIcon />
        </Button>
        <div className="hidden items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs sm:flex">
          <ActivityIcon className="size-3.5 text-info" />
          <span className="font-medium tabular-nums">{activeCount}</span>
          <span className="text-muted-foreground">actifs</span>
        </div>
        <div className="hidden items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs sm:flex">
          <GaugeIcon className="size-3.5 text-success" />
          <span className="font-medium tabular-nums">{totalSpeed}</span>
        </div>
        <Separator orientation="vertical" className="hidden h-5 sm:block" />
        <ThemeToggle />
      </div>
    </header>
  )
}
