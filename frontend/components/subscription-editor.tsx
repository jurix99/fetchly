"use client"

import { useEffect, useMemo, useState } from "react"
import {
  ChevronDownIcon,
  FlaskConicalIcon,
  Loader2Icon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import type { Subscription, SubscriptionFilters } from "@/lib/types"
import {
  backend,
  filtersToBackend,
  type PreviewFiltersResult,
} from "@/lib/backend"
import { useStore } from "@/components/store-provider"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import { QualitySelect, FormatSelect } from "@/components/option-selects"

const EMPTY_FILTERS: SubscriptionFilters = {
  excludeShorts: false,
  excludeLives: false,
  includeKeywords: [],
  excludeKeywords: [],
}

const REASON_FR: Record<string, string> = {
  duration: "durée",
  keyword: "mot-clé",
  short: "Short",
  live: "Live",
}

/** Human summary of the active filters, for the collapsed group header. */
function filterSummary(f: SubscriptionFilters): string[] {
  const parts: string[] = []
  if (f.minDuration) parts.push(`> ${f.minDuration} min`)
  if (f.maxDuration) parts.push(`< ${f.maxDuration} min`)
  if (f.excludeShorts) parts.push("sans shorts")
  if (f.excludeLives) parts.push("sans lives")
  if (f.includeKeywords.length) parts.push(`${f.includeKeywords.length} mot-clé requis`)
  if (f.excludeKeywords.length) parts.push(`${f.excludeKeywords.length} exclu`)
  if (f.keepLastN) parts.push(`garder ${f.keepLastN}`)
  return parts
}

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
  const [interval, setIntervalHours] = useState(6)
  const [quality, setQuality] = useState("Auto")
  const [format, setFormat] = useState("MP4")
  const [dateAfter, setDateAfter] = useState("")
  const [filters, setFilters] = useState<SubscriptionFilters>(EMPTY_FILTERS)
  const [showFilters, setShowFilters] = useState(true)
  const [preview, setPreview] = useState<PreviewFiltersResult | null>(null)
  const [previewing, setPreviewing] = useState(false)

  useEffect(() => {
    if (!subscription) return
    setIntervalHours(subscription.checkIntervalHours)
    setQuality(subscription.defaultQuality)
    setFormat(subscription.defaultFormat)
    setDateAfter(subscription.dateAfter ?? "")
    setFilters(subscription.filters ?? EMPTY_FILTERS)
    setPreview(null)
  }, [subscription])

  function patchFilters(p: Partial<SubscriptionFilters>) {
    setFilters((f) => ({ ...f, ...p }))
    setPreview(null) // filters changed — the preview is stale
  }

  const summary = useMemo(() => filterSummary(filters), [filters])

  async function testFilters() {
    if (!subscription) return
    setPreviewing(true)
    setPreview(null)
    try {
      const r = await backend.previewFilters(subscription.url, filtersToBackend(filters))
      if (r.error) toast.error(r.error)
      else setPreview(r)
    } catch {
      toast.error("Échec du test des filtres")
    } finally {
      setPreviewing(false)
    }
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
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sub-interval">Vérifier toutes les (h)</Label>
            <Input
              id="sub-interval"
              type="number"
              min={1}
              value={interval}
              onChange={(e) => setIntervalHours(Number(e.target.value))}
              className="w-32"
            />
          </div>

          <div className="flex items-center gap-2">
            <span className="text-sm">Qualité</span>
            <QualitySelect value={quality} onChange={setQuality} size="sm" />
            <span className="text-sm">Format</span>
            <FormatSelect value={format} onChange={setFormat} size="sm" />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sub-date">Télécharger à partir du (laisser vide = tout)</Label>
            <div className="flex items-center gap-2">
              <Input
                id="sub-date"
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

          {/* --- Collapsible "Filtres" group --- */}
          <div className="flex flex-col gap-3">
            <button
              type="button"
              onClick={() => setShowFilters((s) => !s)}
              aria-expanded={showFilters}
              className="flex items-center gap-2 text-left"
            >
              <ChevronDownIcon
                className={cn(
                  "size-4 shrink-0 text-muted-foreground transition-transform",
                  !showFilters && "-rotate-90"
                )}
              />
              <span className="text-sm font-medium">Filtres</span>
              {!showFilters &&
                (summary.length ? (
                  <span className="truncate text-xs text-muted-foreground">
                    {summary.join(" · ")}
                  </span>
                ) : (
                  <Badge variant="secondary" className="text-[10px]">
                    Aucun filtre
                  </Badge>
                ))}
            </button>

            {showFilters && (
              <div className="flex flex-col gap-4 pl-6">
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="dmin">Durée min (min)</Label>
                    <Input
                      id="dmin"
                      type="number"
                      min={0}
                      value={filters.minDuration ?? ""}
                      onChange={(e) =>
                        patchFilters({
                          minDuration: e.target.value ? Number(e.target.value) : undefined,
                        })
                      }
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="dmax">Durée max (min)</Label>
                    <Input
                      id="dmax"
                      type="number"
                      min={0}
                      value={filters.maxDuration ?? ""}
                      onChange={(e) =>
                        patchFilters({
                          maxDuration: e.target.value ? Number(e.target.value) : undefined,
                        })
                      }
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <Label>Exclure les Shorts</Label>
                    <p className="text-xs text-muted-foreground">
                      Détectés par URL (/shorts/) et durée (≤ 60 s).
                    </p>
                  </div>
                  <Switch
                    checked={filters.excludeShorts}
                    onCheckedChange={(v) => patchFilters({ excludeShorts: v })}
                    aria-label="Exclure les Shorts"
                  />
                </div>
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <Label>Exclure les Lives</Label>
                    <p className="text-xs text-muted-foreground">
                      Directs et premières (et leurs rediffusions).
                    </p>
                  </div>
                  <Switch
                    checked={filters.excludeLives}
                    onCheckedChange={(v) => patchFilters({ excludeLives: v })}
                    aria-label="Exclure les Lives"
                  />
                </div>

                <KeywordField
                  label="Mots-clés à inclure"
                  help="Au moins un doit apparaître dans le titre (insensible casse/accents)."
                  values={filters.includeKeywords}
                  onChange={(v) => patchFilters({ includeKeywords: v })}
                />
                <KeywordField
                  label="Mots-clés à exclure"
                  help="Un seul suffit à rejeter la vidéo — l'exclusion l'emporte sur l'inclusion."
                  values={filters.excludeKeywords}
                  onChange={(v) => patchFilters({ excludeKeywords: v })}
                />

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="keepn">Garder les N dernières (0 = illimité)</Label>
                  <Input
                    id="keepn"
                    type="number"
                    min={0}
                    value={filters.keepLastN ?? 0}
                    onChange={(e) =>
                      patchFilters({ keepLastN: Number(e.target.value) || undefined })
                    }
                    className="w-32"
                  />
                  <p className="text-xs text-muted-foreground">
                    Après chaque sync, supprime du disque les fichiers les plus anciens
                    de ce dossier au-delà de N.
                  </p>
                </div>

                {/* --- Impact preview --- */}
                <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">Aperçu d&apos;impact</span>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={testFilters}
                      disabled={previewing}
                    >
                      {previewing ? (
                        <Loader2Icon data-icon="inline-start" className="animate-spin" />
                      ) : (
                        <FlaskConicalIcon data-icon="inline-start" />
                      )}
                      Tester les filtres
                    </Button>
                  </div>
                  {preview ? (
                    <div className="flex flex-col gap-2">
                      <p className="text-sm">
                        Sur les {preview.listed} dernières vidéos :{" "}
                        <span className="font-medium text-success">{preview.kept} gardées</span>
                        {" · "}
                        <span className="font-medium text-warning">
                          {preview.rejected} filtrées
                        </span>
                      </p>
                      {preview.rejections.length > 0 && (
                        <ul className="flex flex-col gap-1">
                          {preview.rejections.map((r, i) => (
                            <li
                              key={i}
                              className="flex items-center gap-2 text-xs text-muted-foreground"
                            >
                              <Badge variant="outline" className="shrink-0 text-[10px]">
                                {REASON_FR[r.reason] ?? r.reason}
                              </Badge>
                              <span className="truncate">{r.title}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Testez sur les ~30 dernières vidéos avant d&apos;enregistrer.
                    </p>
                  )}
                </div>
              </div>
            )}
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

/** Chip input: Enter adds a keyword, clicking a chip removes it. */
function KeywordField({
  label,
  help,
  values,
  onChange,
}: {
  label: string
  help?: string
  values: string[]
  onChange: (v: string[]) => void
}) {
  const [draft, setDraft] = useState("")

  function add() {
    const v = draft.trim()
    if (v && !values.includes(v)) onChange([...values, v])
    setDraft("")
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {values.map((k) => (
            <Badge
              key={k}
              variant="secondary"
              className="cursor-pointer gap-1"
              onClick={() => onChange(values.filter((x) => x !== k))}
            >
              {k}
              <XIcon className="size-3" />
            </Badge>
          ))}
        </div>
      )}
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            add()
          }
        }}
        placeholder="Entrée pour ajouter…"
      />
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
    </div>
  )
}
