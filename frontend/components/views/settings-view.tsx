"use client"

import {
  FolderIcon,
  GaugeIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
} from "lucide-react"

import { useStore } from "@/components/store-provider"
import { CookiesCard } from "@/components/cookies-card"
import { DiskCard } from "@/components/disk-card"
import { NotificationsCard } from "@/components/notifications-card"
import { QualitySelect, FormatSelect } from "@/components/option-selects"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PluginsPanel } from "@/components/plugins-panel"
import { IndexCard } from "@/components/index-card"
import { IntelligenceCard } from "@/components/intelligence-card"

function Row({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

export function SettingsView() {
  const {
    settings,
    updateSettings,
    maxConcurrent,
    setMaxConcurrent,
    bandwidthLimit,
    setBandwidthLimit,
  } = useStore()

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 p-4 sm:p-6 lg:p-8">
      <Tabs defaultValue="general" className="gap-5">
        <TabsList>
          <TabsTrigger value="general">Réglages</TabsTrigger>
          <TabsTrigger value="plugins">Plugins</TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="flex flex-col gap-5">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FolderIcon className="size-4" /> Général
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="dir">Dossier de téléchargement</Label>
            <Input
              id="dir"
              value={settings.downloadDir}
              onChange={(e) => updateSettings({ downloadDir: e.target.value })}
              placeholder="/downloads"
            />
            <p className="text-xs text-muted-foreground">
              Chemin dans le conteneur (monté sur votre machine via Docker).
            </p>
          </div>
          <Separator />
          <Row title="Qualité par défaut">
            <QualitySelect
              value={settings.defaultQuality}
              onChange={(v) => updateSettings({ defaultQuality: v })}
              size="sm"
            />
          </Row>
          <Row title="Format par défaut">
            <FormatSelect
              value={settings.defaultFormat}
              onChange={(v) => updateSettings({ defaultFormat: v })}
              size="sm"
            />
          </Row>
          <Row title="Organiser par sous-dossier" description="Un dossier par chaîne / playlist">
            <Switch
              checked={settings.organizeBySubfolder}
              onCheckedChange={(v) => updateSettings({ organizeBySubfolder: v })}
            />
          </Row>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <GaugeIcon className="size-4" /> Performance
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label>Téléchargements simultanés</Label>
              <span className="text-sm font-medium tabular-nums">{maxConcurrent}</span>
            </div>
            <Slider
              min={1}
              max={6}
              step={1}
              value={[maxConcurrent]}
              onValueChange={([v]) => setMaxConcurrent(v)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="bw">Limite de bande passante (MB/s, 0 = illimité)</Label>
            <Input
              id="bw"
              type="number"
              min={0}
              value={bandwidthLimit}
              onChange={(e) => setBandwidthLimit(Number(e.target.value))}
            />
          </div>
          <Row title="Intervalle de vérification des abonnements" description="Toutes les N heures">
            <Input
              type="number"
              min={1}
              className="w-24"
              value={Math.max(1, Math.round((settings as any).checkIntervalHours ?? 1))}
              onChange={(e) => updateSettings({ checkIntervalHours: Number(e.target.value) } as any)}
            />
          </Row>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <SlidersHorizontalIcon className="size-4" /> Options
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1">
          <Row title="Sous-titres" description="Télécharger les sous-titres disponibles">
            <Switch
              checked={settings.subtitles.enabled}
              onCheckedChange={(v) => updateSettings({ subtitles: { ...settings.subtitles, enabled: v } })}
            />
          </Row>
          <Row title="Intégrer la miniature">
            <Switch
              checked={settings.embedThumbnail}
              onCheckedChange={(v) => updateSettings({ embedThumbnail: v })}
            />
          </Row>
          <Row title="Intégrer les métadonnées">
            <Switch
              checked={settings.embedMetadata}
              onCheckedChange={(v) => updateSettings({ embedMetadata: v })}
            />
          </Row>
          <Row title="SponsorBlock" description="Sauter / marquer les segments sponsorisés">
            <Switch
              checked={settings.sponsorBlock}
              onCheckedChange={(v) => updateSettings({ sponsorBlock: v })}
            />
          </Row>
          <Row title="Archive de téléchargement" description="Ne jamais retélécharger un fichier déjà obtenu">
            <Switch
              checked={settings.downloadArchive}
              onCheckedChange={(v) => updateSettings({ downloadArchive: v })}
            />
          </Row>
          <Row
            title="Métadonnées Jellyfin / Plex"
            description="Écrire un .nfo + poster à côté de chaque vidéo"
          >
            <Switch
              checked={settings.nfoExport}
              onCheckedChange={(v) => updateSettings({ nfoExport: v })}
            />
          </Row>
        </CardContent>
      </Card>

      <IndexCard />

      <IntelligenceCard />

      <DiskCard />

      <CookiesCard />

      <NotificationsCard />

      <p className="flex items-center gap-1.5 text-center text-xs text-muted-foreground">
        <SettingsIcon className="size-3.5" />
        Les réglages pris en charge par le backend sont enregistrés automatiquement.
      </p>
        </TabsContent>

        <TabsContent value="plugins">
          <PluginsPanel />
        </TabsContent>
      </Tabs>
    </div>
  )
}
