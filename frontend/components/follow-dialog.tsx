"use client"

import { useState } from "react"
import { BellPlusIcon, CalendarIcon, CheckIcon, HistoryIcon, RssIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import type { BackfillOptions } from "@/components/store-provider"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

type Mode = "future" | "all" | "since"

const OPTIONS: { id: Mode; icon: typeof RssIcon; title: string; desc: string }[] = [
  {
    id: "future",
    icon: RssIcon,
    title: "Seulement les prochaines",
    desc: "Ignore l'historique, ne télécharge que les nouvelles vidéos à venir.",
  },
  {
    id: "all",
    icon: HistoryIcon,
    title: "Toutes les anciennes",
    desc: "Télécharge tout l'historique de la chaîne, puis les nouveautés.",
  },
  {
    id: "since",
    icon: CalendarIcon,
    title: "À partir d'une date",
    desc: "Télécharge les vidéos publiées après une date précise, puis les nouveautés.",
  },
]

export function FollowDialog({
  open,
  onOpenChange,
  channelName,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  channelName: string
  onConfirm: (opts: BackfillOptions) => void
}) {
  const [mode, setMode] = useState<Mode>("future")
  const [date, setDate] = useState("")

  function confirm() {
    const opts: BackfillOptions =
      mode === "future"
        ? { backfill: false }
        : mode === "all"
          ? { backfill: true }
          : { backfill: true, dateAfter: date }
    onConfirm(opts)
    onOpenChange(false)
  }

  const sinceInvalid = mode === "since" && !date

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BellPlusIcon className="size-5" /> Suivre la chaîne
          </DialogTitle>
          <DialogDescription>
            {channelName} — que faut-il télécharger&nbsp;?
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 py-2">
          {OPTIONS.map((o) => {
            const Icon = o.icon
            const selected = mode === o.id
            return (
              <button
                key={o.id}
                type="button"
                onClick={() => setMode(o.id)}
                className={cn(
                  "flex items-start gap-3 rounded-lg border p-3 text-left transition-colors",
                  selected
                    ? "border-primary/50 bg-primary/5"
                    : "border-border hover:bg-muted/50",
                )}
              >
                <Icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{o.title}</span>
                    {selected && <CheckIcon className="size-4 text-primary" />}
                  </div>
                  <p className="text-xs text-muted-foreground">{o.desc}</p>
                </div>
              </button>
            )
          })}

          {mode === "since" && (
            <div className="mt-1 flex flex-col gap-1.5 pl-1">
              <Label htmlFor="follow-date">Télécharger à partir du</Label>
              <Input
                id="follow-date"
                type="date"
                value={date}
                max={new Date().toISOString().slice(0, 10)}
                onChange={(e) => setDate(e.target.value)}
                className="w-48"
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Annuler
          </Button>
          <Button onClick={confirm} disabled={sinceInvalid}>
            <BellPlusIcon data-icon="inline-start" />
            Suivre
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
