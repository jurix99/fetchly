"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { toast } from "sonner"

import { startDownload as apiStartDownload, detectSource, type StartDownloadOptions } from "@/lib/api"
import {
  backend,
  qualityToBackend,
  qualityToFrontend,
  type BackendJob,
  type BackendSettings,
  type BackendWatch,
} from "@/lib/backend"
import type { DownloadItem, DownloadStatus, Settings, Subscription } from "@/lib/types"

interface StoreValue {
  downloads: DownloadItem[]
  subscriptions: Subscription[]
  settings: Settings
  maxConcurrent: number
  bandwidthLimit: number
  globalPaused: boolean
  activeCount: number
  totalSpeed: string
  addDownload: (options: StartDownloadOptions) => Promise<void>
  pauseDownload: (id: string) => void
  resumeDownload: (id: string) => void
  cancelDownload: (id: string) => void
  retryDownload: (id: string) => void
  removeDownload: (id: string) => void
  reorderDownloads: (from: number, to: number) => void
  clearCompleted: () => void
  pauseAll: () => void
  resumeAll: () => void
  setMaxConcurrent: (n: number) => void
  setBandwidthLimit: (n: number) => void
  updateSettings: (patch: Partial<Settings>) => void
  toggleSubscription: (id: string) => void
  checkSubscriptionNow: (id: string) => Promise<void>
  updateSubscription: (id: string, patch: Partial<Subscription>) => void
  removeSubscription: (id: string) => void
  addSubscription: (sub: Subscription) => void
}

const StoreContext = createContext<StoreValue | null>(null)

const STATUS_MAP: Record<BackendJob["status"], DownloadStatus> = {
  queued: "queued",
  running: "downloading",
  done: "completed",
  error: "failed",
}

function jobToDownload(j: BackendJob): DownloadItem {
  // While ffmpeg merges/converts after the streams are downloaded, show
  // "converting" rather than a stuck-looking 100% download.
  const status: DownloadStatus =
    j.status === "running" && j.phase === "processing"
      ? "converting"
      : STATUS_MAP[j.status] ?? "queued"
  return {
    id: j.id,
    title: j.current_title || j.url,
    thumbnail: "",
    sourceUrl: j.url,
    source: detectSource(j.url),
    channel: j.kind === "watch" ? "Abonnement" : undefined,
    quality: qualityToFrontend(j.quality),
    format: "MP4",
    status,
    progress: j.status === "done" ? 100 : Math.round(j.current_percent || 0),
    speed: j.current_speed || undefined,
    sizeTotal: j.total > 1 ? `${j.completed}/${j.total} vidéos` : undefined,
    error: j.status === "error" ? "Échec du téléchargement" : undefined,
    createdAt: new Date((j.created_at || 0) * 1000).toISOString(),
    filePath: j.files?.[0],
  }
}

function watchToSub(w: BackendWatch, intervalHours: number): Subscription {
  return {
    id: w.id,
    type: /list=|playlist/i.test(w.url) ? "playlist" : "channel",
    name: w.title || w.url,
    avatar: "",
    url: w.url,
    checkIntervalHours: intervalHours,
    active: w.enabled,
    lastChecked: w.last_checked || new Date().toISOString(),
    filters: { excludeShorts: false, excludeLives: false, includeKeywords: [], excludeKeywords: [] },
    defaultQuality: qualityToFrontend(w.quality),
    defaultFormat: "MP4",
  }
}

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [jobs, setJobs] = useState<BackendJob[]>([])
  const [watches, setWatches] = useState<BackendWatch[]>([])
  const [bset, setBset] = useState<BackendSettings | null>(null)
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [globalPaused, setGlobalPaused] = useState(false)
  // Local-only settings the backend doesn't persist.
  const [local, setLocal] = useState<Partial<Settings> & { checkIntervalHours?: number }>({
    defaultFormat: "MP4",
    maxConcurrent: 3,
    bandwidthLimit: "",
    subtitles: { enabled: false, languages: [], embed: false },
    embedMetadata: false,
    embedThumbnail: true,
    embedChapters: false,
    sponsorBlock: false,
    sponsorBlockMode: "skip",
    cookiesImport: false,
    downloadArchive: true,
    theme: "dark",
    filenameTemplate: "",
  })
  const checking = useRef<Set<string>>(new Set())

  const refreshJobs = useCallback(() => backend.jobs().then(setJobs).catch(() => {}), [])
  const refreshWatches = useCallback(() => backend.watches().then(setWatches).catch(() => {}), [])

  useEffect(() => {
    backend.settings().then(setBset).catch(() => {})
    refreshJobs()
    refreshWatches()
    const t1 = setInterval(refreshJobs, 1500)
    const t2 = setInterval(refreshWatches, 8000)
    return () => {
      clearInterval(t1)
      clearInterval(t2)
    }
  }, [refreshJobs, refreshWatches])

  const intervalHours = Math.max(1, Math.round((bset?.watch_interval_minutes ?? 60) / 60))

  const settings: Settings = useMemo(
    () => ({
      downloadDir: bset?.download_dir || "/downloads",
      defaultQuality: qualityToFrontend(bset?.default_quality),
      defaultFormat: local.defaultFormat || "MP4",
      filenameTemplate: local.filenameTemplate || "",
      organizeBySubfolder: bset ? bset.organize !== "flat" : true,
      subtitles: local.subtitles || { enabled: false, languages: [], embed: false },
      embedMetadata: !!local.embedMetadata,
      embedThumbnail: local.embedThumbnail ?? true,
      embedChapters: !!local.embedChapters,
      maxConcurrent: local.maxConcurrent ?? 3,
      bandwidthLimit: local.bandwidthLimit ?? "",
      sponsorBlock: !!local.sponsorBlock,
      sponsorBlockMode: local.sponsorBlockMode || "skip",
      cookiesImport: !!local.cookiesImport,
      downloadArchive: local.downloadArchive ?? true,
      theme: local.theme || "dark",
      // extra (read by settings-view)
      ...( { checkIntervalHours: local.checkIntervalHours ?? intervalHours } as object),
    }),
    [bset, local, intervalHours],
  )

  const downloads = useMemo(
    () => jobs.filter((j) => !hidden.has(j.id)).map(jobToDownload),
    [jobs, hidden],
  )
  const subscriptions = useMemo(
    () => watches.map((w) => watchToSub(w, intervalHours)),
    [watches, intervalHours],
  )

  const activeCount = useMemo(
    () => jobs.filter((j) => j.status === "running" || j.status === "queued").length,
    [jobs],
  )
  const totalSpeed = useMemo(() => {
    const total = jobs
      .filter((j) => j.status === "running" && j.current_speed)
      .reduce((acc, j) => acc + (Number.parseFloat(j.current_speed) || 0), 0)
    return total > 0 ? `${total.toFixed(1)} MB/s` : "0 MB/s"
  }, [jobs])

  // --- download actions ---
  const addDownload = useCallback(
    async (options: StartDownloadOptions) => {
      const res = await apiStartDownload(options)
      if (res.error) {
        toast.error(res.error)
        return
      }
      toast.success("Ajouté à la file", { description: options.title })
      refreshJobs()
    },
    [refreshJobs],
  )

  const notSupported = useCallback(
    () => toast.info("Contrôle en direct non disponible avec ce backend"),
    [],
  )
  const pauseDownload = notSupported
  const resumeDownload = notSupported
  const cancelDownload = useCallback((id: string) => {
    setHidden((h) => new Set(h).add(id))
    toast.info("Retiré de la liste (le téléchargement en cours n'est pas interrompu)")
  }, [])
  const removeDownload = useCallback((id: string) => {
    setHidden((h) => new Set(h).add(id))
  }, [])
  const reorderDownloads = useCallback(() => {}, [])
  const pauseAll = notSupported
  const resumeAll = notSupported

  const retryDownload = useCallback(
    (id: string) => {
      const j = jobs.find((x) => x.id === id)
      if (!j) return
      backend.download({ url: j.url, quality: j.quality, format: "MP4" }).then(() => refreshJobs())
      toast.info("Téléchargement relancé")
    },
    [jobs, refreshJobs],
  )

  const clearCompleted = useCallback(() => {
    const done = jobs.filter((j) => j.status === "done").map((j) => j.id)
    setHidden((h) => new Set([...h, ...done]))
    toast.success("Terminés masqués")
  }, [jobs])

  const setMaxConcurrent = useCallback((n: number) => setLocal((l) => ({ ...l, maxConcurrent: n })), [])
  const setBandwidthLimit = useCallback(
    (n: number) => setLocal((l) => ({ ...l, bandwidthLimit: n ? String(n) : "" })),
    [],
  )

  const updateSettings = useCallback((patch: Partial<Settings> & { checkIntervalHours?: number }) => {
    setLocal((l) => ({ ...l, ...patch }))
    const b: Record<string, unknown> = {}
    if (patch.defaultQuality) b.default_quality = qualityToBackend(patch.defaultQuality)
    if (patch.organizeBySubfolder !== undefined) b.organize = patch.organizeBySubfolder ? "playlist" : "flat"
    if (patch.checkIntervalHours !== undefined)
      b.watch_interval_minutes = Math.max(1, Math.round(patch.checkIntervalHours * 60))
    if (Object.keys(b).length) backend.saveSettings(b).then(setBset).catch(() => {})
  }, [])

  // --- subscription actions ---
  const toggleSubscription = useCallback(
    (id: string) => {
      const w = watches.find((x) => x.id === id)
      if (!w) return
      backend.patchWatch(id, { enabled: !w.enabled }).then(() => refreshWatches())
    },
    [watches, refreshWatches],
  )

  const checkSubscriptionNow = useCallback(
    async (id: string) => {
      if (checking.current.has(id)) return
      checking.current.add(id)
      const w = watches.find((x) => x.id === id)
      toast.loading(`Vérification de ${w?.title ?? "l'abonnement"}…`, { id })
      try {
        await backend.checkWatch(id)
        toast.success("Vérification lancée", { id, description: w?.title })
        setTimeout(() => {
          refreshWatches()
          refreshJobs()
        }, 1500)
      } finally {
        checking.current.delete(id)
      }
    },
    [watches, refreshWatches, refreshJobs],
  )

  const updateSubscription = useCallback(
    (id: string, patch: Partial<Subscription>) => {
      const b: Record<string, unknown> = {}
      if (patch.defaultQuality) b.quality = qualityToBackend(patch.defaultQuality)
      const ops: Promise<unknown>[] = []
      if (Object.keys(b).length) ops.push(backend.patchWatch(id, b))
      if (patch.checkIntervalHours !== undefined)
        ops.push(
          backend
            .saveSettings({ watch_interval_minutes: Math.max(1, Math.round(patch.checkIntervalHours * 60)) })
            .then(setBset),
        )
      Promise.all(ops).then(() => refreshWatches())
    },
    [refreshWatches],
  )

  const removeSubscription = useCallback(
    (id: string) => {
      backend.removeWatch(id).then(() => refreshWatches())
      toast.success("Abonnement supprimé")
    },
    [refreshWatches],
  )

  const addSubscription = useCallback(
    (sub: Subscription) => {
      backend
        .addWatch({
          url: sub.url,
          quality: qualityToBackend(sub.defaultQuality),
          backfill: true,
          subfolder: "",
          date_after: "",
        })
        .then((res) => {
          if ((res as { error?: string }).error) {
            toast.error((res as { error?: string }).error!)
            return
          }
          toast.success("Abonnement ajouté", { description: sub.name })
          refreshWatches()
        })
    },
    [refreshWatches],
  )

  const value: StoreValue = {
    downloads,
    subscriptions,
    settings,
    maxConcurrent: settings.maxConcurrent,
    bandwidthLimit: Number(settings.bandwidthLimit) || 0,
    globalPaused,
    activeCount,
    totalSpeed,
    addDownload,
    pauseDownload,
    resumeDownload,
    cancelDownload,
    retryDownload,
    removeDownload,
    reorderDownloads,
    clearCompleted,
    pauseAll: () => {
      setGlobalPaused(true)
      pauseAll()
    },
    resumeAll: () => {
      setGlobalPaused(false)
      resumeAll()
    },
    setMaxConcurrent,
    setBandwidthLimit,
    updateSettings,
    toggleSubscription,
    checkSubscriptionNow,
    updateSubscription,
    removeSubscription,
    addSubscription,
  }

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

export function useStore() {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error("useStore must be used within StoreProvider")
  return ctx
}
