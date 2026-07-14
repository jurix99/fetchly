"use client"

import { CheckIcon, Loader2Icon, TriangleAlertIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import type { Content } from "@/lib/backend"

type StepState = "todo" | "active" | "done" | "error"

interface Step {
  label: string
  state: StepState
  hint?: string
}

/** The enrichment steps of a content, derived from its consolidated statuses.
 *  Kills the "downloader feel": a captured card shows Téléchargement →
 *  Transcription → Résumé → Indexé, each moving skeleton → ✓ (or a clickable
 *  error). Returns null once nothing is in flight — the discreet indicators take
 *  over on a settled card. */
export function contentSteps(c: Content): Step[] {
  const dl: StepState = c.lifecycle === "pending" ? "active" : "done"
  const tr: StepState =
    c.transcript_status === "done" || c.transcript_status === "skipped"
      ? "done"
      : c.transcript_status === "error"
        ? "error"
        : c.transcript_status === "running" || c.transcript_status === "queued"
          ? "active"
          : "todo"
  const gen: StepState =
    c.generation_status === "done"
      ? "done"
      : c.generation_status === "error"
        ? "error"
        : c.generation_status === "running" || c.generation_status === "queued"
          ? "active"
          : "todo"
  const idx: StepState = c.index_status === "done" ? "done" : "todo"

  const dlHint = dl === "active" && c.download_progress != null ? `${Math.round(c.download_progress)}%` : undefined
  return [
    { label: "Téléchargement", state: dl, hint: dlHint },
    { label: "Transcription", state: tr },
    { label: "Résumé", state: gen },
    { label: "Indexé", state: idx },
  ]
}

/** Whether a content is actively enriching (or errored) — i.e. the step row is
 *  worth showing instead of the settled indicators. */
export function isEnriching(c: Content): boolean {
  if (c.lifecycle === "pending") return true
  const s = [c.transcript_status, c.generation_status]
  return s.some((x) => x === "queued" || x === "running" || x === "error")
}

export function ContentSteps({
  content,
  onOpenError,
  className,
}: {
  content: Content
  onOpenError?: () => void
  className?: string
}) {
  if (!isEnriching(content)) return null
  const steps = contentSteps(content)
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {steps.map((s, i) => (
        <StepChip key={i} step={s} onClick={s.state === "error" ? onOpenError : undefined} />
      ))}
    </div>
  )
}

function StepChip({ step, onClick }: { step: Step; onClick?: () => void }) {
  const content = (
    <>
      {step.state === "done" ? (
        <CheckIcon className="size-3 text-success" />
      ) : step.state === "active" ? (
        <Loader2Icon className="size-3 animate-spin text-primary" />
      ) : step.state === "error" ? (
        <TriangleAlertIcon className="size-3 text-destructive" />
      ) : (
        <span className="size-2 rounded-full bg-muted-foreground/30" />
      )}
      <span
        className={cn(
          step.state === "todo" && "text-muted-foreground/50",
          step.state === "error" && "text-destructive underline underline-offset-2",
        )}
      >
        {step.label}
        {step.hint ? ` ${step.hint}` : ""}
      </span>
    </>
  )
  const cls =
    "inline-flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-[10px] font-medium"
  return onClick ? (
    <button type="button" onClick={onClick} className={cls}>
      {content}
    </button>
  ) : (
    <span className={cls}>{content}</span>
  )
}
