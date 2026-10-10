import { useState } from 'react'
import { ChevronDown, ChevronRight, Wrench } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { AgentToolCall } from '@/api/types'

/** A short, readable form of the tool input, e.g. `ABC12345` or `200 TRY`. */
function shortInput(input: Record<string, unknown>): string {
  const text = Object.values(input)
    .filter((v) => v !== undefined && v !== null && v !== '')
    .map((v) => String(v))
    .join(', ')
  return text.length > 36 ? `${text.slice(0, 35)}…` : text
}

function Chip({ call }: { call: AgentToolCall }) {
  const [open, setOpen] = useState(false)
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <div className="rounded-md border bg-background text-xs">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Wrench className="h-3 w-3 shrink-0" />
        <span className="font-mono font-medium">{call.name}</span>
        <span className="truncate">{shortInput(call.input)}</span>
        <Chevron className="ml-auto h-3 w-3 shrink-0" />
      </button>
      {open && <p className={cn('border-t px-2 py-1.5 text-foreground')}>{call.summary}</p>}
    </div>
  )
}

export function ToolCallChips({ calls }: { calls: AgentToolCall[] }) {
  if (calls.length === 0) return null
  return (
    <div className="flex flex-col gap-1" aria-label="Tools used">
      {calls.map((call, i) => (
        <Chip key={i} call={call} />
      ))}
    </div>
  )
}
