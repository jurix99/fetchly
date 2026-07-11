"use client"

import { useMemo, useState } from "react"
import {
  CheckIcon,
  DownloadIcon,
  FileTextIcon,
  FolderOpenIcon,
  GaugeIcon,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"

import { backend, type TranscriptJob } from "@/lib/backend"
import type { DownloadItem, DownloadStatus } from "@/lib/types"
import type { View } from "@/components/app-shell"
import { useStore } from "@/components/store-provider"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { StatusBadge } from "@/components/status-badge"
import { InlineFeedback } from "@/components/inline-feedback"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

type Filter = "all" | "active" | "completed" | "failed"

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "Tous" },
  { id: "active", label: "En cours" },
  { id: "completed", label: "Terminés" },
  { id: "failed", label: "Échecs" },
]

const ACTIVE: DownloadStatus[] = ["queued", "downloading", "converting", "paused"]

export function DownloadsView({ onNavigate }: { onNavigate?: (v: View) => void }) {
  const {
    downloads,
    activeCount,
    totalSpeed,
    pausedCount,
    restoredCount,
    dismissRestored,
    pauseAll,
    resumeAll,
    clearCompleted,
    transcriptJobs,
    transcriptActiveCount,
    cancelTranscript,
  } = useStore()
  const [filter, setFilter] = useState<Filter>("all")

  const shown = useMemo(() => {
    if (filter === "active") return downloads.filter((d) => ACTIVE.includes(d.status))
    if (filter === "completed") return downloads.filter((d) => d.status === "completed")
    if (filter === "failed") return downloads.filter((d) => d.status === "failed")
    return downloads
  }, [downloads, filter])

  const completedCount = downloads.filter((d) => d.status === "completed").length

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 p-4 sm:p-6 lg:p-8">
      {restoredCount > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-info/30 bg-info/10 px-3 py-2 text-sm text-info">
          <RotateCcwIcon className="size-4 shrink-0" />
          <span className="flex-1">
            {restoredCount} téléchargement{restoredCount > 1 ? "s" : ""} repris après redémarrage.
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="text-info"
            onClick={dismissRestored}
            aria-label="Masquer le message de restauration"
          >
            <XIcon />
          </Button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs">
          <DownloadIcon className="size-3.5 text-primary" />
          <span className="font-medium tabular-nums">{activeCount + transcriptActiveCount}</span>
          <span className="text-muted-foreground">actifs</span>
        </div>
        <div className="flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs">
          <GaugeIcon className="size-3.5 text-success" />
          <span className="font-medium tabular-nums">{totalSpeed}</span>
        </div>
        {pausedCount > 0 && (
          <div className="flex items-center gap-2 rounded-full border border-warning/30 bg-warning/10 px-3 py-1.5 text-xs text-warning">
            <PauseIcon className="size-3.5" />
            <span className="font-medium tabular-nums">{pausedCount}</span>
            <span>suspendu{pausedCount > 1 ? "s" : ""}</span>
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          {pausedCount > 0 ? (
            <Button size="sm" variant="outline" onClick={resumeAll}>
              <PlayIcon data-icon="inline-start" /> Tout reprendre
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={pauseAll} disabled={!activeCount}>
              <PauseIcon data-icon="inline-start" /> Tout suspendre
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={clearCompleted} disabled={!completedCount}>
            <CheckIcon data-icon="inline-start" /> Effacer terminés
          </Button>
        </div>
      </div>

      <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
        <TabsList>
          {FILTERS.map((f) => (
            <TabsTrigger key={f.id} value={f.id}>
              {f.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {shown.length === 0 ? (
        <InlineFeedback
          state="empty"
          icon={DownloadIcon}
          title="Aucun téléchargement"
          description="Collez une URL depuis l'accueil pour lancer un téléchargement."
          action={
            onNavigate ? (
              <Button size="sm" onClick={() => onNavigate("home")}>
                <DownloadIcon data-icon="inline-start" /> Nouveau téléchargement
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          {shown.map((d) => (
            <DownloadRow key={d.id} item={d} />
          ))}
        </div>
      )}

      {transcriptJobs.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 pt-2">
            <FileTextIcon className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Transcriptions</h2>
            {transcriptActiveCount > 0 && (
              <span className="text-xs text-muted-foreground">
                {transcriptActiveCount} en cours
              </span>
            )}
          </div>
          {transcriptJobs.map((t) => (
            <TranscriptRow key={t.id} job={t} onCancel={cancelTranscript} />
          ))}
        </div>
      )}
    </div>
  )
}

function DownloadRow({ item }: { item: DownloadItem }) {
  const { settings, pauseDownload, resumeDownload, cancelDownload, retryDownload, removeDownload } =
    useStore()
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const [log, setLog] = useState<string[]>([])

  async function openLog() {
    try {
      const s = await backend.jobStatus(item.id)
      setLog(s.log ?? [])
    } catch {
      setLog([])
    }
    setShowLog(true)
  }

  const isActive = item.status === "downloading" || item.status === "converting"
  // Progress is meaningful while a job is in flight or held (paused/queued).
  const showProgress =
    isActive || item.status === "queued" || item.status === "paused"

  function openFolder() {
    toast.info("Fichier enregistré", {
      description: `${settings.downloadDir}${item.channel ? ` · ${item.channel}` : ""}`,
    })
  }

  return (
    <div className="flex gap-3 rounded-lg border border-border bg-card p-3">
      <div className="relative aspect-video w-32 shrink-0 overflow-hidden rounded-md bg-muted sm:w-40">
        {item.thumbnail ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.thumbnail || "/placeholder.svg"} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <DownloadIcon className="size-5" />
          </div>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-start gap-2">
          <p className="line-clamp-2 flex-1 text-sm font-medium leading-snug">{item.title}</p>
          <StatusBadge status={item.status} />
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {item.channel && <span className="truncate">{item.channel}</span>}
          <span>· {item.quality}</span>
          <span>· {item.format}</span>
          {item.sizeTotal && <span>· {item.sizeTotal}</span>}
        </div>

        {showProgress && (
          <div className="mt-0.5 flex flex-col gap-1">
            <Progress value={item.progress} />
            <div className="flex justify-between text-[11px] text-muted-foreground tabular-nums">
              <span>{Math.round(item.progress)}%</span>
              <span>
                {item.status === "paused"
                  ? "En pause"
                  : `${item.speed ? item.speed : ""} ${item.eta ? `· ${item.eta}` : ""}`}
              </span>
            </div>
          </div>
        )}
        {item.status === "failed" && item.error && (
          <p className="text-xs text-destructive">{item.error}</p>
        )}

        {/* Pipeline outputs (plugins) — the visible trace of what ran after the
            download. Failed outputs link to the job log. */}
        {item.reports && item.reports.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground">
            {item.reports.map((r, i) => (
              <span key={i} className="flex items-center gap-1.5">
                {i > 0 && <span className="text-border">·</span>}
                {r.ok ? (
                  <span>
                    {r.label} ✓{r.detail ? ` ${r.detail}` : ""}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={openLog}
                    className="text-destructive underline underline-offset-2"
                  >
                    {r.label} : échec (voir journal)
                  </button>
                )}
              </span>
            ))}
          </div>
        )}

        <div className="mt-1 flex items-center gap-1">
          {(item.status === "downloading" ||
            item.status === "converting" ||
            item.status === "queued") && (
            <Button size="sm" variant="ghost" onClick={() => pauseDownload(item.id)}>
              <PauseIcon data-icon="inline-start" /> Pause
            </Button>
          )}
          {item.status === "paused" && (
            <Button size="sm" variant="ghost" onClick={() => resumeDownload(item.id)}>
              <PlayIcon data-icon="inline-start" /> Reprendre
            </Button>
          )}
          {(item.status === "failed" || item.status === "canceled") && (
            <Button size="sm" variant="ghost" onClick={() => retryDownload(item.id)}>
              <RotateCcwIcon data-icon="inline-start" /> Réessayer
            </Button>
          )}
          {item.status === "completed" && (
            <Button size="sm" variant="ghost" onClick={openFolder}>
              <FolderOpenIcon data-icon="inline-start" /> Ouvrir le dossier
            </Button>
          )}

          {/* Cancel is destructive (removes incomplete files) → confirm first. */}
          {(item.status === "downloading" ||
            item.status === "converting" ||
            item.status === "queued" ||
            item.status === "paused") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive"
              onClick={() => setConfirmCancel(true)}
            >
              <XIcon data-icon="inline-start" /> Annuler
            </Button>
          )}

          {(item.status === "completed" ||
            item.status === "failed" ||
            item.status === "canceled") && (
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto text-muted-foreground"
              onClick={() => removeDownload(item.id)}
              aria-label="Retirer de la liste"
            >
              <Trash2Icon data-icon="inline-start" /> Retirer
            </Button>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title="Annuler ce téléchargement ?"
        description="Les fichiers incomplets seront supprimés ; les fichiers terminés sont conservés."
        confirmLabel="Annuler le téléchargement"
        cancelLabel="Continuer"
        onConfirm={() => cancelDownload(item.id)}
      />

      <Dialog open={showLog} onOpenChange={setShowLog}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Journal du téléchargement</DialogTitle>
            <DialogDescription className="truncate">{item.title}</DialogDescription>
          </DialogHeader>
          <pre className="max-h-80 overflow-auto rounded-md bg-muted p-2 text-[11px] whitespace-pre-wrap">
            {log.length ? log.join("\n") : "Journal vide."}
          </pre>
        </DialogContent>
      </Dialog>
    </div>
  )
}

const T_STATUS: Record<TranscriptJob["status"], DownloadStatus> = {
  queued: "queued",
  running: "downloading",
  done: "completed",
  error: "failed",
  canceled: "canceled",
}

function TranscriptRow({
  job,
  onCancel,
}: {
  job: TranscriptJob
  onCancel: (id: string) => void
}) {
  const active = job.status === "queued" || job.status === "running"
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-3">
      <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="line-clamp-1 flex-1 text-sm font-medium">
            {job.title || "Transcription"}
          </p>
          <StatusBadge status={T_STATUS[job.status]} />
        </div>
        {job.status === "running" && <Progress value={job.progress} className="mt-1.5" />}
        {job.status === "error" && job.error && (
          <p className="mt-1 line-clamp-1 text-xs text-destructive">{job.error}</p>
        )}
        <p className="mt-1 text-[11px] text-muted-foreground">Modèle {job.model}</p>
      </div>
      {active && (
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive"
          onClick={() => onCancel(job.id)}
        >
          <XIcon data-icon="inline-start" /> Annuler
        </Button>
      )}
    </div>
  )
}
