"use client"

import { useEffect, useState } from "react"
import { HardDriveIcon, TriangleAlertIcon } from "lucide-react"

import { backend, type BackendDisk } from "@/lib/backend"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { InlineFeedback } from "@/components/inline-feedback"

/**
 * Disk usage of the downloads volume + the "minimum free space" guard. Below the
 * threshold, the backend refuses to start new downloads and fires a
 * notification — so a full disk can't silently break things again.
 */
export function DiskCard() {
  const [disk, setDisk] = useState<BackendDisk | null>(null)
  const [minFree, setMinFree] = useState<string>("")

  useEffect(() => {
    let alive = true
    const load = () =>
      backend
        .disk()
        .then((d) => {
          if (!alive) return
          setDisk(d)
          setMinFree((prev) => (prev === "" ? String(d.min_free_gb ?? 0) : prev))
        })
        .catch(() => {})
    load()
    const t = setInterval(load, 10000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  function saveMinFree(value: string) {
    setMinFree(value)
    const n = Math.max(0, Number(value) || 0)
    backend.saveSettings({ min_free_gb: n }).catch(() => {})
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <HardDriveIcon className="size-4" /> Stockage
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!disk && <InlineFeedback state="loading" rows={2} />}
        {disk && (
          <div className="flex flex-col gap-2">
            <Progress value={disk.percent} />
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {disk.free_gb} Go libres sur {disk.total_gb} Go
              </span>
              <span className="tabular-nums">{disk.percent}% utilisé</span>
            </div>
            {disk.low && (
              <p className="flex items-center gap-1.5 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                <TriangleAlertIcon className="size-4 shrink-0" />
                Espace faible — les nouveaux téléchargements sont suspendus.
              </p>
            )}
          </div>
        )}
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium">Espace libre minimum</p>
            <p className="text-xs text-muted-foreground">
              Refuser un téléchargement sous ce seuil (0 = désactivé)
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <Input
              type="number"
              min={0}
              step={0.5}
              className="w-20"
              value={minFree}
              onChange={(e) => saveMinFree(e.target.value)}
            />
            <span className="text-sm text-muted-foreground">Go</span>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
