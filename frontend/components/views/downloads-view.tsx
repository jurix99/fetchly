"use client"

import { useMemo, useState } from "react"
import {
  CheckIcon,
  DownloadIcon,
  GaugeIcon,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"

import { cn } from "@/lib/utils"
import type { DownloadItem, DownloadStatus } from "@/lib/types"
import { useStore } from "@/components/store-provider"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { StatusBadge } from "@/components/status-badge"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"

type Filter = "all" | "active" | "completed" | "failed"

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "Tous" },
  { id: "active", label: "En cours" },
  { id: "completed", label: "Terminés" },
  { id: "failed", label: "Échecs" },
]

const ACTIVE: DownloadStatus[] = ["queued", "downloading", "converting", "paused"]

export function DownloadsView() {
  const {
    downloads,
    activeCount,
    totalSpeed,
    globalPaused,
    pauseAll,
    resumeAll,
    clearCompleted,
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
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs">
          <DownloadIcon className="size-3.5 text-info" />
          <span className="font-medium tabular-nums">{activeCount}</span>
          <span className="text-muted-foreground">actifs</span>
        </div>
        <div className="flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs">
          <GaugeIcon className="size-3.5 text-success" />
          <span className="font-medium tabular-nums">{totalSpeed}</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {globalPaused ? (
            <Button size="sm" variant="outline" onClick={resumeAll}>
              <PlayIcon data-icon="inline-start" /> Tout reprendre
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={pauseAll}>
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
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <DownloadIcon />
            </EmptyMedia>
            <EmptyTitle>Aucun téléchargement</EmptyTitle>
            <EmptyDescription>
              Collez une URL depuis l&apos;accueil pour lancer un téléchargement.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-3">
          {shown.map((d) => (
            <DownloadRow key={d.id} item={d} />
          ))}
        </div>
      )}
    </div>
  )
}

function DownloadRow({ item }: { item: DownloadItem }) {
  const { pauseDownload, resumeDownload, cancelDownload, retryDownload, removeDownload } = useStore()
  const isActive = item.status === "downloading" || item.status === "converting"
  const showProgress = isActive || item.status === "queued" || item.status === "paused"

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
                {item.speed ? `${item.speed}` : ""} {item.eta ? `· ${item.eta}` : ""}
              </span>
            </div>
          </div>
        )}
        {item.status === "failed" && item.error && (
          <p className="text-xs text-destructive">{item.error}</p>
        )}

        <div className="mt-1 flex items-center gap-1">
          {item.status === "downloading" || item.status === "queued" ? (
            <Button size="sm" variant="ghost" onClick={() => pauseDownload(item.id)}>
              <PauseIcon data-icon="inline-start" /> Pause
            </Button>
          ) : null}
          {item.status === "paused" ? (
            <Button size="sm" variant="ghost" onClick={() => resumeDownload(item.id)}>
              <PlayIcon data-icon="inline-start" /> Reprendre
            </Button>
          ) : null}
          {(item.status === "failed") && (
            <Button size="sm" variant="ghost" onClick={() => retryDownload(item.id)}>
              <RotateCcwIcon data-icon="inline-start" /> Réessayer
            </Button>
          )}
          {isActive && (
            <Button size="sm" variant="ghost" className="text-destructive" onClick={() => cancelDownload(item.id)}>
              <XIcon data-icon="inline-start" /> Annuler
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto text-muted-foreground"
            onClick={() => removeDownload(item.id)}
            aria-label="Retirer de la liste"
          >
            <Trash2Icon />
          </Button>
        </div>
      </div>
    </div>
  )
}
