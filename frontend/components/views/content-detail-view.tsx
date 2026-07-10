"use client"

import { useEffect, useRef, useState } from "react"
import {
  ArrowLeftIcon,
  CopyIcon,
  ExternalLinkIcon,
  FileTextIcon,
  RotateCcwIcon,
  TriangleAlertIcon,
  Trash2Icon,
} from "lucide-react"
import { toast } from "sonner"

import { backend, type Content } from "@/lib/backend"
import type { View } from "@/components/app-shell"
import { useStore } from "@/components/store-provider"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { SourceBadge } from "@/components/source-badge"
import { InlineFeedback } from "@/components/inline-feedback"

function fmtDuration(sec: number | null): string {
  if (!sec) return ""
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`
}

function fmtUploaded(yyyymmdd: string): string {
  if (yyyymmdd && yyyymmdd.length === 8) return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`
  return yyyymmdd || ""
}

export function ContentDetailView({
  contentId,
  startAt,
  onBack,
  onNavigate,
}: {
  contentId: string
  startAt?: number
  onBack: () => void
  onNavigate: (v: View) => void
}) {
  const { addDownload, settings } = useStore()
  const [content, setContent] = useState<Content | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [descOpen, setDescOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const mediaRef = useRef<HTMLVideoElement & HTMLAudioElement>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    backend
      .libraryItem(contentId)
      .then((c) => {
        if (!alive) return
        if ((c as { error?: string }).error) setNotFound(true)
        else setContent(c)
      })
      .catch(() => alive && setNotFound(true))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [contentId])

  // Keyboard shortcuts: space = play/pause, ←/→ = ±5 s. Ignored while typing.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = mediaRef.current
      if (!el) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return
      if (e.key === " ") {
        e.preventDefault()
        el.paused ? el.play().catch(() => {}) : el.pause()
      } else if (e.key === "ArrowLeft") {
        el.currentTime = Math.max(0, el.currentTime - 5)
      } else if (e.key === "ArrowRight") {
        el.currentTime = Math.min(el.duration || Infinity, el.currentTime + 5)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  function onLoadedMetadata() {
    const el = mediaRef.current
    if (el && startAt && startAt > 0) {
      el.currentTime = startAt
      el.play().catch(() => {})
    }
  }

  function copyPath() {
    if (!content) return
    navigator.clipboard?.writeText(content.filepath).then(
      () => toast.success("Chemin copié"),
      () => toast.error("Copie impossible"),
    )
  }

  function redownload() {
    if (!content) return
    addDownload({
      url: content.url,
      title: content.title,
      thumbnail: content.thumbnail_url ?? "",
      quality: settings.defaultQuality,
      format: settings.defaultFormat,
      channel: content.channel,
    })
    toast.info("Re-téléchargement lancé")
  }

  async function doDelete(deleteFile: boolean) {
    if (!content) return
    setDeleting(true)
    try {
      const res = await backend.deleteContent(content.id, deleteFile)
      if (res.error) toast.error(res.error)
      else {
        toast.success(deleteFile ? "Contenu et fichier supprimés" : "Contenu retiré de la bibliothèque")
        setDeleteOpen(false)
        onBack()
      }
    } catch {
      toast.error("Suppression impossible")
    } finally {
      setDeleting(false)
    }
  }

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-4xl p-4 sm:p-6 lg:p-8">
        <InlineFeedback state="loading" rows={4} />
      </div>
    )
  }
  if (notFound || !content) {
    return (
      <div className="mx-auto w-full max-w-4xl p-4 sm:p-6 lg:p-8">
        <Button variant="ghost" size="sm" onClick={onBack} className="mb-4">
          <ArrowLeftIcon data-icon="inline-start" /> Retour
        </Button>
        <InlineFeedback state="error" title="Contenu introuvable" description="Cette entrée n'existe plus." />
      </div>
    )
  }

  const missing = !content.file_exists

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4 sm:p-6 lg:p-8">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeftIcon data-icon="inline-start" /> Bibliothèque
        </Button>
      </div>

      {/* Player */}
      {missing ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-muted/30 p-8 text-center">
          <TriangleAlertIcon className="size-8 text-warning" />
          <div>
            <p className="text-sm font-medium">Fichier introuvable sur le disque</p>
            <p className="text-xs text-muted-foreground">
              L&apos;entrée existe mais le média a été déplacé ou supprimé.
            </p>
          </div>
          <Button size="sm" onClick={redownload} disabled={!content.url}>
            <RotateCcwIcon data-icon="inline-start" /> Re-télécharger
          </Button>
        </div>
      ) : content.kind === "audio" ? (
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
          {content.thumbnail_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={content.thumbnail_url}
              alt=""
              className="mx-auto aspect-square w-40 rounded-lg object-cover"
            />
          )}
          <audio
            ref={mediaRef}
            src={content.stream_url}
            controls
            onLoadedMetadata={onLoadedMetadata}
            className="w-full"
          />
        </div>
      ) : (
        <video
          ref={mediaRef}
          src={content.stream_url}
          poster={content.thumbnail_url ?? undefined}
          controls
          onLoadedMetadata={onLoadedMetadata}
          className="aspect-video w-full overflow-hidden rounded-xl bg-black"
        />
      )}

      {/* Header metadata */}
      <div className="flex flex-col gap-2">
        <div className="flex items-start gap-2">
          <h1 className="flex-1 text-lg font-semibold leading-snug">{content.title}</h1>
          {missing && (
            <Badge className="shrink-0 gap-1 border-warning/30 bg-warning/15 text-warning">
              <TriangleAlertIcon className="size-3" /> Fichier introuvable
            </Badge>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <SourceBadge source={content.source} className="text-[10px]" />
          {content.channel && (
            content.channel_url ? (
              <a href={content.channel_url} target="_blank" rel="noreferrer" className="hover:text-foreground">
                {content.channel}
              </a>
            ) : (
              <span>{content.channel}</span>
            )
          )}
          {content.uploaded_at && <span>· {fmtUploaded(content.uploaded_at)}</span>}
          {content.duration_seconds ? <span>· {fmtDuration(content.duration_seconds)}</span> : null}
          {content.url && (
            <a
              href={content.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 hover:text-foreground"
            >
              <ExternalLinkIcon className="size-3.5" /> Ouvrir l&apos;original
            </a>
          )}
        </div>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs text-muted-foreground">
            {content.filepath}
          </code>
          <Button size="icon-sm" variant="ghost" onClick={copyPath} aria-label="Copier le chemin">
            <CopyIcon />
          </Button>
        </div>
      </div>

      <Separator />

      {/* Tabs — structured so adding Résumé / Chat later is trivial. */}
      <Tabs defaultValue="apercu" className="gap-4">
        <TabsList>
          <TabsTrigger value="apercu">Aperçu</TabsTrigger>
          <TabsTrigger value="transcript">Transcript</TabsTrigger>
        </TabsList>

        <TabsContent value="apercu" className="flex flex-col gap-3">
          {content.description ? (
            <div>
              <p
                className={
                  descOpen
                    ? "whitespace-pre-wrap text-sm text-muted-foreground"
                    : "line-clamp-4 whitespace-pre-wrap text-sm text-muted-foreground"
                }
              >
                {content.description}
              </p>
              <button
                type="button"
                onClick={() => setDescOpen((o) => !o)}
                className="mt-1 text-xs font-medium text-primary hover:underline"
              >
                {descOpen ? "Réduire" : "Afficher plus"}
              </button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Aucune description.</p>
          )}
        </TabsContent>

        <TabsContent value="transcript">
          <InlineFeedback
            state="empty"
            icon={FileTextIcon}
            title="Disponible après transcription"
            description="La transcription de ce contenu apparaîtra ici une fois la fonctionnalité activée."
          />
        </TabsContent>
      </Tabs>

      <Separator />

      {/* Actions */}
      <div className="flex items-center gap-2">
        <Button variant="destructive" size="sm" onClick={() => setDeleteOpen(true)}>
          <Trash2Icon data-icon="inline-start" /> Supprimer
        </Button>
      </div>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Supprimer ce contenu ?</DialogTitle>
            <DialogDescription>
              Choisissez de retirer seulement l&apos;entrée de la bibliothèque, ou de
              supprimer aussi le fichier du disque (irréversible).
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col gap-2 sm:flex-col sm:items-stretch">
            <Button variant="outline" onClick={() => doDelete(false)} disabled={deleting}>
              Retirer l&apos;entrée seulement (garder le fichier)
            </Button>
            <Button variant="destructive" onClick={() => doDelete(true)} disabled={deleting}>
              <Trash2Icon data-icon="inline-start" /> Supprimer l&apos;entrée + le fichier
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
