"use client"

import { PlusIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { SubscriptionsPanel } from "@/components/subscriptions-panel"

/** Sources — the merger of Abonnements + Explorer. A source (channel, playlist)
 *  feeds the memory; adding one goes through the single "Ajouter une source"
 *  dialog (which also embeds the old catalogue browse as "Parcourir"). */
export function SourcesView({ onAddSource }: { onAddSource: (url?: string) => void }) {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 p-4 sm:p-6 lg:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Sources</h2>
          <p className="text-sm text-muted-foreground">
            Les chaînes et playlists qui alimentent votre mémoire automatiquement.
          </p>
        </div>
        <Button onClick={() => onAddSource()}>
          <PlusIcon data-icon="inline-start" /> Ajouter une source
        </Button>
      </div>
      <SubscriptionsPanel onAddSource={onAddSource} />
    </div>
  )
}
