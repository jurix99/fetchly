"use client"

import { useEffect, useRef } from "react"
import { toast } from "sonner"

import { detectSource, readClipboardUrl } from "@/lib/api"
import { useStore } from "@/components/store-provider"

/**
 * Surveille le presse-papier (au focus de la fenêtre) et propose de télécharger
 * une URL vidéo détectée via un toast.
 */
export function ClipboardWatcher() {
  const { settings, addDownload } = useStore()
  const lastSeen = useRef<string | null>(null)

  useEffect(() => {
    async function check() {
      const url = await readClipboardUrl()
      if (!url || url === lastSeen.current) return
      lastSeen.current = url
      toast("URL détectée dans le presse-papier", {
        description: url.length > 48 ? url.slice(0, 48) + "…" : url,
        action: {
          label: "Télécharger",
          onClick: () =>
            addDownload({
              url,
              title: "Téléchargement depuis le presse-papier",
              quality: settings.defaultQuality,
              format: settings.defaultFormat,
              channel: detectSource(url),
            }),
        },
        duration: 8000,
      })
    }

    window.addEventListener("focus", check)
    return () => window.removeEventListener("focus", check)
  }, [addDownload, settings.defaultQuality, settings.defaultFormat])

  return null
}
