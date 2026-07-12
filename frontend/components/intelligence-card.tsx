"use client"

import { useEffect, useMemo, useState } from "react"
import {
  CheckCircle2Icon,
  ExternalLinkIcon,
  LoaderIcon,
  SparklesIcon,
  TriangleAlertIcon,
  WandSparklesIcon,
} from "lucide-react"
import { toast } from "sonner"

import {
  backend,
  type IntelligencePreset,
  type IntelligenceSettings,
} from "@/lib/backend"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ConfirmDialog } from "@/components/confirm-dialog"

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok"; message: string }
  | { kind: "error"; message: string }

const LANGS = [
  ["auto", "Langue du contenu (auto)"],
  ["français", "Français"],
  ["anglais", "Anglais"],
  ["espagnol", "Espagnol"],
  ["allemand", "Allemand"],
  ["italien", "Italien"],
] as const

export function IntelligenceCard() {
  const [settings, setSettings] = useState<IntelligenceSettings | null>(null)
  const [presets, setPresets] = useState<IntelligencePreset[]>([])
  const [apiKey, setApiKey] = useState("") // empty = keep stored (masked)
  const [test, setTest] = useState<TestState>({ kind: "idle" })
  const [backfillOpen, setBackfillOpen] = useState(false)
  const [indexedCount, setIndexedCount] = useState<number | null>(null)

  useEffect(() => {
    backend.intelligence().then(setSettings).catch(() => {})
    backend.intelligencePresets().then((r) => setPresets(r.presets)).catch(() => {})
    backend.indexStats().then((s) => setIndexedCount(s.indexed)).catch(() => {})
  }, [])

  const preset = useMemo(
    () => presets.find((p) => p.id === settings?.preset),
    [presets, settings?.preset],
  )

  if (!settings) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <SparklesIcon className="size-4" /> Intelligence
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Chargement…</p>
        </CardContent>
      </Card>
    )
  }

  /** Persist a partial patch; reset the test result since config changed. */
  async function save(patch: Parameters<typeof backend.saveIntelligence>[0]) {
    setTest({ kind: "idle" })
    try {
      const next = await backend.saveIntelligence(patch)
      setSettings(next)
    } catch {
      toast.error("Enregistrement impossible")
    }
  }

  /** Choosing a preset pre-fills protocol + base_url + suggested model. */
  function choosePreset(id: string) {
    const p = presets.find((x) => x.id === id)
    if (!p) return
    setApiKey("")
    save({
      preset: id,
      protocol: p.protocol,
      base_url: p.base_url,
      model: p.model,
    })
  }

  async function runTest() {
    // Save any pending key first so the test uses the latest config.
    if (apiKey) {
      await save({ api_key: apiKey })
      setApiKey("")
    }
    setTest({ kind: "testing" })
    try {
      const r = await backend.testIntelligence()
      setTest(r.ok ? { kind: "ok", message: r.message } : { kind: "error", message: r.message })
    } catch {
      setTest({ kind: "error", message: "Test impossible" })
    }
  }

  async function runBackfill() {
    try {
      const r = await backend.generateBackfill(true)
      if (r.error) toast.error(r.error)
      else
        toast.success(`Génération lancée pour ${r.queued ?? 0} contenu(s)`, {
          description: "Progression dans les jobs de génération.",
        })
    } catch {
      toast.error("Lancement impossible")
    }
  }

  const disabled = settings.preset === "none"
  const isCloud = preset && !preset.local && settings.preset !== "none"

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <SparklesIcon className="size-4" /> Intelligence
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-xs text-muted-foreground">
          Générez automatiquement un résumé et des chapitres pour chaque contenu transcrit,
          via un LLM local (Ollama, LM Studio) ou distant (clé API). Optionnel — sans
          fournisseur, Fetchly fonctionne normalement.
        </p>

        {/* Preset picker */}
        <div className="flex flex-col gap-2">
          <Label>Fournisseur</Label>
          <Select value={settings.preset} onValueChange={choosePreset}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {presets.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {!disabled && (
          <>
            {/* Contextual help */}
            {(preset?.cost_hint || preset?.key_url || preset?.install_hint) && (
              <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                {preset?.cost_hint && <p>{preset.cost_hint}</p>}
                {preset?.install_hint && (
                  <p className="font-mono text-[11px] text-foreground/80">{preset.install_hint}</p>
                )}
                {preset?.key_url && (
                  <a
                    href={preset.key_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                  >
                    <ExternalLinkIcon className="size-3" /> Obtenir une clé API
                  </a>
                )}
              </div>
            )}

            {isCloud && (
              <p className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
                <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                Les transcripts partent chez le fournisseur choisi pour être résumés —
                préférez Ollama pour un traitement 100 % local.
              </p>
            )}

            {/* Editable fields (preset just pre-fills them) */}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="llm-url">URL de base</Label>
                <Input
                  id="llm-url"
                  value={settings.base_url}
                  onChange={(e) => setSettings({ ...settings, base_url: e.target.value })}
                  onBlur={() => save({ base_url: settings.base_url })}
                  placeholder="https://api.exemple.com/v1"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="llm-model">Modèle</Label>
                <Input
                  id="llm-model"
                  value={settings.model}
                  onChange={(e) => setSettings({ ...settings, model: e.target.value })}
                  onBlur={() => save({ model: settings.model })}
                  placeholder="ex. gpt-4o-mini"
                />
              </div>
            </div>

            {settings.preset === "custom" && (
              <div className="flex flex-col gap-1.5">
                <Label>Protocole</Label>
                <Select
                  value={settings.protocol}
                  onValueChange={(v) => save({ protocol: v })}
                >
                  <SelectTrigger size="sm" className="w-64">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="openai_compatible">OpenAI-compatible (/chat/completions)</SelectItem>
                    <SelectItem value="anthropic">Anthropic (/v1/messages)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {!preset?.local && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="llm-key">Clé API</Label>
                <Input
                  id="llm-key"
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  onBlur={() => apiKey && save({ api_key: apiKey }).then(() => setApiKey(""))}
                  placeholder={settings.has_key ? "•••••••••• (enregistrée)" : "Collez votre clé"}
                />
                <p className="text-xs text-muted-foreground">
                  Stockée localement dans votre configuration ; jamais renvoyée par l&apos;API.
                </p>
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label>Style</Label>
                <Select value={settings.style} onValueChange={(v) => save({ style: v })}>
                  <SelectTrigger size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="concis">Concis</SelectItem>
                    <SelectItem value="détaillé">Détaillé</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Langue de sortie</Label>
                <Select
                  value={settings.output_language}
                  onValueChange={(v) => save({ output_language: v })}
                >
                  <SelectTrigger size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LANGS.map(([v, l]) => (
                      <SelectItem key={v} value={v}>{l}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Test + backfill */}
            <div className="flex flex-wrap items-center gap-2 border-t pt-3">
              <Button size="sm" variant="outline" onClick={runTest} disabled={test.kind === "testing"}>
                {test.kind === "testing" ? (
                  <LoaderIcon className="size-4 animate-spin" data-icon="inline-start" />
                ) : (
                  <WandSparklesIcon className="size-4" data-icon="inline-start" />
                )}
                Tester la connexion
              </Button>
              <Button size="sm" onClick={() => setBackfillOpen(true)}>
                <SparklesIcon className="size-4" data-icon="inline-start" />
                Générer pour toute la bibliothèque
              </Button>
            </div>

            {test.kind === "ok" && (
              <p className="flex items-center gap-1.5 text-xs text-success" role="status">
                <CheckCircle2Icon className="size-3.5" /> {test.message}
              </p>
            )}
            {test.kind === "error" && (
              <p className="flex items-center gap-1.5 text-xs text-destructive" role="alert">
                <TriangleAlertIcon className="size-3.5" /> {test.message}
              </p>
            )}
          </>
        )}
      </CardContent>

      <ConfirmDialog
        open={backfillOpen}
        onOpenChange={setBackfillOpen}
        variant="default"
        title="Générer pour toute la bibliothèque ?"
        description={
          `Jusqu'à ${indexedCount ?? "…"} contenu(s) transcrit(s) seront résumés — ` +
          `≈ 1 appel LLM par contenu court, davantage pour les longs (map-reduce). ` +
          `Le traitement respecte la fenêtre différée si elle est activée.`
        }
        confirmLabel="Lancer la génération"
        onConfirm={runBackfill}
      />
    </Card>
  )
}
