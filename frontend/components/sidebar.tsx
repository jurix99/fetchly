"use client"

import {
  CompassIcon,
  DownloadIcon,
  HomeIcon,
  LibraryIcon,
  RssIcon,
  SettingsIcon,
  ZapIcon,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { useStore } from "@/components/store-provider"
import type { View } from "@/components/app-shell"

const NAV: { id: View; label: string; icon: typeof HomeIcon }[] = [
  { id: "home", label: "Accueil", icon: HomeIcon },
  { id: "library", label: "Bibliothèque", icon: LibraryIcon },
  { id: "explorer", label: "Explorer", icon: CompassIcon },
  { id: "subscriptions", label: "Abonnements", icon: RssIcon },
  { id: "downloads", label: "Téléchargements", icon: DownloadIcon },
  { id: "settings", label: "Réglages", icon: SettingsIcon },
]

export function Sidebar({
  active,
  onNavigate,
}: {
  active: View
  onNavigate: (v: View) => void
}) {
  const { activeCount, subscriptions } = useStore()
  const activeSubs = subscriptions.filter((s) => s.active).length

  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar md:flex">
      <div className="flex h-14 items-center gap-2 border-b border-sidebar-border px-4">
        <div className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <ZapIcon className="size-4" />
        </div>
        <span className="text-sm font-semibold tracking-tight">Fetchly</span>
        <Badge variant="outline" className="ml-auto text-[10px]">
          beta
        </Badge>
      </div>

      <nav className="flex flex-1 flex-col gap-1 p-3">
        <p className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Navigation
        </p>
        {NAV.map((item) => {
          const Icon = item.icon
          const isActive = active === item.id
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onNavigate(item.id)}
              className={cn(
                "flex items-center gap-3 rounded-md px-2.5 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
              )}
            >
              <Icon className="size-4 shrink-0" />
              <span className="flex-1 text-left">{item.label}</span>
              {item.id === "downloads" && activeCount > 0 && (
                <Badge className="bg-info/20 text-info border-info/30 text-[10px]">
                  {activeCount}
                </Badge>
              )}
            </button>
          )
        })}
      </nav>

      <div className="border-t border-sidebar-border p-3">
        <div className="rounded-lg border border-sidebar-border bg-card/50 p-3">
          <p className="text-xs font-medium">Abonnements actifs</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">
            {activeSubs}
          </p>
          <p className="text-[11px] text-muted-foreground">
            surveillance automatique des nouvelles vidéos
          </p>
        </div>
      </div>
    </aside>
  )
}
