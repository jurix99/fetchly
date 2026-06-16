"use client"

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { FORMATS, QUALITIES } from "@/lib/status"

export function QualitySelect({
  value,
  onChange,
  size = "default",
}: {
  value: string
  onChange: (v: string) => void
  size?: "sm" | "default"
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger size={size} className="min-w-28" aria-label="Qualité">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {QUALITIES.map((q) => (
            <SelectItem key={q} value={q}>
              {q}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

export function FormatSelect({
  value,
  onChange,
  size = "default",
}: {
  value: string
  onChange: (v: string) => void
  size?: "sm" | "default"
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger size={size} className="min-w-24" aria-label="Format">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {FORMATS.map((f) => (
            <SelectItem key={f} value={f}>
              {f}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}
