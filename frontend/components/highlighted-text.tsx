import { Fragment } from "react"

import { cn } from "@/lib/utils"

/** Renders `text` with the highlighted spans (char offsets from the search API)
 *  wrapped in <mark>. Shared visual language with the transcript local search —
 *  same warning wash so a match reads identically everywhere. */
export function HighlightedText({
  text,
  highlights,
  className,
}: {
  text: string
  highlights?: [number, number][]
  className?: string
}) {
  if (!highlights || highlights.length === 0) return <>{text}</>
  // Clamp + sort so malformed offsets never throw.
  const spans = [...highlights]
    .map(([s, e]) => [Math.max(0, s), Math.min(text.length, e)] as [number, number])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0])

  const out: React.ReactNode[] = []
  let cursor = 0
  spans.forEach(([s, e], i) => {
    if (s < cursor) return // overlapping — skip
    if (s > cursor) out.push(<Fragment key={`t${i}`}>{text.slice(cursor, s)}</Fragment>)
    out.push(
      <mark key={`m${i}`} className={cn("rounded bg-warning/40 text-foreground", className)}>
        {text.slice(s, e)}
      </mark>,
    )
    cursor = e
  })
  if (cursor < text.length) out.push(<Fragment key="tail">{text.slice(cursor)}</Fragment>)
  return <>{out}</>
}
