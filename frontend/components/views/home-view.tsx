"use client"

import { useRef, useState } from "react"
import {
  ClipboardIcon,
  DownloadIcon,
  FileTextIcon,
  Loader2Icon,
  SparklesIcon,
  UploadIcon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import {
  detectSource,
  fetchUrlMetadata,
  readClipboardUrl,
} from "@/lib/api"
import type { VideoPreview } from "@/lib/types"
import { useStore } from "@/components/store-provider"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Skeleton } from "@/components/ui/skeleton"
import { Separator } from "@/components/ui/separator"
import { QualitySelect, FormatSelect } from "@/components/option-selects"
import { VideoPreviewCard } from "@/components/video-preview-card"
import type { View } from "@/components/app-shell"

export function HomeView({ onNavigate }: { onNavigate: (v: View) => void }) {
  const { settings, addDownload } = useStore()
  const [url, setUrl] = useState("")
  const [quality, setQuality] = useState(settings.defaultQuality)
  const [format, setFormat] = useState(settings.defaultFormat)
  const [loading, setLoading] = useState(false)
  const [preview, setPreview] = useState<VideoPreview | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkText, setBulkText] = useState("")
  const fileRef = useRef<HTMLInputElement>(null)

  async function loadPreview(value: string) {
    if (!value.trim()) return
    setLoading(true)
    setPreview(null)
    try {
      const meta = await fetchUrlMetadata(value)
      setPreview(meta)
    } finally {
      setLoading(false)
    }
  }

  function confirmDownload() {
    if (!preview) return
    addDownload({
      url,
      title: preview.title,
      thumbnail: preview.thumbnail,
      quality,
      format,
      channel: preview.channel,
    })
    setPreview(null)
    setUrl("")
    onNavigate("downloads")
  }

  async function pasteFromClipboard() {
    const clip = await readClipboardUrl()
    if (clip) {
      setUrl(clip)
      loadPreview(clip)
    } else {
      toast.error("Aucune URL valide dans le presse-papier")
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const text = e.dataTransfer.getData("text")
    if (text && /^https?:\/\//.test(text.trim())) {
      setUrl(text.trim())
      loadPreview(text.trim())
    } else {
      toast.error("Déposez une URL valide")
    }
  }

  function runBulkImport(raw: string) {
    const urls = raw
      .split(/[\n,\s]+/)
      .map((u) => u.trim())
      .filter((u) => /^https?:\/\//.test(u))
    if (urls.length === 0) {
      toast.error("Aucune URL valide trouvée")
      return
    }
    urls.forEach((u) =>
      addDownload({
        url: u,
        title: `Import — ${detectSource(u)}`,
        quality,
        format,
        channel: detectSource(u),
      }),
    )
    toast.success(`${urls.length} URL(s) ajoutée(s) à la file`)
    setBulkText("")
    setBulkOpen(false)
    onNavigate("downloads")
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const text = await file.text()
    runBulkImport(text)
    if (fileRef.current) fileRef.current.value = ""
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-4 sm:p-6 lg:p-8">
      {/* Hero */}
      <div className="flex flex-col items-center gap-3 pt-6 text-center sm:pt-10">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground">
          <SparklesIcon className="size-3.5 text-primary" />
          Téléchargement universel — YouTube, Vimeo, et 1000+ sites
        </span>
        <h2 className="text-pretty text-2xl font-semibold tracking-tight sm:text-3xl">
          Collez une URL, on s&apos;occupe du reste
        </h2>
        <p className="max-w-md text-balance text-sm text-muted-foreground">
          Choisissez la qualité et le format, puis lancez le téléchargement en un
          clic.
        </p>
      </div>

      {/* Search bar */}
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={cn(
          "rounded-xl border bg-card p-3 transition-colors",
          dragOver ? "border-primary ring-3 ring-primary/20" : "border-border",
        )}
      >
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="flex flex-1 items-center gap-2">
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && loadPreview(url)}
              placeholder="https://www.youtube.com/watch?v=…"
              className="h-10 flex-1 text-sm"
              aria-label="URL de la vidéo"
            />
            <Button
              variant="ghost"
              size="icon-lg"
              onClick={pasteFromClipboard}
              aria-label="Coller depuis le presse-papier"
            >
              <ClipboardIcon />
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <QualitySelect value={quality} onChange={setQuality} />
            <FormatSelect value={format} onChange={setFormat} />
            <Button
              size="lg"
              className="h-10"
              onClick={() => loadPreview(url)}
              disabled={!url.trim() || loading}
            >
              {loading ? (
                <Loader2Icon className="animate-spin" data-icon="inline-start" />
              ) : (
                <DownloadIcon data-icon="inline-start" />
              )}
              Télécharger
            </Button>
          </div>
        </div>
        <p className="mt-2 px-1 text-xs text-muted-foreground">
          Glissez-déposez une URL ici, ou collez plusieurs liens via l&apos;import
          en masse.
        </p>
      </div>

      {/* Preview / loading */}
      {loading && (
        <Card>
          <CardContent className="flex flex-col gap-3 sm:flex-row">
            <Skeleton className="aspect-video w-full rounded-lg sm:w-56" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-5 w-3/4" />
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          </CardContent>
        </Card>
      )}

      {preview && !loading && (
        <Card>
          <CardHeader>
            <CardTitle>Aperçu détecté</CardTitle>
            <CardDescription>
              Vérifiez les informations puis confirmez le téléchargement.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <VideoPreviewCard video={preview} />
            <Separator />
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2">
                <QualitySelect value={quality} onChange={setQuality} size="sm" />
                <FormatSelect value={format} onChange={setFormat} size="sm" />
              </div>
              <div className="flex items-center gap-2">
                <Button variant="ghost" onClick={() => setPreview(null)}>
                  Annuler
                </Button>
                <Button onClick={confirmDownload}>
                  <DownloadIcon data-icon="inline-start" />
                  Confirmer le téléchargement
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Bulk import */}
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-2">
          <div className="flex flex-col gap-1">
            <CardTitle className="flex items-center gap-2 text-base">
              <UploadIcon className="size-4" />
              Import en masse
            </CardTitle>
            <CardDescription>
              Collez plusieurs URLs (une par ligne) ou importez un fichier .txt
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setBulkOpen((o) => !o)}
          >
            {bulkOpen ? <XIcon data-icon="inline-start" /> : null}
            {bulkOpen ? "Fermer" : "Ouvrir"}
          </Button>
        </CardHeader>
        {bulkOpen && (
          <CardContent className="flex flex-col gap-3">
            <Textarea
              value={bulkText}
              onChange={(e) => setBulkText(e.target.value)}
              placeholder={"https://youtube.com/watch?v=…\nhttps://vimeo.com/…\nhttps://…"}
              className="min-h-32 font-mono text-xs"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => runBulkImport(bulkText)} disabled={!bulkText.trim()}>
                <DownloadIcon data-icon="inline-start" />
                Ajouter tout à la file
              </Button>
              <Button variant="outline" onClick={() => fileRef.current?.click()}>
                <FileTextIcon data-icon="inline-start" />
                Importer un .txt
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept=".txt"
                onChange={handleFile}
                className="hidden"
              />
            </div>
          </CardContent>
        )}
      </Card>
    </div>
  )
}
