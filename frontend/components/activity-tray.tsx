"use client"

import { useEffect, useRef } from "react"
import {
  DownloadIcon,
  FileTextIcon,
  HistoryIcon,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react"

import { cn } from "@/lib/utils"
import type { GenerationJob, TranscriptJob } from "@/lib/backend"
import type { DownloadItem } from "@/lib/types"
import { useStore } from "@/components/store-provider"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { StatusBadge } from "@/components/status-badge"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"

/** The activity tray — the plumbing, consulted on demand. Compact per-queue
 *  sections reusing the job controls; opens itself only when a NEW error lands
 *  (never on ordinary progress). "Historique complet" opens the full DownloadsView. */
export function ActivityTray({
  open,
  onOpenChange,
  onOpenHistory,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onOpenHistory: () => void
}) {
  const {
    downloads,
    transcriptJobs,
    generationJobs,
    activeTotal,
    errorCount,
    pausedCount,
    restoredCount,
    dismissRestored,
    pauseAll,
    resumeAll,
  } = useStore()

  // Auto-open ONLY when the error count rises (a fresh failure), never on progress.
  const prevErrors = useRef(errorCount)
  useEffect(() => {
    if (errorCount > prevErrors.current && !open) onOpenChange(true)
    prevErrors.current = errorCount
  }, [errorCount, open, onOpenChange])

  const activeDownloads = downloads.filter((d) =>
    ["queued", "downloading", "converting", "paused"].includes(d.status),
  )
  const otherDownloads = downloads.filter((d) => !activeDownloads.includes(d))
  const shownDownloads = [...activeDownloads, ...otherDownloads].slice(0, 8)
  const activeTranscripts = transcriptJobs.filter(
    (t) => t.status === "queued" || t.status === "running" || t.status === "error",
  )
  const activeGenerations = generationJobs.filter(
    (g) => g.status === "queued" || g.status === "running" || g.status === "error",
  )

  const empty =
    shownDownloads.length === 0 && activeTranscripts.length === 0 && activeGenerations.length === 0

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="gap-0 p-0">
        <SheetHeader className="flex-row items-center gap-2">
          <SheetTitle className="flex-1">Activité</SheetTitle>
          {pausedCount > 0 ? (
            <Button size="sm" variant="outline" onClick={resumeAll}>
              <PlayIcon data-icon="inline-start" /> Tout reprendre
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={pauseAll} disabled={!activeTotal}>
              <PauseIcon data-icon="inline-start" /> Tout suspendre
            </Button>
          )}
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {restoredCount > 0 && (
            <div className="flex items-center gap-2 rounded-lg border border-info/30 bg-info/10 px-3 py-2 text-xs text-info">
              <RotateCcwIcon className="size-4 shrink-0" />
              <span className="flex-1">
                {restoredCount} téléchargement{restoredCount > 1 ? "s" : ""} repris après redémarrage.
              </span>
              <button type="button" onClick={dismissRestored} aria-label="Masquer">
                <XIcon className="size-3.5" />
              </button>
            </div>
          )}

          {empty && (
            <p className="py-10 text-center text-sm text-muted-foreground">
              Tout est calme. Les téléchargements, transcriptions et résumés en cours
              apparaîtront ici.
            </p>
          )}

          {shownDownloads.length > 0 && (
            <Section icon={DownloadIcon} label="Téléchargements">
              {shownDownloads.map((d) => (
                <DownloadMini key={d.id} item={d} />
              ))}
            </Section>
          )}

          {activeTranscripts.length > 0 && (
            <Section icon={FileTextIcon} label="Transcriptions">
              {activeTranscripts.map((t) => (
                <TranscriptMini key={t.id} job={t} />
              ))}
            </Section>
          )}

          {activeGenerations.length > 0 && (
            <Section icon={SparklesIcon} label="Résumés & chapitres">
              {activeGenerations.map((g) => (
                <GenerationMini key={g.id} job={g} />
              ))}
            </Section>
          )}
        </div>

        <div className="border-t border-border p-3">
          <Button variant="ghost" size="sm" className="w-full" onClick={onOpenHistory}>
            <HistoryIcon data-icon="inline-start" /> Historique complet
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function Section({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof DownloadIcon
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <Icon className="size-3.5" /> {label}
      </p>
      <div className="flex flex-col gap-1.5">{children}</div>
    </div>
  )
}

function DownloadMini({ item }: { item: DownloadItem }) {
  const { pauseDownload, resumeDownload, cancelDownload, retryDownload } = useStore()
  const showProgress = ["downloading", "converting", "queued", "paused"].includes(item.status)
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-2.5">
      <div className="flex items-center gap-2">
        <p className="line-clamp-1 flex-1 text-xs font-medium">{item.title}</p>
        <StatusBadge status={item.status} />
      </div>
      {showProgress && <Progress value={item.progress} className="h-1" />}
      {item.status === "failed" && item.error && (
        <p className="line-clamp-2 text-[11px] text-destructive">{item.error}</p>
      )}
      <div className="flex items-center gap-0.5">
        {(item.status === "downloading" || item.status === "converting" || item.status === "queued") && (
          <MiniBtn onClick={() => pauseDownload(item.id)} icon={PauseIcon} label="Pause" />
        )}
        {item.status === "paused" && (
          <MiniBtn onClick={() => resumeDownload(item.id)} icon={PlayIcon} label="Reprendre" />
        )}
        {(item.status === "failed" || item.status === "canceled") && (
          <MiniBtn onClick={() => retryDownload(item.id)} icon={RotateCcwIcon} label="Réessayer" />
        )}
        {["downloading", "converting", "queued", "paused"].includes(item.status) && (
          <MiniBtn
            onClick={() => cancelDownload(item.id)}
            icon={XIcon}
            label="Annuler"
            danger
          />
        )}
      </div>
    </div>
  )
}

const T_STATUS = {
  queued: "queued",
  running: "downloading",
  done: "completed",
  error: "failed",
  canceled: "canceled",
} as const

function TranscriptMini({ job }: { job: TranscriptJob }) {
  const { cancelTranscript } = useStore()
  const active = job.status === "queued" || job.status === "running"
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-2.5">
      <div className="flex items-center gap-2">
        <p className="line-clamp-1 flex-1 text-xs font-medium">{job.title || "Transcription"}</p>
        <StatusBadge status={T_STATUS[job.status]} />
      </div>
      {job.status === "running" && <Progress value={job.progress} className="h-1" />}
      {job.status === "error" && job.error && (
        <p className="line-clamp-2 text-[11px] text-destructive">{job.error}</p>
      )}
      {active && (
        <div className="flex">
          <MiniBtn onClick={() => cancelTranscript(job.id)} icon={XIcon} label="Annuler" danger />
        </div>
      )}
    </div>
  )
}

function GenerationMini({ job }: { job: GenerationJob }) {
  const { cancelGeneration } = useStore()
  const active = job.status === "queued" || job.status === "running"
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-2.5">
      <div className="flex items-center gap-2">
        <p className="line-clamp-1 flex-1 text-xs font-medium">{job.title || "Résumé"}</p>
        <StatusBadge status={T_STATUS[job.status]} />
      </div>
      {job.status === "error" && job.error && (
        <p className="line-clamp-2 text-[11px] text-destructive">{job.error}</p>
      )}
      {active && (
        <div className="flex">
          <MiniBtn onClick={() => cancelGeneration(job.id)} icon={XIcon} label="Annuler" danger />
        </div>
      )}
    </div>
  )
}

function MiniBtn({
  onClick,
  icon: Icon,
  label,
  danger,
}: {
  onClick: () => void
  icon: typeof PauseIcon
  label: string
  danger?: boolean
}) {
  return (
    <Button
      size="sm"
      variant="ghost"
      className={cn("h-7 px-2 text-[11px]", danger && "text-destructive")}
      onClick={onClick}
    >
      <Icon className="size-3.5" data-icon="inline-start" />
      {label}
    </Button>
  )
}
