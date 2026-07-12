/**
 * Client-side "Reprendre" memory: the last playback position per content, kept
 * in localStorage (no server round-trip, no telemetry). Powers the Library
 * "Reprendre" block and resume-on-open.
 */

const KEY = "fetchly:playback"
const MAX_ENTRIES = 50
/** Below this fraction we don't consider a content "started"; above ~95% it's
 *  effectively finished, so it drops out of "Reprendre". */
const MIN_SECONDS = 5

export interface PlaybackEntry {
  id: string
  position: number // seconds
  duration: number // seconds (0 if unknown)
  updatedAt: number // epoch ms
}

type Store = Record<string, PlaybackEntry>

function read(): Store {
  if (typeof window === "undefined") return {}
  try {
    return JSON.parse(window.localStorage.getItem(KEY) || "{}") as Store
  } catch {
    return {}
  }
}

function write(store: Store) {
  if (typeof window === "undefined") return
  // Cap the store to the most-recent entries so it can't grow unbounded.
  const entries = Object.values(store).sort((a, b) => b.updatedAt - a.updatedAt)
  const trimmed: Store = {}
  for (const e of entries.slice(0, MAX_ENTRIES)) trimmed[e.id] = e
  try {
    window.localStorage.setItem(KEY, JSON.stringify(trimmed))
  } catch {
    /* quota — ignore */
  }
}

export function getPlaybackPosition(id: string): number {
  return read()[id]?.position ?? 0
}

/** Record progress. Finished (or barely-started) content is pruned so it never
 *  clutters "Reprendre". Callers should throttle (e.g. every few seconds). */
export function savePlaybackPosition(id: string, position: number, duration = 0) {
  if (!id) return
  const store = read()
  const nearEnd = duration > 0 && position >= duration * 0.95
  if (position < MIN_SECONDS || nearEnd) {
    if (store[id]) {
      delete store[id]
      write(store)
    }
    return
  }
  store[id] = { id, position, duration, updatedAt: Date.now() }
  write(store)
}

export function clearPlaybackPosition(id: string) {
  const store = read()
  if (store[id]) {
    delete store[id]
    write(store)
  }
}

/** Most-recently-played contents (for the "Reprendre" block), newest first. */
export function getRecentlyPlayed(limit = 3): PlaybackEntry[] {
  return Object.values(read())
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit)
}
