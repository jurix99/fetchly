"use client"

import { TriangleAlertIcon, type LucideIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"

type FeedbackState = "loading" | "empty" | "error"

interface InlineFeedbackProps {
  state: FeedbackState
  /** Title shown for `empty` / `error`. */
  title?: string
  description?: React.ReactNode
  /** Icon for `empty` (and `error`, which defaults to a warning triangle). */
  icon?: LucideIcon
  /** Primary action — an <Empty> footer slot. For `error`, put the retry button here. */
  action?: React.ReactNode
  /** Number of skeleton rows for `loading`. Defaults to 3. */
  rows?: number
  className?: string
}

/**
 * Uniform content-area state: loading (skeleton), empty (Empty + action),
 * or error (actionable message + retry). See frontend/DESIGN.md — "états
 * toujours dessinés". Use this instead of ad-hoc text/spinners.
 */
export function InlineFeedback({
  state,
  title,
  description,
  icon,
  action,
  rows = 3,
  className,
}: InlineFeedbackProps) {
  if (state === "loading") {
    return (
      <div
        role="status"
        aria-live="polite"
        className={cn("flex w-full flex-col gap-2", className)}
      >
        <span className="sr-only">Chargement…</span>
        {Array.from({ length: rows }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
    )
  }

  const isError = state === "error"
  const Icon = icon ?? (isError ? TriangleAlertIcon : undefined)

  return (
    <Empty
      className={cn("border", className)}
      role={isError ? "alert" : undefined}
    >
      <EmptyHeader>
        {Icon && (
          <EmptyMedia
            variant="icon"
            className={cn(isError && "bg-destructive/10 text-destructive")}
          >
            <Icon />
          </EmptyMedia>
        )}
        {title && <EmptyTitle>{title}</EmptyTitle>}
        {description && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  )
}
