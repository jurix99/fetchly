"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowLeftIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileTextIcon,
  HighlighterIcon,
  Loader2Icon,
  PlayIcon,
  QuoteIcon,
  RotateCcwIcon,
  ScissorsIcon,
  SearchIcon,
  SparklesIcon,
  StickyNoteIcon,
  TriangleAlertIcon,
  Trash2Icon,
  WandSparklesIcon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import {
  backend,
  type Chapter,
  type Clip,
  type Content,
  type Highlight,
  type RelatedResult,
  type TranscriptDetail,
} from "@/lib/backend"
import { savePlaybackPosition } from "@/lib/playback"
import type { View } from "@/components/app-shell"
import { useStore } from "@/components/store-provider"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
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
  onOpenContent,
}: {
  contentId: string
  startAt?: number
  onBack: () => void
  onNavigate: (v: View) => void
  onOpenContent: (id: string, startAt?: number, queryHash?: string) => void
}) {
  const { addDownload, settings } = useStore()
  const [content, setContent] = useState<Content | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  // Arriving via a jump (startAt set) lands on the Transcript so the segment
  // that matched is visible and pulses. Otherwise show the overview.
  const [tab, setTab] = useState<string>(startAt !== undefined ? "transcript" : "apercu")
  // Segment to pulse-highlight: the real phrase, i.e. after the 2 s recall.
  const [pulseMs, setPulseMs] = useState<number | null>(
    startAt !== undefined ? Math.round((startAt + 2) * 1000) : null,
  )
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [providerOn, setProviderOn] = useState<boolean | null>(null)
  const [highlights, setHighlights] = useState<Highlight[]>([])
  const [clips, setClips] = useState<Clip[]>([])
  const [clipBounds, setClipBounds] = useState<{ start_ms: number; end_ms: number } | null>(null)
  const [publicBase, setPublicBase] = useState("")
  const mediaRef = useRef<HTMLVideoElement & HTMLAudioElement>(null)
  const lastSaved = useRef(0)

  // Stable so the transcript's pulse timer isn't reset on every timeupdate render.
  const clearPulse = useCallback(() => setPulseMs(null), [])

  /** Seek + play only — no tab switch (used by chapter markers). */
  const playAt = useCallback((seconds: number) => {
    const el = mediaRef.current
    if (el) {
      el.currentTime = seconds
      el.play().catch(() => {})
    }
  }, [])

  /** Seek + play, and pulse/scroll the transcript segment at that moment. */
  function seek(seconds: number) {
    playAt(seconds)
    setTab("transcript")
    setPulseMs(Math.round(seconds * 1000))
  }

  // Chapters (LLM-generated) + whether an AI provider is configured (empty-state).
  useEffect(() => {
    let alive = true
    setChapters([])
    backend.getChapters(contentId).then((r) => alive && setChapters(r.chapters)).catch(() => {})
    backend.intelligence().then((s) => alive && setProviderOn(s.preset !== "none")).catch(() => alive && setProviderOn(false))
    return () => {
      alive = false
    }
  }, [contentId])

  // Highlights + clips + the public base URL (for shareable citations).
  const refreshHighlights = useCallback(() => {
    backend.highlights(contentId, 200, 0, "position").then((r) => setHighlights(r.items)).catch(() => {})
  }, [contentId])
  const refreshClips = useCallback(() => {
    backend.listClips(contentId).then((r) => setClips(r.clips)).catch(() => {})
  }, [contentId])
  useEffect(() => {
    setHighlights([])
    setClips([])
    refreshHighlights()
    refreshClips()
    backend.digestSettings().then((s) => setPublicBase(s.public_base_url || "")).catch(() => {})
  }, [contentId, refreshHighlights, refreshClips])

  const createHighlight = useCallback(
    async (start_ms: number, end_ms: number): Promise<Highlight | null> => {
      const hl = await backend.createHighlight(contentId, start_ms, end_ms)
      if ("error" in hl && hl.error) {
        toast.error(hl.error)
        return null
      }
      setHighlights((prev) => [...prev, hl as Highlight].sort((a, b) => a.start_ms - b.start_ms))
      return hl as Highlight
    },
    [contentId],
  )
  const removeHighlight = useCallback((id: number) => {
    setHighlights((prev) => prev.filter((h) => h.id !== id))
    backend.deleteHighlight(id).catch(() => {})
  }, [])
  const setHighlightNote = useCallback(async (id: number, note: string) => {
    const hl = await backend.updateHighlightNote(id, note || null)
    if (!("error" in hl && hl.error)) {
      setHighlights((prev) => prev.map((h) => (h.id === id ? (hl as Highlight) : h)))
    }
  }, [])

  /** Build a sourced citation and copy it. Uses the public base URL when set,
   *  else the current origin (with a hint to configure one for sharing). */
  const copyCitation = useCallback(
    (start_ms: number, text: string) => {
      const c = content
      if (!c) return
      const sec = Math.floor(start_ms / 1000)
      const mmss = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`
      const base = publicBase || (typeof window !== "undefined" ? window.location.origin : "")
      const link = `${base.replace(/\/$/, "")}/?content=${c.id}&t=${sec}`
      const citation = `« ${text} » — ${c.channel}, « ${c.title} » (${mmss})\n${link}`
      navigator.clipboard?.writeText(citation).then(
        () => {
          toast.success("Citation copiée")
          if (!publicBase) toast.info("Configurez l'URL publique (Réglages → Digest) pour des liens partageables.")
        },
        () => toast.error("Copie impossible"),
      )
    },
    [content, publicBase],
  )

  // Poll while a summary is being generated, then refresh content + chapters.
  const genStatus = content?.generation_status
  useEffect(() => {
    if (genStatus !== "queued" && genStatus !== "running") return
    const t = setInterval(async () => {
      try {
        const c = await backend.libraryItem(contentId)
        if (!("error" in c && c.error)) {
          setContent(c as Content)
          if ((c as Content).generation_status === "done") {
            backend.getChapters(contentId).then((r) => setChapters(r.chapters)).catch(() => {})
          }
        }
      } catch {
        /* keep polling */
      }
    }, 3000)
    return () => clearInterval(t)
  }, [genStatus, contentId])

  async function regenerate() {
    setContent((c) => (c ? { ...c, generation_status: "queued" } : c))
    try {
      const r = await backend.generateContent(contentId)
      if (r.error) {
        toast.error(r.error)
        setContent((c) => (c ? { ...c, generation_status: "error" } : c))
      } else {
        toast.info("Génération lancée")
      }
    } catch {
      toast.error("Génération impossible")
    }
  }

  // Persist the playback position (throttled) so the Library "Reprendre" block
  // and resume-on-open work. Purely local (localStorage).
  function onTimeUpdate(e: React.SyntheticEvent<HTMLMediaElement>) {
    const el = e.currentTarget
    setCurrentTime(el.currentTime)
    const now = Date.now()
    if (now - lastSaved.current > 4000) {
      lastSaved.current = now
      savePlaybackPosition(contentId, el.currentTime, el.duration || 0)
    }
  }

  useEffect(() => {
    return () => {
      const el = mediaRef.current
      if (el && el.currentTime > 0) {
        savePlaybackPosition(contentId, el.currentTime, el.duration || 0)
      }
    }
  }, [contentId])

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
            onTimeUpdate={onTimeUpdate}
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
          onTimeUpdate={onTimeUpdate}
          className="aspect-video w-full overflow-hidden rounded-xl bg-black"
        />
      )}

      {/* Clickable chapter markers along the timeline. */}
      {chapters.length > 0 && content.duration_seconds ? (
        <ChapterBar
          chapters={chapters}
          durationSec={content.duration_seconds}
          currentTime={currentTime}
          onSeek={playAt}
        />
      ) : null}

      {highlights.length > 0 && content.duration_seconds ? (
        <HighlightBar
          highlights={highlights}
          durationSec={content.duration_seconds}
          onSeek={playAt}
        />
      ) : null}

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
      <Tabs value={tab} onValueChange={setTab} className="gap-4">
        <TabsList>
          <TabsTrigger value="apercu">Aperçu</TabsTrigger>
          <TabsTrigger value="transcript">Transcript</TabsTrigger>
        </TabsList>

        <TabsContent value="apercu" className="flex flex-col gap-4">
          <SummaryPanel
            content={content}
            providerOn={providerOn}
            onRegenerate={regenerate}
            onNavigate={onNavigate}
          />

          {chapters.length > 0 && (
            <ChaptersList chapters={chapters} currentTime={currentTime} onSeek={playAt} />
          )}

          {clips.length > 0 && <ClipsBlock clips={clips} />}

          {/* Original description, secondary to the summary. */}
          {content.description ? (
            <details className="group">
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
                Description originale
              </summary>
              <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
                {content.description}
              </p>
            </details>
          ) : null}
        </TabsContent>

        <TabsContent value="transcript">
          <TranscriptTab
            contentId={content.id}
            currentTime={currentTime}
            pulseMs={pulseMs}
            onPulseDone={clearPulse}
            onSeek={seek}
            onNavigate={onNavigate}
            highlights={highlights}
            onCreateHighlight={createHighlight}
            onRemoveHighlight={removeHighlight}
            onSetNote={setHighlightNote}
            onCitation={copyCitation}
            onOpenClip={(start_ms, end_ms) => setClipBounds({ start_ms, end_ms })}
          />
        </TabsContent>
      </Tabs>

      {/* First crossing of the memory: other contents in the user's library. */}
      <RelatedSection contentId={content.id} onSeek={seek} onOpenContent={onOpenContent} />

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

      {clipBounds && (
        <ClipDialog
          contentId={content.id}
          bounds={clipBounds}
          onClose={() => setClipBounds(null)}
          onCreated={refreshClips}
        />
      )}
    </div>
  )
}

function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

function highlight(text: string, needle: string) {
  if (!needle) return text
  const i = text.toLowerCase().indexOf(needle)
  if (i < 0) return text
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded bg-warning/40 text-foreground">{text.slice(i, i + needle.length)}</mark>
      {text.slice(i + needle.length)}
    </>
  )
}

/** Transcript tab: segment list with clickable timestamps (seek), karaoke
 *  highlight following playback, local search, copy + .srt/.vtt download. */
function TranscriptTab({
  contentId,
  currentTime,
  pulseMs,
  onPulseDone,
  onSeek,
  onNavigate,
  highlights,
  onCreateHighlight,
  onRemoveHighlight,
  onSetNote,
  onCitation,
  onOpenClip,
}: {
  contentId: string
  currentTime: number
  pulseMs: number | null
  onPulseDone: () => void
  onSeek: (seconds: number) => void
  onNavigate: (v: View) => void
  highlights: Highlight[]
  onCreateHighlight: (start_ms: number, end_ms: number) => Promise<Highlight | null>
  onRemoveHighlight: (id: number) => void
  onSetNote: (id: number, note: string) => void
  onCitation: (start_ms: number, text: string) => void
  onOpenClip: (start_ms: number, end_ms: number) => void
}) {
  const [data, setData] = useState<TranscriptDetail | null>(null)
  const [pluginEnabled, setPluginEnabled] = useState(true)
  const [q, setQ] = useState("")
  const [autoScroll, setAutoScroll] = useState(true)
  const [busy, setBusy] = useState(false)
  const [pulseIdx, setPulseIdx] = useState<number | null>(null)
  // Text selection → floating toolbar; note popover for a clicked highlight.
  const [sel, setSel] = useState<{ start_ms: number; end_ms: number; text: string; x: number; y: number } | null>(null)
  const [notePop, setNotePop] = useState<{ highlight: Highlight; x: number; y: number } | null>(null)
  const activeRef = useRef<HTMLButtonElement>(null)
  const pulseRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const rowRefs = useRef<Record<number, HTMLElement | null>>({})

  const load = useCallback(async () => {
    try {
      setData(await backend.getTranscript(contentId))
    } catch {
      /* keep previous */
    }
  }, [contentId])

  useEffect(() => {
    load()
    backend.transcriptsStatus().then((s) => setPluginEnabled(s.enabled)).catch(() => {})
  }, [load])

  // Poll while a transcription is in progress.
  useEffect(() => {
    const st = data?.status
    if (st === "queued" || st === "running") {
      const t = setInterval(load, 3000)
      return () => clearInterval(t)
    }
  }, [data?.status, load])

  const segments = data?.segments ?? []
  const curMs = currentTime * 1000
  const activeIdx = useMemo(
    () => segments.findIndex((s) => curMs >= s.start_ms && curMs < s.end_ms),
    [segments, curMs],
  )

  useEffect(() => {
    if (autoScroll && activeRef.current) {
      activeRef.current.scrollIntoView({ block: "nearest", behavior: "smooth" })
    }
  }, [activeIdx, autoScroll])

  // Jump-to-second: pulse the segment matching `pulseMs`, scroll it into view,
  // then clear the pulse after 2 s. Runs once segments are loaded.
  useEffect(() => {
    if (pulseMs == null || segments.length === 0) return
    const idx = segments.findIndex((s) => pulseMs >= s.start_ms && pulseMs < s.end_ms)
    const target = idx >= 0 ? idx : segments.findIndex((s) => s.start_ms >= pulseMs)
    if (target < 0) return
    setPulseIdx(target)
    const t = setTimeout(() => {
      setPulseIdx(null)
      onPulseDone()
    }, 2000)
    return () => clearTimeout(t)
  }, [pulseMs, segments, onPulseDone])

  useEffect(() => {
    if (pulseIdx != null) {
      pulseRef.current?.scrollIntoView({ block: "center", behavior: "smooth" })
    }
  }, [pulseIdx])

  // Map each segment index to the highlight covering it (+ the first segment of
  // each highlight, where the note affordance is anchored).
  const segHl = useMemo(() => {
    const covered: (Highlight | null)[] = segments.map(() => null)
    const startAt = new Map<number, Highlight>()
    for (const h of highlights) {
      let first = -1
      segments.forEach((s, i) => {
        if (h.start_ms < s.end_ms && h.end_ms > s.start_ms) {
          covered[i] = h
          if (first < 0) first = i
        }
      })
      if (first >= 0) startAt.set(first, h)
    }
    return { covered, startAt }
  }, [segments, highlights])

  /** On mouse/touch release, map the DOM selection to the covered segment span
   *  and show the contextual toolbar. Never sends the DOM text to the server. */
  const onSelect = useCallback(() => {
    const s = window.getSelection?.()
    if (!s || s.isCollapsed || s.rangeCount === 0) {
      setSel(null)
      return
    }
    const range = s.getRangeAt(0)
    if (!listRef.current || !listRef.current.contains(range.commonAncestorContainer)) return
    const covered: number[] = []
    for (const [idxStr, el] of Object.entries(rowRefs.current)) {
      if (el && range.intersectsNode(el)) covered.push(Number(idxStr))
    }
    if (covered.length === 0) return
    const lo = Math.min(...covered)
    const hi = Math.max(...covered)
    const text = segments.slice(lo, hi + 1).map((seg) => seg.text.trim()).filter(Boolean).join(" ")
    const rect = range.getBoundingClientRect()
    setSel({
      start_ms: segments[lo].start_ms,
      end_ms: segments[hi].end_ms,
      text,
      x: rect.left + rect.width / 2,
      y: rect.top,
    })
  }, [segments])

  const clearSelection = useCallback(() => {
    window.getSelection?.()?.removeAllRanges()
    setSel(null)
  }, [])

  async function transcribe() {
    setBusy(true)
    try {
      const r = await backend.transcribeContent(contentId)
      if (r.error) toast.error(r.error)
      else toast.success("Transcription lancée")
      await load()
    } finally {
      setBusy(false)
    }
  }

  if (!data) return <InlineFeedback state="loading" rows={4} />

  const st = data.status
  if (st === "queued" || st === "running") {
    return (
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-4">
        <div className="flex items-center gap-2 text-sm text-primary">
          <Loader2Icon className="size-4 animate-spin" />
          {st === "queued" ? "En file de transcription…" : "Transcription en cours…"}
        </div>
        <Progress value={data.job?.progress ?? 0} />
      </div>
    )
  }
  if (st === "error") {
    return (
      <InlineFeedback
        state="error"
        title="Échec de la transcription"
        description={data.job?.error || "Une erreur est survenue."}
        action={
          <Button size="sm" variant="outline" onClick={transcribe} disabled={busy}>
            <RotateCcwIcon data-icon="inline-start" /> Réessayer
          </Button>
        }
      />
    )
  }
  if (segments.length === 0) {
    return pluginEnabled ? (
      <InlineFeedback
        state="empty"
        icon={FileTextIcon}
        title="Pas encore de transcription"
        description="Générez la transcription pour obtenir des sous-titres et une recherche horodatée."
        action={
          <Button size="sm" onClick={transcribe} disabled={busy}>
            <FileTextIcon data-icon="inline-start" /> Transcrire maintenant
          </Button>
        }
      />
    ) : (
      <InlineFeedback
        state="empty"
        icon={FileTextIcon}
        title="Plugin Whisper désactivé"
        description="Activez le plugin de transcription dans les réglages pour transcrire ce contenu."
        action={
          <Button size="sm" variant="outline" onClick={() => onNavigate("settings")}>
            Activer le plugin Whisper
          </Button>
        }
      />
    )
  }

  const needle = q.trim().toLowerCase()
  const rows = segments
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => !needle || s.text.toLowerCase().includes(needle))

  return (
    <div className="flex flex-col gap-2">
      {data.source_subs && (
        <p className="text-xs text-muted-foreground">
          Sous-titres source utilisés (ce contenu a été ignoré par la transcription).
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-40 flex-1">
          <SearchIcon className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Rechercher dans le transcript…"
            className="h-8 pl-8 text-sm"
          />
        </div>
        <Button
          size="sm"
          variant={autoScroll ? "secondary" : "ghost"}
          onClick={() => setAutoScroll((a) => !a)}
        >
          Suivi auto
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            navigator.clipboard
              ?.writeText(segments.map((s) => s.text).join("\n"))
              .then(() => toast.success("Transcript copié"), () => toast.error("Copie impossible"))
          }
        >
          <CopyIcon data-icon="inline-start" /> Copier
        </Button>
        {data.srt_url && (
          <Button size="sm" variant="ghost" render={<a href={data.srt_url} download />}>
            <DownloadIcon data-icon="inline-start" /> .srt
          </Button>
        )}
        {data.vtt_url && (
          <Button size="sm" variant="ghost" render={<a href={data.vtt_url} download />}>
            <DownloadIcon data-icon="inline-start" /> .vtt
          </Button>
        )}
      </div>

      <p className="text-[11px] text-muted-foreground">
        Sélectionnez un passage pour le surligner, l&apos;annoter, le citer ou en extraire un clip.
      </p>

      <div
        ref={listRef}
        onMouseUp={onSelect}
        onTouchEnd={onSelect}
        className="flex max-h-[55vh] flex-col overflow-y-auto rounded-lg border border-border"
      >
        {rows.map(({ s, i }) => {
          const hl = segHl.covered[i]
          const noteAnchor = segHl.startAt.get(i)
          return (
            <div
              key={i}
              ref={(el) => {
                rowRefs.current[i] = el
                if (i === activeIdx) activeRef.current = el as HTMLButtonElement | null
                if (i === pulseIdx) pulseRef.current = el as HTMLButtonElement | null
              }}
              className={cn(
                "flex items-start gap-2 border-b border-border/50 px-3 py-1.5 text-sm transition-colors last:border-0",
                i === activeIdx && "bg-primary/10",
                i === pulseIdx && "animate-seek-pulse",
                hl && "bg-warning/15 dark:bg-warning/20",
              )}
            >
              {/* Timestamp = the seek control (a real button). */}
              <button
                type="button"
                onClick={() => onSeek(s.start_ms / 1000)}
                aria-label={`Aller à ${fmtMs(s.start_ms)}`}
                className="shrink-0 pt-0.5 font-mono text-xs tabular-nums text-primary hover:underline"
              >
                {fmtMs(s.start_ms)}
              </button>
              {/* Text = freely selectable; a plain click (no selection) seeks. */}
              <span
                onClick={() => {
                  const s2 = window.getSelection?.()
                  if (!s2 || s2.isCollapsed) onSeek(s.start_ms / 1000)
                }}
                className="min-w-0 flex-1 cursor-text select-text text-foreground/90"
              >
                {highlight(s.text, needle)}
              </span>
              {noteAnchor && (
                <button
                  type="button"
                  aria-label={noteAnchor.note ? "Voir la note" : "Ajouter une note"}
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect()
                    setNotePop({ highlight: noteAnchor, x: r.left, y: r.bottom })
                  }}
                  className={cn(
                    "mt-0.5 shrink-0",
                    noteAnchor.note ? "text-warning" : "text-muted-foreground/50 hover:text-foreground",
                  )}
                >
                  <StickyNoteIcon className={cn("size-3.5", noteAnchor.note && "fill-warning/30")} />
                </button>
              )}
            </div>
          )
        })}
        {rows.length === 0 && (
          <p className="p-3 text-center text-sm text-muted-foreground">Aucun résultat.</p>
        )}
      </div>

      {/* Contextual selection toolbar */}
      {sel && (
        <SelectionToolbar
          sel={sel}
          onHighlight={async () => {
            await onCreateHighlight(sel.start_ms, sel.end_ms)
            clearSelection()
            toast.success("Passage surligné")
          }}
          onNote={async () => {
            const hl = await onCreateHighlight(sel.start_ms, sel.end_ms)
            clearSelection()
            if (hl) setNotePop({ highlight: hl, x: sel.x, y: sel.y + 24 })
          }}
          onCite={() => {
            onCitation(sel.start_ms, sel.text)
            clearSelection()
          }}
          onClip={() => {
            onOpenClip(sel.start_ms, sel.end_ms)
            clearSelection()
          }}
          onDismiss={clearSelection}
        />
      )}

      {/* Note popover for a highlight */}
      {notePop && (
        <NotePopover
          highlight={notePop.highlight}
          x={notePop.x}
          y={notePop.y}
          onSave={(note) => {
            onSetNote(notePop.highlight.id, note)
            setNotePop(null)
          }}
          onDelete={() => {
            onRemoveHighlight(notePop.highlight.id)
            setNotePop(null)
            toast.success("Surlignage supprimé")
          }}
          onClose={() => setNotePop(null)}
        />
      )}
    </div>
  )
}

/** Floating contextual toolbar shown over a transcript text selection. */
function SelectionToolbar({
  sel,
  onHighlight,
  onNote,
  onCite,
  onClip,
  onDismiss,
}: {
  sel: { x: number; y: number }
  onHighlight: () => void
  onNote: () => void
  onCite: () => void
  onClip: () => void
  onDismiss: () => void
}) {
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-sel-toolbar]")) onDismiss()
    }
    // Defer so the mouseup that created the selection doesn't immediately close it.
    const t = setTimeout(() => document.addEventListener("mousedown", onDoc), 0)
    return () => {
      clearTimeout(t)
      document.removeEventListener("mousedown", onDoc)
    }
  }, [onDismiss])

  const left = Math.max(8, Math.min(sel.x, (typeof window !== "undefined" ? window.innerWidth : 1000) - 8))
  return (
    <div
      data-sel-toolbar
      style={{ position: "fixed", left, top: Math.max(8, sel.y - 44), transform: "translateX(-50%)", zIndex: 50 }}
      className="flex items-center gap-0.5 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
    >
      <ToolbarBtn icon={HighlighterIcon} label="Surligner" onClick={onHighlight} />
      <ToolbarBtn icon={StickyNoteIcon} label="Noter" onClick={onNote} />
      <ToolbarBtn icon={QuoteIcon} label="Citer" onClick={onCite} />
      <ToolbarBtn icon={ScissorsIcon} label="Clip" onClick={onClip} />
    </div>
  )
}

function ToolbarBtn({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof HighlighterIcon
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1 rounded px-2 py-1 text-xs font-medium hover:bg-muted"
    >
      <Icon className="size-3.5" /> {label}
    </button>
  )
}

/** Inline note editor for a highlight (Cmd/Ctrl+Enter saves; light delete confirm). */
function NotePopover({
  highlight,
  x,
  y,
  onSave,
  onDelete,
  onClose,
}: {
  highlight: Highlight
  x: number
  y: number
  onSave: (note: string) => void
  onDelete: () => void
  onClose: () => void
}) {
  const [note, setNote] = useState(highlight.note ?? "")
  const [confirmDel, setConfirmDel] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    ref.current?.focus()
    const onDoc = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-note-pop]")) onClose()
    }
    const t = setTimeout(() => document.addEventListener("mousedown", onDoc), 0)
    return () => {
      clearTimeout(t)
      document.removeEventListener("mousedown", onDoc)
    }
  }, [onClose])

  const left = Math.max(8, Math.min(x, (typeof window !== "undefined" ? window.innerWidth : 1000) - 320))
  return (
    <div
      data-note-pop
      style={{ position: "fixed", left, top: y + 6, zIndex: 50, width: 300 }}
      className="flex flex-col gap-2 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg"
    >
      <p className="line-clamp-2 text-[11px] italic text-muted-foreground">« {highlight.text} »</p>
      <textarea
        ref={ref}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onSave(note)
        }}
        placeholder="Votre note… (Cmd/Ctrl+Entrée pour enregistrer)"
        className="min-h-20 w-full resize-none rounded-md border border-border bg-background p-2 text-sm outline-none focus:border-primary"
      />
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => onSave(note)}>Enregistrer</Button>
        {confirmDel ? (
          <Button size="sm" variant="destructive" onClick={onDelete}>
            Confirmer ?
          </Button>
        ) : (
          <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setConfirmDel(true)}>
            <Trash2Icon className="size-3.5" data-icon="inline-start" /> Supprimer
          </Button>
        )}
      </div>
    </div>
  )
}

/** "Dans votre bibliothèque" — the first crossing of the memory. Hidden entirely
 *  when there's nothing close (never a disappointing empty section). For the
 *  closest link, shows the best "ce moment ↔ ce moment" passage pair. */
function RelatedSection({
  contentId,
  onSeek,
  onOpenContent,
}: {
  contentId: string
  onSeek: (seconds: number) => void
  onOpenContent: (id: string, startAt?: number) => void
}) {
  const [results, setResults] = useState<RelatedResult[] | null>(null)

  useEffect(() => {
    let alive = true
    setResults(null)
    backend
      .related(contentId, 5)
      .then((r) => alive && setResults(r.results))
      .catch(() => alive && setResults([]))
    return () => {
      alive = false
    }
  }, [contentId])

  if (!results || results.length === 0) return null

  const bridge = results.find((r) => r.pair)

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold">Dans votre bibliothèque</h2>

      {bridge?.pair && (
        <div className="flex flex-col gap-2 rounded-xl border border-border bg-muted/30 p-3">
          <p className="text-xs text-muted-foreground">
            Ce moment fait écho à{" "}
            <span className="font-medium text-foreground">{bridge.title}</span>
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => onSeek(bridge.pair!.a_start_ms / 1000)}
              className="flex flex-col gap-1 rounded-lg border border-border bg-card p-2.5 text-left transition-colors hover:border-primary/40"
            >
              <span className="flex items-center gap-1.5 text-xs font-medium text-primary">
                <PlayIcon className="size-3" /> Ici · {fmtMs(bridge.pair.a_start_ms)}
              </span>
              <span className="line-clamp-2 text-xs text-foreground/80">{bridge.pair.a_text}</span>
            </button>
            <button
              type="button"
              onClick={() =>
                onOpenContent(bridge.id, Math.max(0, bridge.pair!.b_start_ms / 1000 - 2))
              }
              className="flex flex-col gap-1 rounded-lg border border-border bg-card p-2.5 text-left transition-colors hover:border-primary/40"
            >
              <span className="flex items-center gap-1.5 text-xs font-medium text-primary">
                <ExternalLinkIcon className="size-3" /> Là-bas · {fmtMs(bridge.pair.b_start_ms)}
              </span>
              <span className="line-clamp-2 text-xs text-foreground/80">{bridge.pair.b_text}</span>
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {results.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => onOpenContent(r.id)}
            className="group flex flex-col gap-1.5 rounded-lg border border-transparent p-1 text-left transition-colors hover:bg-muted/50"
          >
            <div className="relative aspect-video w-full overflow-hidden rounded-md bg-muted">
              {r.thumbnail_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={r.thumbnail_url} alt="" className="size-full object-cover" />
              ) : (
                <div className="flex size-full items-center justify-center text-muted-foreground">
                  <PlayIcon className="size-5" />
                </div>
              )}
              <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[10px] font-medium text-white tabular-nums">
                {Math.round(r.score * 100)}%
              </span>
            </div>
            <p className="line-clamp-2 text-xs font-medium leading-snug">{r.title}</p>
            <p className="truncate text-[11px] text-muted-foreground">{r.channel}</p>
          </button>
        ))}
      </div>
    </div>
  )
}

function fmtDate(epochSec: number | null): string {
  if (!epochSec) return ""
  try {
    return new Date(epochSec * 1000).toLocaleDateString("fr-FR", {
      day: "numeric",
      month: "short",
      year: "numeric",
    })
  } catch {
    return ""
  }
}

/** Aperçu summary block: short summary in exergue, long below, provenance footer
 *  + regenerate, with the pedagogical states (no provider / generating / error). */
function SummaryPanel({
  content,
  providerOn,
  onRegenerate,
  onNavigate,
}: {
  content: Content
  providerOn: boolean | null
  onRegenerate: () => void
  onNavigate: (v: View) => void
}) {
  const status = content.generation_status
  const hasSummary = !!(content.summary_short || content.summary_long)

  if (hasSummary) {
    const paras = (content.summary_long || "").split(/\n{2,}/).filter((p) => p.trim())
    return (
      <div className="flex flex-col gap-3">
        {content.summary_short && (
          <p className="text-base font-medium leading-relaxed text-pretty">{content.summary_short}</p>
        )}
        {paras.map((p, i) => (
          <p key={i} className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
            {p}
          </p>
        ))}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-1 text-xs text-muted-foreground">
          <SparklesIcon className="size-3 text-primary" />
          <span>
            Généré{content.summary_model ? ` par ${content.summary_model}` : ""}
            {content.summary_generated_at ? ` · ${fmtDate(content.summary_generated_at)}` : ""}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-7"
            onClick={onRegenerate}
            disabled={status === "queued" || status === "running"}
          >
            {status === "queued" || status === "running" ? (
              <Loader2Icon className="size-3.5 animate-spin" data-icon="inline-start" />
            ) : (
              <RotateCcwIcon className="size-3.5" data-icon="inline-start" />
            )}
            Régénérer
          </Button>
        </div>
      </div>
    )
  }

  if (status === "queued" || status === "running") {
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-4">
        <div className="flex items-center gap-2 text-sm text-primary">
          <Loader2Icon className="size-4 animate-spin" />
          {status === "queued" ? "En file de génération…" : "Génération du résumé en cours…"}
        </div>
        <InlineFeedback state="loading" rows={3} />
      </div>
    )
  }

  if (status === "error") {
    return (
      <InlineFeedback
        state="error"
        title="Échec de la génération"
        description="Le résumé n'a pas pu être produit. Vérifiez le fournisseur et réessayez."
        action={
          <Button size="sm" variant="outline" onClick={onRegenerate}>
            <RotateCcwIcon data-icon="inline-start" /> Réessayer
          </Button>
        }
      />
    )
  }

  // No summary yet.
  if (providerOn === false) {
    return (
      <InlineFeedback
        state="empty"
        icon={SparklesIcon}
        title="Configurez un fournisseur IA pour obtenir résumés et chapitres"
        description="Un LLM local (Ollama) ou distant génère un résumé et des chapitres pour chaque contenu transcrit."
        action={
          <Button size="sm" onClick={() => onNavigate("settings")}>
            <SparklesIcon data-icon="inline-start" /> Réglages → Intelligence
          </Button>
        }
      />
    )
  }

  return (
    <InlineFeedback
      state="empty"
      icon={WandSparklesIcon}
      title="Pas encore de résumé"
      description="Générez un résumé et des chapitres pour ce contenu."
      action={
        <Button size="sm" onClick={onRegenerate} disabled={providerOn === null}>
          <WandSparklesIcon data-icon="inline-start" /> Générer maintenant
        </Button>
      }
    />
  )
}

function activeChapterIdx(chapters: Chapter[], currentTime: number): number {
  const curMs = currentTime * 1000
  let idx = -1
  for (let i = 0; i < chapters.length; i++) {
    if (curMs >= chapters[i].start_ms) idx = i
    else break
  }
  return idx
}

/** "Chapitres" list — clickable seek, current chapter highlighted during playback
 *  (same karaoke mechanic as the transcript). */
function ChaptersList({
  chapters,
  currentTime,
  onSeek,
}: {
  chapters: Chapter[]
  currentTime: number
  onSeek: (seconds: number) => void
}) {
  const active = activeChapterIdx(chapters, currentTime)
  return (
    <div className="flex flex-col gap-1.5">
      <h2 className="text-sm font-semibold">Chapitres</h2>
      <div className="flex flex-col overflow-hidden rounded-lg border border-border">
        {chapters.map((c, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onSeek(c.start_ms / 1000)}
            className={cn(
              "flex items-center gap-3 border-b border-border/50 px-3 py-2 text-left text-sm transition-colors last:border-0 hover:bg-muted/50",
              i === active && "bg-primary/10",
            )}
          >
            <span className="shrink-0 font-mono text-xs tabular-nums text-primary">
              {fmtMs(c.start_ms)}
            </span>
            <span className="text-foreground/90">{c.title}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

/** Chapter markers along a slim timeline under the player: click to seek, title
 *  on hover, current chapter and playhead highlighted. */
function ChapterBar({
  chapters,
  durationSec,
  currentTime,
  onSeek,
}: {
  chapters: Chapter[]
  durationSec: number
  currentTime: number
  onSeek: (seconds: number) => void
}) {
  const active = activeChapterIdx(chapters, currentTime)
  const playhead = Math.max(0, Math.min(100, (currentTime / durationSec) * 100))
  return (
    <div className="relative h-6">
      <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-muted" />
      <div
        className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-primary/40"
        style={{ width: `${playhead}%` }}
      />
      {chapters.map((c, i) => {
        const left = Math.max(0, Math.min(100, ((c.start_ms / 1000) / durationSec) * 100))
        return (
          <button
            key={i}
            type="button"
            title={`${fmtMs(c.start_ms)} — ${c.title}`}
            aria-label={`Chapitre : ${c.title}`}
            onClick={() => onSeek(c.start_ms / 1000)}
            style={{ left: `${left}%` }}
            className={cn(
              "absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background transition-transform hover:scale-125",
              i === active ? "bg-primary" : "bg-primary/60",
            )}
          />
        )
      })}
    </div>
  )
}

/** User highlights as thin amber spans along the timeline (distinct from the
 *  purple chapter markers). Click seeks to the highlight start. */
function HighlightBar({
  highlights,
  durationSec,
  onSeek,
}: {
  highlights: Highlight[]
  durationSec: number
  onSeek: (seconds: number) => void
}) {
  return (
    <div className="relative h-3" aria-label="Surlignages">
      <div className="absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-muted" />
      {highlights.map((h) => {
        const left = Math.max(0, Math.min(100, (h.start_ms / 1000 / durationSec) * 100))
        const width = Math.max(0.5, Math.min(100 - left, ((h.end_ms - h.start_ms) / 1000 / durationSec) * 100))
        return (
          <button
            key={h.id}
            type="button"
            title={h.note ? `📝 ${h.note}` : h.text}
            aria-label="Aller au surlignage"
            onClick={() => onSeek(h.start_ms / 1000)}
            style={{ left: `${left}%`, width: `${width}%` }}
            className="absolute top-1/2 h-2 -translate-y-1/2 rounded-full bg-warning/70 transition-colors hover:bg-warning"
          />
        )
      })}
    </div>
  )
}

/** "Clips" block on the Aperçu tab: extracted excerpts with a download link. */
function ClipsBlock({ clips }: { clips: Clip[] }) {
  return (
    <div className="flex flex-col gap-2">
      <h2 className="flex items-center gap-1.5 text-sm font-semibold">
        <ScissorsIcon className="size-3.5" /> Clips
      </h2>
      <div className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-lg border border-border">
        {clips.map((c) => (
          <div key={c.id} className="flex items-center gap-3 px-3 py-2 text-sm">
            <span className="shrink-0 text-muted-foreground">
              {c.format === "audio" ? "🎵" : "🎬"}
            </span>
            <span className="min-w-0 flex-1 truncate">{c.name}</span>
            <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
              {fmtMs(c.start_ms)}–{fmtMs(c.end_ms)}
            </span>
            <Button size="sm" variant="ghost" render={<a href={c.url} download />}>
              <DownloadIcon data-icon="inline-start" /> Télécharger
            </Button>
          </div>
        ))}
      </div>
    </div>
  )
}

function parseMmss(v: string): number | null {
  const m = v.trim().match(/^(\d+):([0-5]?\d)$/)
  if (!m) return null
  return (Number(m[1]) * 60 + Number(m[2])) * 1000
}

/** Clip confirmation dialog: editable m:ss bounds, format, then a visible job.
 *  Polls the job to completion and refreshes the clips list. */
function ClipDialog({
  contentId,
  bounds,
  onClose,
  onCreated,
}: {
  contentId: string
  bounds: { start_ms: number; end_ms: number }
  onClose: () => void
  onCreated: () => void
}) {
  const [startStr, setStartStr] = useState(fmtMs(bounds.start_ms))
  const [endStr, setEndStr] = useState(fmtMs(bounds.end_ms))
  const [format, setFormat] = useState<"video" | "audio">("video")
  const [busy, setBusy] = useState(false)

  const start = parseMmss(startStr)
  const end = parseMmss(endStr)
  const durMs = start != null && end != null ? end - start : null
  const valid = durMs != null && durMs > 0 && durMs <= 5 * 60 * 1000

  async function create() {
    if (start == null || end == null) return
    setBusy(true)
    try {
      const r = await backend.createClip(contentId, { start_ms: start, end_ms: end, format })
      if (r.error || !r.job_id) {
        toast.error(r.error || "Création impossible")
        setBusy(false)
        return
      }
      const jobId = r.job_id
      onClose()
      toast.info("Extraction du clip lancée…")
      // Poll the task job to completion, then surface a download toast.
      const started = Date.now()
      const poll = setInterval(async () => {
        try {
          const st = await backend.jobStatus(jobId)
          if (st.status === "done" || (Date.now() - started > 15 * 60 * 1000)) {
            clearInterval(poll)
            onCreated()
            const clips = await backend.listClips(contentId)
            const clip = clips.clips[0]
            if (clip) {
              toast.success("Clip prêt", {
                action: { label: "Télécharger", onClick: () => window.open(clip.url, "_blank") },
                duration: 10000,
              })
            }
          } else if (st.status === "error") {
            clearInterval(poll)
            toast.error(st.error || "Échec de l'extraction du clip")
          }
        } catch {
          /* keep polling */
        }
      }, 2000)
    } catch {
      toast.error("Création impossible")
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Créer un clip</DialogTitle>
          <DialogDescription>
            Extrait vidéo ou audio du passage. Bornes ajustables (m:ss), 5 min max.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex items-end gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="clip-start">Début</Label>
              <Input id="clip-start" value={startStr} onChange={(e) => setStartStr(e.target.value)} className="w-24 font-mono" placeholder="m:ss" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="clip-end">Fin</Label>
              <Input id="clip-end" value={endStr} onChange={(e) => setEndStr(e.target.value)} className="w-24 font-mono" placeholder="m:ss" />
            </div>
            <p className="pb-2 text-sm text-muted-foreground">
              {durMs != null && durMs > 0
                ? `Durée : ${fmtMs(durMs)}`
                : "Bornes invalides"}
            </p>
          </div>
          {!valid && durMs != null && durMs > 5 * 60 * 1000 && (
            <p className="text-xs text-destructive">Clip trop long (5 min maximum).</p>
          )}
          <div className="flex items-center gap-2">
            <Button size="sm" variant={format === "video" ? "secondary" : "ghost"} onClick={() => setFormat("video")}>
              Vidéo (.mp4)
            </Button>
            <Button size="sm" variant={format === "audio" ? "secondary" : "ghost"} onClick={() => setFormat("audio")}>
              Audio (.m4a)
            </Button>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Annuler</Button>
          <Button onClick={create} disabled={!valid || busy}>
            {busy && <Loader2Icon className="size-4 animate-spin" data-icon="inline-start" />}
            <ScissorsIcon data-icon="inline-start" /> Créer le clip
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
