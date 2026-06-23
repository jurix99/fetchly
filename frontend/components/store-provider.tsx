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

/** Live progress of a subscription's background sync/backfill job. */
export interface WatchProgress {
  active: boolean // job running/queued (may just be listing/checking)
  downloading: boolean // actually downloading a video right now
  percent: number
  currentTitle: string
  completed: number
  total: number
}

interface StoreValue {
  downloads: DownloadItem[]
  subscriptions: Subscription[]
  watchProgress: Record<string, WatchProgress>
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
  addSubscription: (sub: Subscription, opts?: BackfillOptions) => void
}

/** How much of a channel's back-catalogue to grab when first following it. */
export interface BackfillOptions {
  // true  -> download existing videos (optionally only those after `dateAfter`)
  // false -> seed only: ignore the back-catalogue, grab future uploads only
  backfill?: boolean
  dateAfter?: string // ISO "YYYY-MM-DD"; only with backfill
}

const StoreContext = createContext<StoreValue | null>(null)

const STATUS_MAP: Record<BackendJob["status"], DownloadStatus> = {
  queued: "queued",
  running: "downloading",
  done: "completed",
  error: "failed",
}

/** Extract a YouTube video id from a watch/share URL, if present. */
function youtubeId(url: string): string | null {
  const m =
    url.match(/[?&]v=([\w-]{11})/) ||
    url.match(/youtu\.be\/([\w-]{11})/) ||
    url.match(/\/(?:shorts|embed)\/([\w-]{11})/)
  return m ? m[1] : null
}

/** A thumbnail URL for a single YouTube video job (empty for channels/playlists). */
function youtubeThumb(url: string): string {
  const id = youtubeId(url)
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : ""
}

/** Readable fallback name for a subscription before its title is synced:
 *  "@handle" / channel slug rather than the full URL. */
function channelHandle(url: string): string {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, "")
    const seg = path.split("/").filter(Boolean)
    const at = seg.find((s) => s.startsWith("@"))
    if (at) return at
    return seg[seg.length - 1] || url
  } catch {
    return url
  }
}

function jobToDownload(j: BackendJob): DownloadItem {
  // While ffmpeg merges/converts after the streams are downloaded, show
  // "converting" rather than a stuck-looking 100% download. The post-processor
  // signal (phase) can be missed between polls, so also treat a running job
  // whose download already hit 100% as converting.
  const downloadComplete = (j.current_percent || 0) >= 99.5
  const status: DownloadStatus =
    j.status === "running" && (j.phase === "processing" || downloadComplete)
      ? "converting"
      : STATUS_MAP[j.status] ?? "queued"
  const isWatch = j.kind === "watch"
  return {
    id: j.id,
    // A watch job downloads a whole channel/playlist: show its name (or the
    // current video), never the raw channel URL.
    title: j.current_title || (isWatch ? j.playlist_title || "Synchronisation de l'abonnement" : j.url),
    // Thumbnail of the video currently downloading (set by the backend), with a
    // fallback to deriving it from a single-video job's own URL.
    thumbnail: j.current_thumbnail || (isWatch ? "" : youtubeThumb(j.url)),
    sourceUrl: j.url,
    source: detectSource(j.url),
    channel: isWatch ? "Abonnement" : undefined,
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
    name: w.title || channelHandle(w.url),
    avatar: w.thumbnail || "",
    url: w.url,
    checkIntervalHours: intervalHours,
    active: w.enabled,
    lastChecked: w.last_checked || new Date().toISOString(),
    dateAfter: w.date_after || "",
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
    // maxConcurrent is backend-persisted; leave it unset so the saved value wins.
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
      // Media options are now backend-persisted; prefer the saved value (bset),
      // falling back to any optimistic local edit, then the default.
      subtitles: {
        enabled: bset?.subtitles ?? !!local.subtitles?.enabled,
        languages: (bset?.subtitle_langs ?? local.subtitles?.languages?.join(",") ?? "fr,en")
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
        embed: bset?.embed_subtitles ?? !!local.subtitles?.embed,
      },
      embedMetadata: bset?.embed_metadata ?? !!local.embedMetadata,
      embedThumbnail: bset?.embed_thumbnail ?? local.embedThumbnail ?? true,
      embedChapters: bset?.embed_chapters ?? !!local.embedChapters,
      maxConcurrent: local.maxConcurrent ?? bset?.max_concurrent ?? 3,
      bandwidthLimit:
        local.bandwidthLimit ?? (bset?.bandwidth_limit ? String(bset.bandwidth_limit) : ""),
      sponsorBlock: bset?.sponsorblock ?? !!local.sponsorBlock,
      sponsorBlockMode: bset?.sponsorblock_mode || local.sponsorBlockMode || "skip",
      cookiesImport: !!local.cookiesImport,
      downloadArchive: bset?.download_archive ?? local.downloadArchive ?? true,
      nfoExport: bset?.nfo_export ?? !!local.nfoExport,
      theme: local.theme || "dark",
      // extra (read by settings-view)
      ...( { checkIntervalHours: local.checkIntervalHours ?? intervalHours } as object),
    }),
    [bset, local, intervalHours],
  )

  const downloads = useMemo(
    // Manual downloads always show. Subscription syncs show only while they're
    // actually downloading a video (current_title set) — so the live download
    // is visible, but a bare "checking" job doesn't clutter the list with the
    // channel itself.
    () =>
      jobs
        .filter((j) => !hidden.has(j.id) && (j.kind !== "watch" || !!j.current_title))
        .map(jobToDownload),
    [jobs, hidden],
  )
  const subscriptions = useMemo(
    () => watches.map((w) => watchToSub(w, intervalHours)),
    [watches, intervalHours],
  )

  // Per-watch sync progress for the Abonnements card. Each subscription now
  // backfills as MANY single-video jobs, so we aggregate them per watch_id:
  // how many are done out of the batch, and whether any is downloading now.
  const watchProgress = useMemo(() => {
    type Acc = {
      total: number
      done: number
      active: boolean
      downloading: boolean
      currentTitle: string
    }
    const acc: Record<string, Acc> = {}
    for (const j of jobs) {
      if (j.kind !== "watch" || !j.watch_id) continue
      const a = (acc[j.watch_id] ??= {
        total: 0,
        done: 0,
        active: false,
        downloading: false,
        currentTitle: "",
      })
      a.total += 1
      if (j.status === "done") a.done += 1
      const running = j.status === "running" || j.status === "queued"
      if (running) a.active = true
      const dl = running && j.current_percent > 0 && (!!j.current_speed || j.current_percent < 100)
      if (dl) {
        a.downloading = true
        a.currentTitle = j.current_title || a.currentTitle
      }
    }
    const map: Record<string, WatchProgress> = {}
    for (const [id, a] of Object.entries(acc)) {
      map[id] = {
        active: a.active,
        downloading: a.downloading,
        percent: a.total ? Math.round((a.done / a.total) * 100) : 0,
        currentTitle: a.currentTitle,
        completed: a.done,
        total: a.total,
      }
    }
    return map
  }, [jobs])

  const activeCount = useMemo(
    () =>
      jobs.filter(
        (j: BackendJob) =>
          (j.kind !== "watch" || !!j.current_title) &&
          (j.status === "running" || j.status === "queued"),
      ).length,
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

  const setMaxConcurrent = useCallback((n: number) => {
    setLocal((l) => ({ ...l, maxConcurrent: n }))
    backend.saveSettings({ max_concurrent: Math.max(1, n) }).then(setBset).catch(() => {})
  }, [])
  const setBandwidthLimit = useCallback((n: number) => {
    setLocal((l) => ({ ...l, bandwidthLimit: n ? String(n) : "" }))
    backend.saveSettings({ bandwidth_limit: n > 0 ? n : 0 }).then(setBset).catch(() => {})
  }, [])

  const updateSettings = useCallback((patch: Partial<Settings> & { checkIntervalHours?: number }) => {
    setLocal((l) => ({ ...l, ...patch }))
    const b: Record<string, unknown> = {}
    if (patch.defaultQuality) b.default_quality = qualityToBackend(patch.defaultQuality)
    if (patch.organizeBySubfolder !== undefined) b.organize = patch.organizeBySubfolder ? "playlist" : "flat"
    if (patch.checkIntervalHours !== undefined)
      b.watch_interval_minutes = Math.max(1, Math.round(patch.checkIntervalHours * 60))
    // Media options → backend keys.
    if (patch.subtitles) {
      b.subtitles = !!patch.subtitles.enabled
      b.subtitle_langs = (patch.subtitles.languages || []).join(",") || "fr,en"
      b.embed_subtitles = !!patch.subtitles.embed
    }
    if (patch.embedMetadata !== undefined) b.embed_metadata = patch.embedMetadata
    if (patch.embedThumbnail !== undefined) b.embed_thumbnail = patch.embedThumbnail
    if (patch.embedChapters !== undefined) b.embed_chapters = patch.embedChapters
    if (patch.sponsorBlock !== undefined) b.sponsorblock = patch.sponsorBlock
    if (patch.sponsorBlockMode !== undefined) b.sponsorblock_mode = patch.sponsorBlockMode
    if (patch.downloadArchive !== undefined) b.download_archive = patch.downloadArchive
    if (patch.nfoExport !== undefined) b.nfo_export = patch.nfoExport
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
      if (patch.dateAfter !== undefined) b.date_after = patch.dateAfter
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
    (sub: Subscription, opts?: BackfillOptions) => {
      backend
        .addWatch({
          url: sub.url,
          quality: qualityToBackend(sub.defaultQuality),
          backfill: opts?.backfill ?? true,
          subfolder: "",
          date_after: opts?.dateAfter ?? "",
          // Show the name + logo immediately, before the first sync fills them in.
          title: sub.name,
          thumbnail: sub.avatar,
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
    watchProgress,
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
