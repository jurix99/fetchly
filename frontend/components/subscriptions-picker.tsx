"use client"

import { useEffect, useMemo, useState } from "react"
import { BellPlusIcon, Loader2Icon, SearchIcon } from "lucide-react"
import { toast } from "sonner"

import { backend, type SubscribedChannel } from "@/lib/backend"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"

/**
 * Lists the user's YouTube subscriptions and lets them pick which channels to
 * follow. Already-followed channels are shown checked + disabled. Following is
 * future-uploads-only (no back-catalogue download) — the chosen channels become
 * watches the scheduler syncs automatically.
 */
export function SubscriptionsPicker({
  open,
  onOpenChange,
  onFollowed,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onFollowed?: () => void
}) {
  const [channels, setChannels] = useState<SubscribedChannel[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [following, setFollowing] = useState(false)

  useEffect(() => {
    if (!open) return
    setChannels(null)
    setError(null)
    setSelected(new Set())
    setQuery("")
    setLoading(true)
    backend
      .youtubeSubscriptions()
      .then((res) => {
        if (res.error) setError(res.error)
        else setChannels(res.channels ?? [])
      })
      .catch(() => setError("Échec du chargement des abonnements"))
      .finally(() => setLoading(false))
  }, [open])

  const filtered = useMemo(() => {
    const list = channels ?? []
    const q = query.trim().toLowerCase()
    return q ? list.filter((c) => c.name.toLowerCase().includes(q)) : list
  }, [channels, query])

  const selectable = useMemo(() => filtered.filter((c) => !c.followed), [filtered])
  const allSelected = selectable.length > 0 && selectable.every((c) => selected.has(c.url))

  function toggle(url: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(url)) next.delete(url)
      else next.add(url)
      return next
    })
  }

  function toggleAll() {
    setSelected((prev) => {
      if (selectable.every((c) => prev.has(c.url))) {
        const next = new Set(prev)
        selectable.forEach((c) => next.delete(c.url))
        return next
      }
      const next = new Set(prev)
      selectable.forEach((c) => next.add(c.url))
      return next
    })
  }

  async function followSelection() {
    const chosen = (channels ?? []).filter((c) => selected.has(c.url))
    if (chosen.length === 0) return
    setFollowing(true)
    try {
      const res = await backend.followSubscriptions(
        chosen.map((c) => ({ url: c.url, title: c.name, avatar: c.avatar })),
        false,
      )
      if (res.error) {
        toast.error(res.error)
      } else {
        toast.success(
          `${res.added ?? chosen.length} chaîne(s) suivie(s) — nouvelles vidéos seulement. La synchro démarre sous peu.`,
        )
        onFollowed?.()
        onOpenChange(false)
      }
    } catch {
      toast.error("Échec de l'abonnement")
    } finally {
      setFollowing(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Mes abonnements YouTube</DialogTitle>
          <DialogDescription>
            Choisis les chaînes à suivre. Les nouvelles vidéos se téléchargeront
            automatiquement (le contenu actuel n&apos;est pas récupéré).
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" />
            Chargement de tes abonnements…
          </div>
        )}

        {error && !loading && (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
        )}

        {channels && !loading && (
          <>
            <div className="relative">
              <SearchIcon className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filtrer par nom…"
                className="h-9 pl-8"
              />
            </div>

            <div className="flex items-center justify-between px-1 text-xs text-muted-foreground">
              <button
                type="button"
                className="font-medium hover:text-foreground disabled:opacity-50"
                onClick={toggleAll}
                disabled={selectable.length === 0}
              >
                {allSelected ? "Tout désélectionner" : "Tout sélectionner"}
              </button>
              <span>{channels.length} abonnement(s)</span>
            </div>

            <div className="-mx-2 flex flex-col gap-0.5 overflow-y-auto px-2">
              {filtered.map((c) => {
                const checked = c.followed || selected.has(c.url)
                return (
                  <label
                    key={c.url}
                    className={`flex items-center gap-3 rounded-lg p-2 ${
                      c.followed ? "opacity-60" : "cursor-pointer hover:bg-muted/50"
                    }`}
                  >
                    <Checkbox
                      checked={checked}
                      disabled={c.followed}
                      onCheckedChange={() => !c.followed && toggle(c.url)}
                    />
                    <Avatar className="size-8">
                      {c.avatar ? <AvatarImage src={c.avatar} alt={c.name} /> : null}
                      <AvatarFallback className="text-xs font-medium">
                        {c.name.charAt(0).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{c.name}</span>
                    {c.followed && <span className="text-xs text-muted-foreground">Déjà suivi</span>}
                  </label>
                )
              })}
              {filtered.length === 0 && (
                <p className="py-6 text-center text-sm text-muted-foreground">Aucune chaîne</p>
              )}
            </div>
          </>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={following}>
            Annuler
          </Button>
          <Button onClick={() => void followSelection()} disabled={following || selected.size === 0}>
            {following ? <Loader2Icon className="size-4 animate-spin" /> : <BellPlusIcon className="size-4" />}
            Suivre la sélection ({selected.size})
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
