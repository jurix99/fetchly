"use client"

import { useEffect, useState } from "react"
import { DatabaseIcon, SearchIcon } from "lucide-react"
import { toast } from "sonner"

import { backend, type IndexStats } from "@/lib/backend"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ConfirmDialog } from "@/components/confirm-dialog"

function fmtBytes(n: number): string {
  if (!n) return "—"
  const mb = n / (1024 * 1024)
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} Go` : `${mb.toFixed(0)} Mo`
}

export function IndexCard() {
  const [stats, setStats] = useState<IndexStats | null>(null)
  const [rebuildOpen, setRebuildOpen] = useState(false)

  async function refresh() {
    try {
      setStats(await backend.indexStats())
    } catch {
      setStats(null)
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  async function backfill() {
    try {
      await backend.indexBackfill()
      toast.success("Indexation lancée", { description: "Progression dans Téléchargements." })
    } catch {
      toast.error("Impossible de lancer l'indexation")
    }
  }

  async function rebuild() {
    try {
      await backend.indexRebuild()
      toast.success("Reconstruction de l'index lancée")
    } catch {
      toast.error("Impossible de reconstruire l'index")
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <SearchIcon className="size-4" /> Recherche &amp; index
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Stat label="Contenus indexés" value={stats ? `${stats.indexed} / ${stats.total}` : "…"} />
          <Stat label="Passages (chunks)" value={stats ? String(stats.chunks) : "…"} />
          <Stat label="Taille de l'index" value={stats ? fmtBytes(stats.db_bytes) : "…"} />
          <div>
            <p className="text-xs text-muted-foreground">Recherche sémantique</p>
            <Badge
              variant="secondary"
              className={stats?.semantic ? "border-success/30 bg-success/15 text-success" : ""}
            >
              {stats ? (stats.semantic ? "Active" : "Lexicale seule") : "…"}
            </Badge>
          </div>
        </div>

        <div className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          <DatabaseIcon className="size-3.5 shrink-0" />
          Embeddings&nbsp;: <span className="font-medium text-foreground">{stats?.embedding_model ?? "…"}</span>
          {stats?.embedding_lang ? ` · ${stats.embedding_lang}` : ""}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={backfill}>
            <SearchIcon data-icon="inline-start" /> Indexer les contenus manquants
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setRebuildOpen(true)}>
            Reconstruire l&apos;index
          </Button>
        </div>
      </CardContent>

      <ConfirmDialog
        open={rebuildOpen}
        onOpenChange={setRebuildOpen}
        title="Reconstruire l'index ?"
        description="Supprime puis reconstruit tous les chunks et vecteurs de la bibliothèque. Les transcriptions et les médias ne sont pas touchés."
        confirmLabel="Reconstruire"
        onConfirm={rebuild}
      />
    </Card>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-medium tabular-nums">{value}</p>
    </div>
  )
}
