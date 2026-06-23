"use client"

import { useEffect, useState } from "react"
import { CheckCircle2Icon, CookieIcon, LoaderIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import { backend, type BackendCookies } from "@/lib/backend"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"

/**
 * Gestion des cookies YouTube (cookies.txt Netscape) directement depuis l'UI :
 * plus besoin de remonter un volume ni de redémarrer le conteneur. Les cookies
 * sont stockés dans /config et rafraîchis automatiquement à l'usage, donc on les
 * redépose rarement. Nécessaires pour « À regarder plus tard », les vidéos
 * likées, les playlists privées et pour passer le contrôle anti-bot.
 */
export function CookiesCard() {
  const [status, setStatus] = useState<BackendCookies | null>(null)
  const [text, setText] = useState("")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [clearing, setClearing] = useState(false)

  const refresh = () =>
    backend
      .cookies()
      .then(setStatus)
      .catch(() => setStatus(null))
      .finally(() => setLoading(false))

  useEffect(() => {
    void refresh()
  }, [])

  const save = async () => {
    if (!text.trim()) {
      toast.error("Colle d'abord ton cookies.txt")
      return
    }
    setSaving(true)
    try {
      const res = await backend.saveCookies(text)
      if (res.ok) {
        toast.success(res.message || "Cookies enregistrés")
        setText("")
        setStatus(res)
      } else {
        toast.error(res.message || "Format invalide")
      }
    } catch {
      toast.error("Échec de l'enregistrement")
    } finally {
      setSaving(false)
    }
  }

  const clear = async () => {
    setClearing(true)
    try {
      const res = await backend.clearCookies()
      setStatus(res)
      toast.success("Cookies supprimés")
    } catch {
      toast.error("Échec de la suppression")
    } finally {
      setClearing(false)
    }
  }

  const present = status?.present
  const ageDays =
    status?.updated_at != null
      ? Math.floor((Date.now() / 1000 - status.updated_at) / 86400)
      : null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CookieIcon className="size-4" /> Cookies YouTube
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            {loading ? (
              <p className="text-sm text-muted-foreground">Chargement…</p>
            ) : present ? (
              <p className="flex items-center gap-1.5 text-sm font-medium text-emerald-600 dark:text-emerald-400">
                <CheckCircle2Icon className="size-4" />
                Cookies actifs · {status?.count} ligne(s)
                {status?.source === "mounted" ? " · fichier monté" : ""}
                {ageDays != null ? ` · maj il y a ${ageDays} j` : ""}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                Aucun cookie — YouTube risque de bloquer certains téléchargements.
              </p>
            )}
          </div>
          {present && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => void clear()}
              disabled={clearing}
            >
              {clearing ? (
                <LoaderIcon className="size-4 animate-spin" />
              ) : (
                <Trash2Icon className="size-4" />
              )}
              Effacer
            </Button>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="cookies-text">Coller un cookies.txt (format Netscape)</Label>
          <Textarea
            id="cookies-text"
            rows={4}
            spellCheck={false}
            className="font-mono text-xs"
            placeholder={"# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t…"}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Exporte-le depuis un navigateur connecté à YouTube avec une extension
            « Get cookies.txt » (format Netscape). Stocké dans <code>/config</code> et
            auto-rafraîchi à l'usage.
          </p>
        </div>

        <div>
          <Button size="sm" onClick={() => void save()} disabled={saving || !text.trim()}>
            {saving ? <LoaderIcon className="size-4 animate-spin" /> : null}
            Enregistrer les cookies
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
