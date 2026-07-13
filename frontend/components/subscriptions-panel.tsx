"use client"

import { useMemo, useState } from "react"
import {
  BellIcon,
  ClockIcon,
  CopyIcon,
  ListFilterIcon,
  ListVideoIcon,
  PodcastIcon,
  RefreshCwIcon,
  SettingsIcon,
  Trash2Icon,
  TriangleAlertIcon,
  TvIcon,
} from "lucide-react"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import type { Subscription } from "@/lib/types"
import { backend, type WatchFeedStatus } from "@/lib/backend"
import { useStore } from "@/components/store-provider"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Switch } from "@/components/ui/switch"
import { InlineFeedback } from "@/components/inline-feedback"
import { ConfirmDialog } from "@/components/confirm-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SubscriptionEditor } from "@/components/subscription-editor"

type SortKey = "recent" | "alpha"

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
  const [removing, setRemoving] = useState<Subscription | null>(null)
  const [sort, setSort] = useState<SortKey>("recent")
  const [showChannels, setShowChannels] = useState(true)
  const [showPlaylists, setShowPlaylists] = useState(true)

  const visible = useMemo(() => {
    const filtered = subscriptions.filter((sub) =>
      sub.type === "channel" ? showChannels : showPlaylists
    )
    if (sort === "alpha") {
      return [...filtered].sort((a, b) =>
        a.name.localeCompare(b.name, "fr", { sensitivity: "base" })
      )
    }
    // "recent": most recently checked first.
    return [...filtered].sort(
      (a, b) => new Date(b.lastChecked).getTime() - new Date(a.lastChecked).getTime()
    )
  }, [subscriptions, sort, showChannels, showPlaylists])

  if (subscriptions.length === 0) {
    return (
      <InlineFeedback
        state="empty"
        icon={BellIcon}
        title="Aucun abonnement"
        description="Suivez une chaîne ou une playlist depuis l'onglet Explorer pour télécharger automatiquement les nouvelles vidéos."
      />
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {visible.length} sur {subscriptions.length} abonnement{subscriptions.length > 1 ? "s" : ""}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button size="sm" variant="outline">
                <ListFilterIcon data-icon="inline-start" />
                Trier &amp; filtrer
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Trier</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={sort}
                onValueChange={(v) => setSort(v as SortKey)}
              >
                <DropdownMenuRadioItem value="recent">
                  Récents
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="alpha">
                  Ordre alphabétique
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Afficher</DropdownMenuLabel>
              <DropdownMenuCheckboxItem
                checked={showChannels}
                onCheckedChange={(c) => setShowChannels(c)}
                closeOnClick={false}
              >
                <TvIcon />
                Chaînes
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={showPlaylists}
                onCheckedChange={(c) => setShowPlaylists(c)}
                closeOnClick={false}
              >
                <ListVideoIcon />
                Playlists
              </DropdownMenuCheckboxItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {visible.length === 0 ? (
        <InlineFeedback
          state="empty"
          icon={ListFilterIcon}
          title="Aucun résultat"
          description="Aucun abonnement ne correspond au filtre sélectionné."
        />
      ) : null}

      {visible.map((sub) => {
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
                {sub.lastCheck && (sub.lastCheck.listed > 0 || sub.lastCheck.downloaded > 0) && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {sub.lastCheck.listed} listée{sub.lastCheck.listed > 1 ? "s" : ""} ·{" "}
                    {sub.lastCheck.rejectedByFilters} filtrée
                    {sub.lastCheck.rejectedByFilters > 1 ? "s" : ""} ·{" "}
                    {sub.lastCheck.downloaded} téléchargée
                    {sub.lastCheck.downloaded > 1 ? "s" : ""}
                  </p>
                )}
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
              {sub.podcastFeed && <PodcastFeedButton sub={sub} />}
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto text-destructive"
                onClick={() => setRemoving(sub)}
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

      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Retirer l'abonnement ?"
        description={
          removing
            ? `« ${removing.name} » ne sera plus synchronisé. Les vidéos déjà téléchargées sont conservées.`
            : undefined
        }
        confirmLabel="Retirer"
        onConfirm={() => removing && removeSubscription(removing.id)}
      />
    </div>
  )
}

/** Per-subscription podcast feed popover: shows the token URL (masked), copy,
 *  revoke hint, and a backfill link when episodes still lack audio. */
function PodcastFeedButton({ sub }: { sub: Subscription }) {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<WatchFeedStatus | null>(null)

  function load() {
    setOpen(true)
    setStatus(null)
    backend.watchFeedStatus(sub.id).then(setStatus).catch(() => {})
  }

  const masked = status?.url.replace(/token=([^&]{4})[^&]*([^&]{4})/, "token=$1••••$2") ?? ""

  return (
    <>
      <Button size="sm" variant="ghost" onClick={load}>
        <PodcastIcon data-icon="inline-start" /> Flux podcast
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Flux podcast — {sub.name}</DialogTitle>
            <DialogDescription>
              Collez cette URL dans votre app de podcast (AntennaPod, Overcast, Apple Podcasts…).
            </DialogDescription>
          </DialogHeader>
          {!status ? (
            <p className="text-sm text-muted-foreground">Chargement…</p>
          ) : !status.has_base ? (
            <p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
              <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
              URL publique non configurée — renseignez-la dans Réglages → Digest pour générer le lien.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs text-muted-foreground">
                  {masked}
                </code>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Copier l'URL du flux"
                  onClick={() =>
                    navigator.clipboard?.writeText(status.url).then(
                      () => toast.success("URL du flux copiée"),
                      () => toast.error("Copie impossible"),
                    )
                  }
                >
                  <CopyIcon />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {status.episodes_ready} épisode(s) audio prêt(s). Toute personne possédant ce lien peut
                écouter — régénérez le jeton (Réglages → Flux podcast) pour le révoquer.
              </p>
              {status.missing_count > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  className="w-fit"
                  onClick={() =>
                    backend.feedsBackfill(sub.id).then(
                      () => toast.success(`Préparation de l'audio lancée (${status.missing_count} épisode(s))`),
                      () => toast.error("Lancement impossible"),
                    )
                  }
                >
                  <PodcastIcon data-icon="inline-start" /> Préparer l&apos;audio manquant ({status.missing_count})
                </Button>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
