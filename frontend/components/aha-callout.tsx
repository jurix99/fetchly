"use client"

import { SearchIcon, SparklesIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"

/** The one-time first-transcript "aha": staged the moment the instance produces
 *  its first transcript. Invites the north-star gesture (type three words heard
 *  in a video). Dismissed for good on the first successful search or on close. */
export function AhaCallout({
  onOpenPalette,
  onDismiss,
}: {
  onOpenPalette: () => void
  onDismiss: () => void
}) {
  return (
    <div className="relative flex flex-col gap-3 overflow-hidden rounded-xl border border-primary/30 bg-gradient-to-br from-primary/10 to-transparent p-4">
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Fermer"
        className="absolute right-2 top-2 text-muted-foreground transition-colors hover:text-foreground"
      >
        <XIcon className="size-4" />
      </button>
      <div className="flex items-center gap-2">
        <span className="flex size-8 items-center justify-center rounded-lg bg-primary/15 text-primary">
          <SparklesIcon className="size-4" />
        </span>
        <div>
          <h3 className="text-sm font-semibold">Votre mémoire est prête</h3>
          <p className="text-xs text-muted-foreground">
            Cette vidéo est désormais interrogeable au mot près.
          </p>
        </div>
      </div>
      <p className="text-sm text-foreground/90">
        Essayez : tapez <span className="font-medium">trois mots</span> que vous avez entendus dans
        cette vidéo — Fetchly vous emmène à la seconde exacte.
      </p>
      <Button size="sm" className="w-fit" onClick={onOpenPalette}>
        <SearchIcon data-icon="inline-start" /> Rechercher un passage
      </Button>
    </div>
  )
}
