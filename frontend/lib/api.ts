/**
 * Frontend API layer — wired to the FastAPI/yt-dlp backend (served same-origin).
 */
import { backend, qualityToBackend, type ExtractedVideo } from "./backend"
import type {
  ChannelPreview,
  ChannelResult,
  PlaylistPreview,
  UrlKind,
  VideoPreview,
} from "./types"

/** Détecte le type d'une URL collée (vidéo / chaîne / playlist). */
export function detectUrlKind(url: string): UrlKind {
  const u = url.trim().toLowerCase()
  if (!u) return "unknown"
  if (u.includes("list=") || u.includes("/playlist")) return "playlist"
  if (u.includes("/@") || u.includes("/channel/") || u.includes("/c/") || u.includes("/user/"))
    return "channel"
  if (u.includes("watch?v=") || u.includes("youtu.be/") || /^https?:\/\//.test(u)) return "video"
  return "unknown"
}

/** Devine la source (plateforme) à partir d'une URL. */
export function detectSource(url: string): string {
  const u = url.toLowerCase()
  if (u.includes("youtu")) return "youtube"
  if (u.includes("vimeo")) return "vimeo"
  if (u.includes("twitch")) return "twitch"
  if (u.includes("dailymotion")) return "dailymotion"
  if (u.includes("tiktok")) return "tiktok"
  if (u.includes("france.tv") || u.includes("francetv")) return "france.tv"
  try {
    return new URL(url).hostname.replace("www.", "").split(".")[0]
  } catch {
    return "inconnu"
  }
}

/**
 * A bare channel URL (e.g. ".../@name") extracts to the channel's *tabs*
 * (Videos / Shorts / Playlists) — which all share the channel id and aren't
 * individual videos. Target the Videos tab so we list real, uniquely-id'd
 * videos instead.
 */
function channelVideosUrl(url: string): string {
  const TABS = ["videos", "shorts", "streams", "playlists", "featured", "community"]
  try {
    const u = new URL(url.trim())
    const segs = u.pathname.replace(/\/+$/, "").split("/").filter(Boolean)
    if (segs.some((s) => TABS.includes(s.toLowerCase()))) return url.trim()
    u.pathname = `${u.pathname.replace(/\/+$/, "")}/videos`
    return u.toString()
  } catch {
    return url
  }
}

function toPreview(v: ExtractedVideo, index = 0): VideoPreview {
  return {
    // Guarantee a unique selection key even if the backend repeats/omits ids.
    id: v.id ? `${v.id}-${index}` : `v-${index}`,
    title: v.title || "Sans titre",
    thumbnail: v.thumbnail || "/placeholder.svg",
    duration: v.duration || "",
    channel: v.channel || "",
    source: v.source || detectSource(v.url || ""),
    url: v.url || undefined,
    uploaded: v.uploaded || undefined,
  }
}

/** Récupère un aperçu (métadonnées) pour une URL vidéo. */
export async function fetchUrlMetadata(url: string): Promise<VideoPreview> {
  const d = await backend.extract(url)
  if (d.error) throw new Error(d.error)
  // If a playlist URL was pasted into the single-video flow, preview the first.
  if (d.kind === "playlist" && d.videos?.length) return toPreview(d.videos[0])
  return toPreview(d)
}

/** Métadonnées légères d'une chaîne (nom, logo, compteurs) — SANS énumérer
 *  toutes ses vidéos, pour un affichage rapide de la fiche. */
export async function fetchChannelInfo(channelUrl: string): Promise<ChannelPreview> {
  const d = await backend.channelInfo(channelUrl)
  if (d.error) throw new Error(d.error)
  const fmtCount = (n?: number | null) =>
    typeof n === "number" ? n.toLocaleString("fr-FR") : "—"
  return {
    id: channelUrl,
    name: d.name || "Chaîne",
    avatar: d.avatar || "",
    url: channelUrl,
    subscribers: fmtCount(d.subscribers),
    videoCount: typeof d.count === "number" ? d.count : 0,
    description: "",
  }
}

/** Récupère l'aperçu d'une chaîne et ses dernières vidéos. */
export async function fetchChannelVideos(
  channelUrl: string,
): Promise<{ channel: ChannelPreview; videos: VideoPreview[] }> {
  const d = await backend.extract(channelVideosUrl(channelUrl))
  if (d.error) throw new Error(d.error)
  const videos = (d.videos ?? []).map(toPreview)
  const channel: ChannelPreview = {
    id: channelUrl,
    name: d.title || d.uploader || "Chaîne",
    avatar: d.avatar || "",
    url: channelUrl,
    subscribers: "—",
    videoCount: d.count ?? videos.length,
    description: d.uploader || "",
  }
  return { channel, videos }
}

/** Récupère les vidéos d'une playlist. */
export async function fetchPlaylistVideos(
  url: string,
): Promise<{ playlist: PlaylistPreview; videos: VideoPreview[] }> {
  const d = await backend.extract(url)
  if (d.error) throw new Error(d.error)
  const videos = (d.videos ?? []).map(toPreview)
  const playlist: PlaylistPreview = {
    id: url,
    title: d.title || "Playlist",
    thumbnail: d.thumbnail || videos[0]?.thumbnail || "",
    url,
    channel: d.uploader || "",
    videoCount: d.count ?? videos.length,
  }
  return { playlist, videos }
}

/** Recherche YouTube par texte libre : renvoie des vidéos et les chaînes. */
export async function searchYoutube(
  query: string,
): Promise<{ videos: VideoPreview[]; channels: ChannelResult[] }> {
  const d = await backend.search(query)
  if (d.error) throw new Error(d.error)
  return {
    videos: (d.videos ?? []).map(toPreview),
    channels: (d.channels ?? []).map((c) => ({ name: c.name, url: c.url })),
  }
}

export interface StartDownloadOptions {
  url: string
  title?: string
  thumbnail?: string
  quality: string
  format: string
  channel?: string
}

/** Lance un téléchargement réel via le backend. */
export async function startDownload(
  options: StartDownloadOptions,
): Promise<{ job_id?: string; error?: string }> {
  return backend.download({
    url: options.url,
    quality: qualityToBackend(options.quality),
    format: options.format,
  })
}

/** Lit le presse-papier et renvoie une URL vidéo si détectée. */
export async function readClipboardUrl(): Promise<string | null> {
  try {
    if (typeof navigator === "undefined" || !navigator.clipboard?.readText) return null
    const text = await navigator.clipboard.readText()
    if (/^https?:\/\/\S+$/.test(text.trim())) return text.trim()
    return null
  } catch {
    return null
  }
}
