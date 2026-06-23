"use client"

import { useEffect, useState } from "react"
import { BellIcon, LoaderIcon, SendIcon } from "lucide-react"
import { toast } from "sonner"

import { backend } from "@/lib/backend"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"

/**
 * Réglages de notification (basés sur Apprise côté backend) : recevez une alerte
 * — Discord, Telegram, e-mail, push (ntfy/Pushover), SMS… — à chaque vidéo
 * téléchargée. Une URL de service par ligne.
 */
export function NotificationsCard() {
  const [enabled, setEnabled] = useState(false)
  const [urlsText, setUrlsText] = useState("")
  const [loading, setLoading] = useState(true)
  const [available, setAvailable] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [events, setEvents] = useState({ on_video: true, on_error: true, on_summary: false })

  useEffect(() => {
    backend
      .notifications()
      .then((n) => {
        setEnabled(!!n.enabled)
        setUrlsText((n.urls ?? []).join("\n"))
        setAvailable(n.available !== false)
        setEvents({
          on_video: n.on_video ?? true,
          on_error: n.on_error ?? true,
          on_summary: n.on_summary ?? false,
        })
      })
      .catch(() => setAvailable(false))
      .finally(() => setLoading(false))
  }, [])

  // Persist an event toggle immediately.
  const setEvent = (key: keyof typeof events, value: boolean) => {
    setEvents((e) => ({ ...e, [key]: value }))
    backend.saveNotifications({ [key]: value }).catch(() => {})
  }

  const parseUrls = () =>
    urlsText
      .split("\n")
      .map((u) => u.trim())
      .filter(Boolean)

  const save = async (nextEnabled = enabled) => {
    setSaving(true)
    try {
      const res = await backend.saveNotifications({ enabled: nextEnabled, urls: parseUrls() })
      setEnabled(!!res.enabled)
      setUrlsText((res.urls ?? []).join("\n"))
      toast.success("Notifications enregistrées")
    } catch {
      toast.error("Échec de l'enregistrement")
    } finally {
      setSaving(false)
    }
  }

  const test = async () => {
    setTesting(true)
    try {
      const urls = parseUrls()
      const res = await backend.testNotifications({ urls })
      if (!res.ok) {
        toast.error(res.message || "Échec de l'envoi du test")
        return
      }
      // A working test means the user wants notifications — persist the URLs and
      // turn the master switch on so real downloads actually notify (otherwise
      // "the test works but I get nothing" is a trap).
      const saved = await backend.saveNotifications({ enabled: true, urls })
      setEnabled(!!saved.enabled)
      setUrlsText((saved.urls ?? []).join("\n"))
      toast.success("Test envoyé — notifications activées ✅")
    } catch {
      toast.error("Échec de l'envoi du test")
    } finally {
      setTesting(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BellIcon className="size-4" /> Notifications
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!available && (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            La librairie de notifications (Apprise) n'est pas installée sur le serveur.
          </p>
        )}
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium">Activer les notifications</p>
            <p className="text-xs text-muted-foreground">
              Recevoir une alerte à chaque vidéo téléchargée
            </p>
          </div>
          <Switch
            checked={enabled}
            disabled={loading || !available}
            onCheckedChange={(v) => {
              setEnabled(v)
              void save(v)
            }}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="notif-urls">Services (une URL par ligne)</Label>
          <Textarea
            id="notif-urls"
            rows={4}
            spellCheck={false}
            className="font-mono text-xs"
            placeholder={"discord://webhook_id/webhook_token\ntgram://bot_token/chat_id\nmailto://user:pass@gmail.com\nntfy://ntfy.sh/mon-sujet"}
            value={urlsText}
            disabled={loading || !available}
            onChange={(e) => setUrlsText(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Format Apprise. Voir la liste complète des services et leur syntaxe sur{" "}
            <a
              href="https://github.com/caronc/apprise/wiki"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              le wiki Apprise
            </a>
            .
          </p>
        </div>

        <div className="flex flex-col gap-1 border-t pt-3">
          <p className="mb-1 text-xs font-medium text-muted-foreground">Quand notifier</p>
          {(
            [
              ["on_video", "Vidéo téléchargée", "À chaque vidéo terminée"],
              ["on_error", "Échec", "Quand un téléchargement échoue"],
              ["on_summary", "Résumé de playlist", "Un seul message en fin de lot"],
            ] as const
          ).map(([key, title, desc]) => (
            <div key={key} className="flex items-center justify-between gap-4 py-0.5">
              <div className="min-w-0">
                <p className="text-sm">{title}</p>
                <p className="text-xs text-muted-foreground">{desc}</p>
              </div>
              <Switch
                checked={events[key]}
                disabled={loading || !available}
                onCheckedChange={(v) => setEvent(key, v)}
              />
            </div>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => void save()} disabled={loading || saving || !available}>
            {saving ? <LoaderIcon className="size-4 animate-spin" /> : null}
            Enregistrer
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void test()}
            disabled={loading || testing || !available}
          >
            {testing ? (
              <LoaderIcon className="size-4 animate-spin" />
            ) : (
              <SendIcon className="size-4" />
            )}
            Tester
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
