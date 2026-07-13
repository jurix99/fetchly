"use client"

import { useEffect, useState } from "react"
import { CheckCircle2Icon, LoaderIcon, MailIcon, SendIcon, TriangleAlertIcon } from "lucide-react"
import { toast } from "sonner"

import { backend, type DigestSettings } from "@/lib/backend"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

const DAYS = [
  ["1", "Lundi"], ["2", "Mardi"], ["3", "Mercredi"], ["4", "Jeudi"],
  ["5", "Vendredi"], ["6", "Samedi"], ["0", "Dimanche"],
] as const

type Preview = { kind: "idle" | "sending" } | { kind: "ok" | "error"; message: string }

function urlValid(u: string): boolean {
  return /^https?:\/\/.+/i.test(u.trim())
}

export function DigestCard() {
  const [s, setS] = useState<DigestSettings | null>(null)
  const [preview, setPreview] = useState<Preview>({ kind: "idle" })

  useEffect(() => {
    backend.digestSettings().then(setS).catch(() => {})
  }, [])

  if (!s) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <MailIcon className="size-4" /> Digest
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Chargement…</p>
        </CardContent>
      </Card>
    )
  }

  async function save(patch: Parameters<typeof backend.saveDigestSettings>[0]) {
    setPreview({ kind: "idle" })
    try {
      setS(await backend.saveDigestSettings(patch))
    } catch {
      toast.error("Enregistrement impossible")
    }
  }

  const baseOk = urlValid(s.public_base_url)

  async function sendPreview() {
    setPreview({ kind: "sending" })
    try {
      const r = await backend.digestEmailPreview()
      setPreview(r.ok ? { kind: "ok", message: r.message } : { kind: "error", message: r.message })
    } catch {
      setPreview({ kind: "error", message: "Envoi impossible" })
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <MailIcon className="size-4" /> Digest — e-mail hebdomadaire
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium">E-mail hebdomadaire</p>
            <p className="text-xs text-muted-foreground">
              Un récapitulatif « depuis votre dernière visite », une fois par semaine.
            </p>
          </div>
          <Switch
            checked={s.email_enabled}
            onCheckedChange={(v) => save({ email_enabled: v })}
          />
        </div>

        {s.email_enabled && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label>Jour d&apos;envoi</Label>
                <Select
                  value={String(s.email_day)}
                  onValueChange={(v) => save({ email_day: Number(v) })}
                >
                  <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {DAYS.map(([v, l]) => (
                      <SelectItem key={v} value={v}>{l}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="digest-hour">Heure (0-23)</Label>
                <Input
                  id="digest-hour"
                  type="number"
                  min={0}
                  max={23}
                  value={s.email_hour}
                  onChange={(e) => setS({ ...s, email_hour: Number(e.target.value) })}
                  onBlur={() => save({ email_hour: s.email_hour })}
                  className="w-24"
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="digest-url">URL publique de votre instance</Label>
              <Input
                id="digest-url"
                value={s.public_base_url}
                onChange={(e) => setS({ ...s, public_base_url: e.target.value })}
                onBlur={() => save({ public_base_url: s.public_base_url })}
                placeholder="https://fetchly.mon-domaine.fr"
                aria-invalid={s.public_base_url.length > 0 && !baseOk}
              />
              {s.public_base_url.length > 0 && !baseOk ? (
                <p className="text-xs text-destructive">
                  URL invalide — elle doit commencer par http:// ou https://
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Requise : elle sert à construire les liens de l&apos;e-mail (sinon liens morts).
                  Utilisez l&apos;adresse par laquelle vous accédez à Fetchly depuis l&apos;extérieur.
                </p>
              )}
            </div>

            <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              L&apos;e-mail est envoyé via vos notifications Apprise (Réglages → Notifications).
              Ajoutez-y une URL <code>mailto://</code> (ou tout autre service) pour le recevoir.
            </p>

            <div className="flex items-center gap-2 border-t pt-3">
              <Button
                size="sm"
                variant="outline"
                onClick={sendPreview}
                disabled={!baseOk || preview.kind === "sending"}
              >
                {preview.kind === "sending" ? (
                  <LoaderIcon className="size-4 animate-spin" data-icon="inline-start" />
                ) : (
                  <SendIcon className="size-4" data-icon="inline-start" />
                )}
                M&apos;envoyer un aperçu maintenant
              </Button>
            </div>

            {preview.kind === "ok" && (
              <p className="flex items-center gap-1.5 text-xs text-success" role="status">
                <CheckCircle2Icon className="size-3.5" /> {preview.message}
              </p>
            )}
            {preview.kind === "error" && (
              <p className="flex items-center gap-1.5 text-xs text-destructive" role="alert">
                <TriangleAlertIcon className="size-3.5" /> {preview.message}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
