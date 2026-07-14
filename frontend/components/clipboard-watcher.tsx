"use client"

import { useEffect, useRef } from "react"
import { toast } from "sonner"

import { readClipboardUrl } from "@/lib/api"

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return "cette URL"
  }
}

/**
 * Capture omniprésente : (1) au focus de la fenêtre, propose de capturer une URL
 * trouvée dans le presse-papier ; (2) un Ctrl/Cmd+V n'importe où dans l'app (hors
 * champ de saisie) propose « Capturer {domaine} ? ». Les deux lancent la capture
 * en un clic — le geste, pas le lieu.
 */
export function ClipboardWatcher({ onCapture }: { onCapture: (url: string) => void }) {
  const lastSeen = useRef<string | null>(null)

  useEffect(() => {
    function offer(url: string) {
      if (!url || url === lastSeen.current) return
      lastSeen.current = url
      toast(`Capturer ${domainOf(url)} ?`, {
        description: url.length > 56 ? url.slice(0, 56) + "…" : url,
        action: { label: "Capturer", onClick: () => onCapture(url) },
        duration: 8000,
      })
    }

    async function onFocus() {
      const url = await readClipboardUrl()
      if (url) offer(url)
    }

    function isEditable(el: EventTarget | null): boolean {
      const node = el as HTMLElement | null
      if (!node) return false
      const tag = node.tagName
      return tag === "INPUT" || tag === "TEXTAREA" || node.isContentEditable
    }

    function onPaste(e: ClipboardEvent) {
      if (isEditable(e.target) || isEditable(document.activeElement)) return
      const text = e.clipboardData?.getData("text")?.trim()
      if (text && /^https?:\/\/\S+$/.test(text)) offer(text)
    }

    window.addEventListener("focus", onFocus)
    document.addEventListener("paste", onPaste)
    return () => {
      window.removeEventListener("focus", onFocus)
      document.removeEventListener("paste", onPaste)
    }
  }, [onCapture])

  return null
}
