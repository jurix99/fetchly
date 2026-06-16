"use client"

import {
  ActivityIcon,
  DownloadIcon,
  GaugeIcon,
  HomeIcon,
  MenuIcon,
  SettingsIcon,
  PlayIcon,
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
  youtube: "YouTube",
  downloads: "Téléchargements",
  settings: "Réglages",
}

const MOBILE_NAV: { id: View; label: string; icon: typeof HomeIcon }[] = [
  { id: "home", label: "Accueil", icon: HomeIcon },
  { id: "youtube", label: "YouTube", icon: PlayIcon },
  { id: "downloads", label: "Téléchargements", icon: DownloadIcon },
  { id: "settings", label: "Réglages", icon: SettingsIcon },
]

export function TopBar({
  active,
  onNavigate,
}: {
  active: View
  onNavigate: (v: View) => void
}) {
  const { activeCount, totalSpeed } = useStore()

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

      <h1 className="text-sm font-semibold tracking-tight">{TITLES[active]}</h1>

      <div className="ml-auto flex items-center gap-2">
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
