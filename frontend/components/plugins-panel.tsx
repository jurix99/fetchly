"use client"

import { useEffect, useMemo, useState } from "react"
import {
  ChevronRightIcon,
  CircleCheckIcon,
  DatabaseIcon,
  EyeIcon,
  EyeOffIcon,
  FlaskConicalIcon,
  Loader2Icon,
  LockIcon,
  PlugIcon,
  RssIcon,
  SendIcon,
  SparklesIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import {
  backend,
  type PluginAction,
  type PluginField,
  type PluginInfo,
  type TranscriptStatusInfo,
} from "@/lib/backend"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { InlineFeedback } from "@/components/inline-feedback"

const TYPE_ICON = {
  source: RssIcon,
  processor: SparklesIcon,
  output: SendIcon,
  unknown: PlugIcon,
} as const

const TYPE_LABEL = {
  source: "Source",
  processor: "Processeur",
  output: "Sortie",
  unknown: "Inconnu",
} as const

// Whisper cloud presets — prefill base_url + model (editable afterwards).
const STT_PRESETS: Record<string, { cloud_base_url: string; cloud_model: string }> = {
  openai: { cloud_base_url: "https://api.openai.com/v1", cloud_model: "whisper-1" },
  groq: { cloud_base_url: "https://api.groq.com/openai/v1", cloud_model: "whisper-large-v3-turbo" },
  mistral: { cloud_base_url: "https://api.mistral.ai/v1", cloud_model: "voxtral-mini-latest" },
}
const WHISPER_LOCAL_FIELDS = new Set(["model", "compute", "vad_filter"])
const WHISPER_CLOUD_FIELDS = new Set(["cloud_preset", "cloud_base_url", "cloud_model", "cloud_api_key"])

/** Which whisper fields to show for the selected engine (local vs cloud). */
function whisperFieldVisible(engine: string, key: string): boolean {
  if (WHISPER_LOCAL_FIELDS.has(key)) return engine !== "cloud"
  if (WHISPER_CLOUD_FIELDS.has(key)) return engine === "cloud"
  return true
}

export function PluginsPanel() {
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null)
  const [editing, setEditing] = useState<PluginInfo | null>(null)
  // Optimistic enabled overrides, keyed by id, cleared on refresh.
  const [pending, setPending] = useState<Record<string, boolean>>({})

  async function refresh() {
    try {
      setPlugins(await backend.plugins())
    } catch {
      setPlugins([])
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  const hasUserPlugin = useMemo(
    () => (plugins ?? []).some((p) => !p.builtin),
    [plugins],
  )

  async function toggle(p: PluginInfo, next: boolean) {
    setPending((s) => ({ ...s, [p.id]: next }))
    try {
      const res = next ? await backend.enablePlugin(p.id) : await backend.disablePlugin(p.id)
      if (res.error) toast.error(res.error)
      else toast.success(next ? `${p.name} activé` : `${p.name} désactivé`)
    } catch {
      toast.error("Action impossible")
    } finally {
      await refresh()
      setPending((s) => {
        const n = { ...s }
        delete n[p.id]
        return n
      })
    }
  }

  if (plugins === null) {
    return <InlineFeedback state="loading" rows={3} />
  }

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-3">
        {plugins.map((p) => {
          const Icon = TYPE_ICON[p.type] ?? PlugIcon
          const enabled = pending[p.id] ?? p.enabled
          return (
            <Card key={p.id} className={cn("gap-0 p-0", p.status === "error" && "border-destructive/40")}>
              <div className="flex items-start gap-3 p-4">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-foreground">
                  <Icon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="truncate font-medium">{p.name}</h3>
                    <Badge variant="secondary" className="text-[10px]">
                      {TYPE_LABEL[p.type] ?? p.type}
                    </Badge>
                    {p.version && (
                      <span className="text-xs text-muted-foreground">v{p.version}</span>
                    )}
                    <StatusBadge status={p.status} enabled={enabled} />
                  </div>
                  {p.description && (
                    <p className="mt-0.5 text-sm text-muted-foreground">{p.description}</p>
                  )}
                  {p.status === "error" && <ErrorDetails error={p.error} />}
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  {p.status !== "error" && p.settings_schema.length > 0 && (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Réglages de ${p.name}`}
                      onClick={() => setEditing(p)}
                    >
                      <ChevronRightIcon />
                    </Button>
                  )}
                  {p.critical ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span className="flex size-8 items-center justify-center text-muted-foreground">
                            <LockIcon className="size-4" />
                          </span>
                        }
                      />
                      <TooltipContent>
                        Plugin essentiel — ne peut pas être désactivé.
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    <Switch
                      checked={enabled}
                      disabled={p.status === "error"}
                      onCheckedChange={(v) => toggle(p, v)}
                      aria-label={enabled ? `Désactiver ${p.name}` : `Activer ${p.name}`}
                    />
                  )}
                </div>
              </div>
            </Card>
          )
        })}

        {!hasUserPlugin && (
          <InlineFeedback
            state="empty"
            icon={PlugIcon}
            title="Aucun plugin utilisateur"
            description="Déposez un fichier .py dans /config/plugins pour étendre Fetchly (transcription, résumés, intégrations…)."
            action={
              <Button
                size="sm"
                variant="outline"
                render={
                  <a
                    href="https://github.com/"
                    onClick={(e) => {
                      e.preventDefault()
                      toast.info("Guide : docs/PLUGINS.md dans le dépôt")
                    }}
                  />
                }
              >
                <SparklesIcon data-icon="inline-start" /> Écrire votre premier plugin
              </Button>
            }
          />
        )}
      </div>

      <PluginSettingsDialog
        plugin={editing}
        onOpenChange={(o) => !o && setEditing(null)}
        onSaved={refresh}
      />
    </TooltipProvider>
  )
}

function StatusBadge({ status, enabled }: { status: string; enabled: boolean }) {
  if (status === "error")
    return (
      <Badge className="gap-1 border-destructive/30 bg-destructive/15 text-destructive text-[10px]">
        <TriangleAlertIcon className="size-3" /> Erreur
      </Badge>
    )
  if (enabled)
    return (
      <Badge className="border-success/30 bg-success/15 text-success text-[10px]">Actif</Badge>
    )
  return (
    <Badge variant="secondary" className="text-[10px]">
      Désactivé
    </Badge>
  )
}

function ErrorDetails({ error }: { error: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-xs font-medium text-destructive underline underline-offset-2"
      >
        {open ? "Masquer l'erreur" : "Voir l'erreur de chargement"}
      </button>
      {open && (
        <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-destructive/10 p-2 text-[11px] text-destructive whitespace-pre-wrap">
          {error}
        </pre>
      )}
    </div>
  )
}

function PluginSettingsDialog({
  plugin,
  onOpenChange,
  onSaved,
}: {
  plugin: PluginInfo | null
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (plugin) setValues({ ...plugin.settings })
  }, [plugin])

  async function save() {
    if (!plugin) return
    setSaving(true)
    try {
      const res = await backend.savePluginSettings(plugin.id, values)
      if (res.error) toast.error(res.error)
      else {
        toast.success("Réglages enregistrés")
        onOpenChange(false)
        onSaved()
      }
    } catch {
      toast.error("Échec de l'enregistrement")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={!!plugin} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{plugin?.name}</DialogTitle>
          <DialogDescription>Réglages du plugin</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          {plugin?.id === "whisper" && <WhisperStatusCard values={values} />}

          {(plugin?.settings_schema ?? [])
            .filter(
              (field) =>
                plugin?.id !== "whisper" ||
                whisperFieldVisible(String(values.engine ?? "local"), field.key),
            )
            .map((field, i) => (
              <div key={field.key}>
                {i > 0 && <Separator className="mb-4" />}
                <PluginFieldInput
                  field={field}
                  value={values[field.key]}
                  onChange={(v) =>
                    setValues((s) => {
                      // Picking a whisper cloud preset prefills URL + model.
                      if (plugin?.id === "whisper" && field.key === "cloud_preset") {
                        const preset = STT_PRESETS[String(v)]
                        return { ...s, cloud_preset: v, ...(preset ?? {}) }
                      }
                      return { ...s, [field.key]: v }
                    })
                  }
                />
              </div>
            ))}

          {/* Cloud connection test (whisper, cloud mode) + generic plugin actions. */}
          {(plugin?.actions ?? [])
            .filter((a) => {
              if (plugin?.id !== "whisper") return true
              // Only the cloud test button here, and only in cloud mode (backfill
              // lives in the WhisperStatusCard).
              return a.id === "test_cloud" && String(values.engine ?? "local") === "cloud"
            })
            .map((action) => (
              <PluginActionButton
                key={action.id}
                pluginId={plugin!.id}
                action={action}
                values={values}
              />
            ))}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Fermer
          </Button>
          <Button onClick={save} disabled={saving}>
            Enregistrer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Renders one settings field per its schema type (bool/str/int/select). */
function PluginFieldInput({
  field,
  value,
  onChange,
}: {
  field: PluginField
  value: unknown
  onChange: (v: unknown) => void
}) {
  if (field.type === "bool") {
    return (
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <Label>{field.label}</Label>
          {field.help && <p className="text-xs text-muted-foreground">{field.help}</p>}
        </div>
        <Switch
          checked={!!value}
          onCheckedChange={onChange}
          aria-label={field.label}
        />
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`f-${field.key}`}>{field.label}</Label>
      {field.type === "select" ? (
        <Select
          value={String(value ?? "")}
          onValueChange={(v) => onChange(String(v ?? ""))}
        >
          <SelectTrigger id={`f-${field.key}`} className="w-full" aria-label={field.label}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(field.options ?? []).map((opt) => (
              <SelectItem key={opt} value={opt}>
                {opt}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : field.type === "int" ? (
        <Input
          id={`f-${field.key}`}
          type="number"
          value={value === undefined || value === null ? "" : String(value)}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        />
      ) : field.secret ? (
        <SecretInput
          id={`f-${field.key}`}
          value={value === undefined || value === null ? "" : String(value)}
          onChange={onChange}
        />
      ) : (
        <Input
          id={`f-${field.key}`}
          value={value === undefined || value === null ? "" : String(value)}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {field.help && <p className="text-xs text-muted-foreground">{field.help}</p>}
    </div>
  )
}

/** Whisper-specific status header: detected hardware, active model + size,
 *  measured speed, plus the "transcribe the whole library" action. */
function WhisperStatusCard({ values }: { values: Record<string, unknown> }) {
  const [status, setStatus] = useState<TranscriptStatusInfo | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [count, setCount] = useState<number | null>(null)

  useEffect(() => {
    backend.transcriptsStatus().then(setStatus).catch(() => {})
  }, [])

  async function openConfirm() {
    try {
      setCount((await backend.library({ limit: 1 })).total)
    } catch {
      setCount(null)
    }
    setConfirmOpen(true)
  }

  async function run() {
    try {
      const r = await backend.backfillTranscripts(true)
      toast.success(`${r.queued} transcription(s) mises en file`)
    } catch {
      toast.error("Impossible de lancer la transcription")
    }
  }

  const speed = status?.last_speed
  const engine = String(values.engine ?? status?.engine ?? "local")
  const cloudMinutes = status?.cloud_minutes ?? 0
  const provider = String(values.cloud_preset ?? status?.cloud_preset ?? "le fournisseur")
  // Slow hardware: measured media-minutes-per-real-minute below 1× real time.
  const slow = engine === "local" && speed != null && parseFloat(speed) > 0 && parseFloat(speed) < 1

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-3">
      {engine === "cloud" ? (
        <>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <Stat label="Moteur" value="Cloud" />
            <Stat label="Fournisseur" value={provider} />
            <Stat label="Modèle" value={String(values.cloud_model ?? "—")} />
            <Stat label="Ce mois-ci" value={`${cloudMinutes} min transcrites`} />
          </div>
          <p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-2.5 py-1.5 text-xs text-warning">
            <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
            L&apos;audio de vos contenus sera envoyé à {provider}.
          </p>
        </>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <Stat label="Matériel détecté" value={status?.device ?? "…"} />
            <Stat
              label="Modèle actif"
              value={status ? `${values.model ?? status.model} ${status.model_size}`.trim() : "…"}
            />
            <Stat label="Vitesse mesurée" value={speed ? `~${speed} min de média / min` : "non mesurée"} />
            <Stat label="Cadence" value={status?.schedule ?? "…"} />
          </div>
          {slow && (
            <p className="rounded-md border border-info/30 bg-info/10 px-2.5 py-1.5 text-xs text-info">
              Matériel modeste détecté — le moteur Cloud peut transcrire beaucoup plus vite.
            </p>
          )}
          {cloudMinutes > 0 && (
            <p className="text-xs text-muted-foreground">
              {cloudMinutes} min transcrites dans le cloud ce mois-ci.
            </p>
          )}
        </>
      )}
      <Button size="sm" onClick={openConfirm} className="w-fit">
        <SparklesIcon data-icon="inline-start" /> Transcrire toute la bibliothèque
      </Button>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        variant="default"
        title="Transcrire toute la bibliothèque ?"
        description={
          (count != null
            ? `Jusqu'à ${count} contenu(s) sans transcript seront mis en file.`
            : "Les contenus sans transcript seront mis en file.") +
          (speed ? ` Vitesse mesurée : ~${speed} min de média par minute.` : "")
        }
        confirmLabel="Mettre en file"
        onConfirm={run}
      />
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-muted-foreground">{label}</p>
      <p className="font-medium text-foreground">{value}</p>
    </div>
  )
}

/** Password input with a visibility (eye) toggle, for tokens/API keys. */
function SecretInput({
  id,
  value,
  onChange,
}: {
  id: string
  value: string
  onChange: (v: string) => void
}) {
  const [show, setShow] = useState(false)
  return (
    <div className="relative">
      <Input
        id={id}
        type={show ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="pr-9"
        autoComplete="off"
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted-foreground hover:text-foreground"
        aria-label={show ? "Masquer" : "Afficher"}
      >
        {show ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
      </button>
    </div>
  )
}

/** A plugin action button. "test" shows an inline 3-state result; a `confirm`
 *  action (backfill) opens a confirm-dialog announcing the file count first. */
function PluginActionButton({
  pluginId,
  action,
  values,
}: {
  pluginId: string
  action: PluginAction
  values: Record<string, unknown>
}) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [fileCount, setFileCount] = useState<number | null>(null)

  const isTest = action.kind === "test"
  // The test button is disabled until a server address is entered (base_url for
  // generic plugins, cloud_base_url for the whisper cloud engine).
  const disabled =
    busy || (isTest && !String(values.base_url ?? values.cloud_base_url ?? "").trim())

  async function run() {
    setBusy(true)
    setResult(null)
    try {
      const res = await backend.runPluginAction(pluginId, action.id, { settings: values })
      if (isTest) {
        setResult({ ok: !!res.ok, message: res.message || res.error || "Réponse invalide" })
      } else if (res.error) {
        toast.error(res.error)
      } else if (res.job_id) {
        toast.success("Tâche lancée — voir la file des téléchargements")
      }
    } catch {
      if (isTest) setResult({ ok: false, message: "Requête impossible" })
      else toast.error("Action impossible")
    } finally {
      setBusy(false)
    }
  }

  async function onClick() {
    if (action.confirm) {
      let n: number | null = null
      try {
        n = (await backend.files()).length
      } catch {
        n = null
      }
      setFileCount(n)
      setConfirmOpen(true)
    } else {
      run()
    }
  }

  const Icon = isTest ? FlaskConicalIcon : DatabaseIcon

  return (
    <div className="flex flex-col gap-2">
      <Button variant="outline" size="sm" onClick={onClick} disabled={disabled} className="w-fit">
        {busy ? (
          <Loader2Icon data-icon="inline-start" className="animate-spin" />
        ) : (
          <Icon data-icon="inline-start" />
        )}
        {action.label}
      </Button>

      {isTest && result && (
        <div
          className={cn(
            "flex items-start gap-2 rounded-md border p-2 text-xs",
            result.ok
              ? "border-success/30 bg-success/10 text-success"
              : "border-destructive/30 bg-destructive/10 text-destructive",
          )}
        >
          {result.ok ? (
            <CircleCheckIcon className="mt-0.5 size-3.5 shrink-0" />
          ) : (
            <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          )}
          <span>{result.message}</span>
        </div>
      )}

      {action.confirm && (
        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          variant="default"
          title={`${action.label} ?`}
          description={
            fileCount === null
              ? "Traite les fichiers de la bibliothèque existante. Les médias ne sont pas modifiés."
              : `Traite ${fileCount} fichier(s) de la bibliothèque. Les médias ne sont pas modifiés.`
          }
          confirmLabel="Lancer"
          onConfirm={run}
        />
      )}
    </div>
  )
}
