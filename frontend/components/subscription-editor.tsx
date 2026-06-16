"use client"

import { useEffect, useState } from "react"

import type { Subscription, SubscriptionFilters } from "@/lib/types"
import { useStore } from "@/components/store-provider"
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
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import { QualitySelect, FormatSelect } from "@/components/option-selects"

export function SubscriptionEditor({
  subscription,
  open,
  onOpenChange,
}: {
  subscription: Subscription | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { updateSubscription } = useStore()
  const [interval, setInterval] = useState(6)
  const [quality, setQuality] = useState("Auto")
  const [format, setFormat] = useState("MP4")
  const [dateAfter, setDateAfter] = useState("")
  const [filters, setFilters] = useState<SubscriptionFilters>({
    excludeShorts: false,
    excludeLives: false,
    includeKeywords: [],
    excludeKeywords: [],
  })

  useEffect(() => {
    if (!subscription) return
    setInterval(subscription.checkIntervalHours)
    setQuality(subscription.defaultQuality)
    setFormat(subscription.defaultFormat)
    setDateAfter(subscription.dateAfter ?? "")
    setFilters(subscription.filters)
  }, [subscription])

  function patchFilters(p: Partial<SubscriptionFilters>) {
    setFilters((f) => ({ ...f, ...p }))
  }

  function save() {
    if (!subscription) return
    updateSubscription(subscription.id, {
      checkIntervalHours: interval,
      defaultQuality: quality,
      defaultFormat: format,
      dateAfter,
      filters,
    })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Réglages de l&apos;abonnement</DialogTitle>
          <DialogDescription>{subscription?.name}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label>Vérifier toutes les (h)</Label>
              <Input
                type="number"
                min={1}
                value={interval}
                onChange={(e) => setInterval(Number(e.target.value))}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Garder les N dernières</Label>
              <Input
                type="number"
                min={0}
                value={filters.keepLastN ?? 0}
                onChange={(e) =>
                  patchFilters({ keepLastN: Number(e.target.value) || undefined })
                }
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-sm">Qualité</span>
            <QualitySelect value={quality} onChange={setQuality} size="sm" />
            <span className="text-sm">Format</span>
            <FormatSelect value={format} onChange={setFormat} size="sm" />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Télécharger à partir du (laisser vide = tout)</Label>
            <div className="flex items-center gap-2">
              <Input
                type="date"
                value={dateAfter}
                max={new Date().toISOString().slice(0, 10)}
                onChange={(e) => setDateAfter(e.target.value)}
                className="w-48"
              />
              {dateAfter && (
                <Button variant="ghost" size="sm" onClick={() => setDateAfter("")}>
                  Effacer
                </Button>
              )}
            </div>
          </div>

          <Separator />

          <div className="flex items-center justify-between">
            <Label>Exclure les Shorts</Label>
            <Switch
              checked={filters.excludeShorts}
              onCheckedChange={(v) => patchFilters({ excludeShorts: v })}
            />
          </div>
          <div className="flex items-center justify-between">
            <Label>Exclure les Lives</Label>
            <Switch
              checked={filters.excludeLives}
              onCheckedChange={(v) => patchFilters({ excludeLives: v })}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label>Durée min (min)</Label>
              <Input
                type="number"
                min={0}
                value={filters.minDuration ?? ""}
                onChange={(e) =>
                  patchFilters({ minDuration: e.target.value ? Number(e.target.value) : undefined })
                }
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Durée max (min)</Label>
              <Input
                type="number"
                min={0}
                value={filters.maxDuration ?? ""}
                onChange={(e) =>
                  patchFilters({ maxDuration: e.target.value ? Number(e.target.value) : undefined })
                }
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Mots-clés à inclure (séparés par virgule)</Label>
            <Input
              value={filters.includeKeywords.join(", ")}
              onChange={(e) =>
                patchFilters({
                  includeKeywords: e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
                })
              }
              placeholder="tutoriel, review"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Mots-clés à exclure</Label>
            <Input
              value={filters.excludeKeywords.join(", ")}
              onChange={(e) =>
                patchFilters({
                  excludeKeywords: e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
                })
              }
              placeholder="teaser, annonce"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Annuler
          </Button>
          <Button onClick={save}>Enregistrer</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
