"use client"

import { useEffect, useState } from "react"
import { CopyIcon, PodcastIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react"
import { toast } from "sonner"

import { backend, type FeedsConfig } from "@/lib/backend"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ConfirmDialog } from "@/components/confirm-dialog"

function fmtBytes(n: number): string {
  if (!n) return "0 Mo"
  const mb = n / (1024 * 1024)
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} Go` : `${mb.toFixed(0)} Mo`
}

function maskToken(url: string): string {
  return url.replace(/token=([^&]{4})[^&]*([^&]{4})/, "token=$1••••$2")
}

export function FeedsCard() {
  const [cfg, setCfg] = useState<FeedsConfig | null>(null)
  const [regenOpen, setRegenOpen] = useState(false)

  useEffect(() => {
    backend.feedsConfig().then(setCfg).catch(() => {})
  }, [])

  if (!cfg) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <PodcastIcon className="size-4" /> Flux podcast
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Chargement…</p>
        </CardContent>
      </Card>
    )
  }

  async function save(patch: Parameters<typeof backend.saveFeedsConfig>[0]) {
    try {
      setCfg(await backend.saveFeedsConfig(patch))
    } catch {
      toast.error("Enregistrement impossible")
    }
  }

  async function regenerate() {
    try {
      await backend.regenerateFeedsToken()
      setCfg(await backend.feedsConfig())
      toast.success("Jeton régénéré — les anciennes URLs ne fonctionnent plus")
    } catch {
      toast.error("Régénération impossible")
    }
  }

  async function backfill() {
    try {
      const r = await backend.feedsBackfill()
      if (r.error) toast.error(r.error)
      else toast.success("Préparation de l'audio lancée")
    } catch {
      toast.error("Lancement impossible")
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <PodcastIcon className="size-4" /> Flux podcast
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-xs text-muted-foreground">
          Rendez chaque abonnement écoutable dans n&apos;importe quelle app de podcast, en audio.
          Activez le flux par abonnement dans son éditeur.
        </p>

        {!cfg.public_base_url && (
          <p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
            <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
            URL publique non configurée — renseignez-la dans Réglages → Digest pour générer des liens
            fonctionnels.
          </p>
        )}

        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium">Activer les flux podcast</p>
            <p className="text-xs text-muted-foreground">
              Prépare l&apos;audio des abonnements marqués « Flux podcast ».
            </p>
          </div>
          <Switch checked={cfg.enabled} onCheckedChange={(v) => save({ enabled: v })} />
        </div>

        {cfg.enabled && (
          <>
            <div className="grid grid-cols-3 gap-3 rounded-lg border border-border bg-muted/30 p-3 text-sm">
              <Stat label="Flux actifs" value={String(cfg.stats.active_feeds)} />
              <Stat label="Épisodes audio" value={String(cfg.stats.episodes_ready)} />
              <Stat label="Espace audio" value={fmtBytes(cfg.stats.audio_bytes)} />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label>Format audio</Label>
                <Select value={cfg.audio_format} onValueChange={(v) => save({ audio_format: v })}>
                  <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="m4a">m4a / AAC (compatible partout)</SelectItem>
                    <SelectItem value="opus">opus (plus léger)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Débit</Label>
                <Select value={cfg.bitrate} onValueChange={(v) => save({ bitrate: v })}>
                  <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="64k">64 kbps</SelectItem>
                    <SelectItem value="96k">96 kbps</SelectItem>
                    <SelectItem value="128k">128 kbps</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {cfg.all_feed_url && (
              <div className="flex flex-col gap-1.5">
                <Label>Flux agrégé (tous les abonnements podcast)</Label>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs text-muted-foreground">
                    {maskToken(cfg.all_feed_url)}
                  </code>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Copier l'URL du flux"
                    onClick={() =>
                      navigator.clipboard?.writeText(cfg.all_feed_url).then(
                        () => toast.success("URL du flux copiée"),
                        () => toast.error("Copie impossible"),
                      )
                    }
                  >
                    <CopyIcon />
                  </Button>
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 border-t pt-3">
              <Button size="sm" onClick={backfill}>
                <PodcastIcon className="size-4" data-icon="inline-start" /> Préparer l&apos;audio existant
              </Button>
              <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setRegenOpen(true)}>
                <RefreshCwIcon className="size-4" data-icon="inline-start" /> Régénérer le jeton
              </Button>
            </div>
          </>
        )}
      </CardContent>

      <ConfirmDialog
        open={regenOpen}
        onOpenChange={setRegenOpen}
        title="Régénérer le jeton des flux ?"
        description="Toutes les URLs de flux déjà partagées cesseront de fonctionner. Il faudra recopier les nouvelles URLs dans vos apps de podcast."
        confirmLabel="Régénérer"
        onConfirm={regenerate}
      />
    </Card>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-medium tabular-nums">{value}</p>
    </div>
  )
}
