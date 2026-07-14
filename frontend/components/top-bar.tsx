"use client"

import { useEffect, useState } from "react"
import {
  ActivityIcon,
  LibraryIcon,
  MenuIcon,
  PlusIcon,
  RadioTowerIcon,
  SearchIcon,
  SettingsIcon,
  SunriseIcon,
} from "lucide-react"

import { cn } from "@/lib/utils"
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
  today: "Aujourd'hui",
  memory: "Mémoire",
  sources: "Sources",
  search: "Recherche",
  settings: "Réglages",
}

const MOBILE_NAV: { id: View; label: string; icon: typeof SunriseIcon }[] = [
  { id: "today", label: "Aujourd'hui", icon: SunriseIcon },
  { id: "memory", label: "Mémoire", icon: LibraryIcon },
  { id: "sources", label: "Sources", icon: RadioTowerIcon },
  { id: "settings", label: "Réglages", icon: SettingsIcon },
]

export function TopBar({
  active,
  onNavigate,
  onOpenSearch,
  onOpenTray,
  onAddSource,
}: {
  active: View
  onNavigate: (v: View) => void
  onOpenSearch: () => void
  onOpenTray: () => void
  onAddSource: () => void
}) {
  const { activeTotal, globalPaused, errorCount } = useStore()
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

      <div className="ml-auto flex items-center gap-1.5 sm:ml-0">
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

        {/* Omnipresent capture — the gesture, not a place. */}
        <Button size="sm" onClick={onAddSource} aria-label="Ajouter une source">
          <PlusIcon data-icon="inline-start" />
          <span className="hidden sm:inline">Ajouter</span>
        </Button>

        {/* Activity tray — the plumbing is consulted, not inhabited. Discreet when
            calm; amber if globally paused; red when there are unseen errors. */}
        <Button
          variant="ghost"
          size="icon"
          onClick={onOpenTray}
          aria-label={`Activité${activeTotal ? ` — ${activeTotal} en cours` : ""}`}
          className="relative"
        >
          <ActivityIcon
            className={cn(activeTotal > 0 ? "text-info" : "text-muted-foreground")}
          />
          {activeTotal > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-info px-1 text-[10px] font-semibold tabular-nums text-background">
              {activeTotal > 99 ? "99+" : activeTotal}
            </span>
          )}
          {errorCount > 0 && (
            <span className="absolute right-0 top-0 size-2 rounded-full bg-destructive ring-2 ring-background" />
          )}
          {activeTotal === 0 && errorCount === 0 && globalPaused && (
            <span className="absolute right-0 top-0 size-2 rounded-full bg-warning ring-2 ring-background" />
          )}
        </Button>

        <Separator orientation="vertical" className="hidden h-5 sm:block" />
        <ThemeToggle />
      </div>
    </header>
  )
}
