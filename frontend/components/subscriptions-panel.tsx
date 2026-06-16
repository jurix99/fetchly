"use client"

import { useState } from "react"
import {
  BellIcon,
  ClockIcon,
  ListVideoIcon,
  RefreshCwIcon,
  SettingsIcon,
  Trash2Icon,
  TvIcon,
} from "lucide-react"

import { cn } from "@/lib/utils"
import type { Subscription } from "@/lib/types"
import { useStore } from "@/components/store-provider"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Switch } from "@/components/ui/switch"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { SubscriptionEditor } from "@/components/subscription-editor"

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const h = Math.floor(diff / 3_600_000)
  if (h < 1) return "il y a moins d'une heure"
  if (h < 24) return `il y a ${h} h`
  return `il y a ${Math.floor(h / 24)} j`
}

export function SubscriptionsPanel() {
  const {
    subscriptions,
    watchProgress,
    toggleSubscription,
    checkSubscriptionNow,
    removeSubscription,
  } = useStore()
  const [editing, setEditing] = useState<Subscription | null>(null)

  if (subscriptions.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <BellIcon />
          </EmptyMedia>
          <EmptyTitle>Aucun abonnement</EmptyTitle>
          <EmptyDescription>
            Suivez une chaîne ou une playlist depuis l&apos;onglet Explorer pour
            télécharger automatiquement les nouvelles vidéos.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {subscriptions.map((sub) => {
        const prog = watchProgress[sub.id]
        return (
        <Card key={sub.id} className={cn(!sub.active && "opacity-70")}>
          <CardContent className="flex flex-col gap-4">
            <div className="flex items-start gap-3">
              <Avatar className="size-11">
                <AvatarImage src={sub.avatar || "/placeholder.svg"} alt={sub.name} />
                <AvatarFallback>{sub.name[0]}</AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="truncate font-semibold">{sub.name}</h3>
                  <Badge variant="secondary" className="gap-1 text-[10px]">
                    {sub.type === "channel" ? (
                      <TvIcon className="size-3" />
                    ) : (
                      <ListVideoIcon className="size-3" />
                    )}
                    {sub.type === "channel" ? "Chaîne" : "Playlist"}
                  </Badge>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <ClockIcon className="size-3.5" />
                    Toutes les {sub.checkIntervalHours} h
                  </span>
                  <span>Sync {timeAgo(sub.lastChecked)}</span>
                  <span>
                    {sub.defaultQuality} · {sub.defaultFormat}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <Switch
                  checked={sub.active}
                  onCheckedChange={() => toggleSubscription(sub.id)}
                  aria-label="Activer / mettre en pause"
                />
              </div>
            </div>

            {/* Backfill/sync state (watch jobs are hidden from the Téléchargements
                tab, so surface them here). Only call it a "download" when a video
                is actually downloading — otherwise it's just checking. */}
            {prog && prog.downloading ? (
              <div className="flex flex-col gap-1 rounded-md border border-info/30 bg-info/5 p-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1.5 text-info">
                    <RefreshCwIcon className="size-3.5 animate-spin" />
                    Téléchargement en cours
                  </span>
                  {prog.total > 1 && (
                    <span className="tabular-nums text-muted-foreground">
                      {prog.completed}/{prog.total}
                    </span>
                  )}
                </div>
                <Progress value={prog.percent} />
                {prog.currentTitle && (
                  <span className="truncate text-[11px] text-muted-foreground">
                    {prog.currentTitle}
                  </span>
                )}
              </div>
            ) : prog && prog.active ? (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <RefreshCwIcon className="size-3.5 animate-spin" />
                Vérification en cours…
              </div>
            ) : null}

            {/* Filters summary */}
            <div className="flex flex-wrap gap-1.5">
              {sub.filters.excludeShorts && (
                <Badge variant="outline" className="text-[10px]">Sans Shorts</Badge>
              )}
              {sub.filters.excludeLives && (
                <Badge variant="outline" className="text-[10px]">Sans Lives</Badge>
              )}
              {sub.filters.keepLastN && (
                <Badge variant="outline" className="text-[10px]">
                  {sub.filters.keepLastN} dernières
                </Badge>
              )}
              {(sub.filters.minDuration || sub.filters.maxDuration) && (
                <Badge variant="outline" className="text-[10px]">
                  {sub.filters.minDuration ?? 0}–{sub.filters.maxDuration ?? "∞"} min
                </Badge>
              )}
              {sub.filters.includeKeywords.map((k) => (
                <Badge key={k} className="bg-success/15 text-success border-success/30 text-[10px]">
                  +{k}
                </Badge>
              ))}
              {sub.filters.excludeKeywords.map((k) => (
                <Badge key={k} className="bg-destructive/15 text-destructive border-destructive/30 text-[10px]">
                  −{k}
                </Badge>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => checkSubscriptionNow(sub.id)}>
                <RefreshCwIcon data-icon="inline-start" />
                Vérifier maintenant
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(sub)}>
                <SettingsIcon data-icon="inline-start" />
                Filtres
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto text-destructive"
                onClick={() => removeSubscription(sub.id)}
              >
                <Trash2Icon data-icon="inline-start" />
                Retirer
              </Button>
            </div>
          </CardContent>
        </Card>
        )
      })}

      <SubscriptionEditor
        subscription={editing}
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
      />
    </div>
  )
}
