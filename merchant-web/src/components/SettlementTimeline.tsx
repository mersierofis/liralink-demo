import { Check, Circle, Loader2 } from 'lucide-react'

import { cn } from '@/lib/utils'

const STAGES = ['pending', 'processing', 'completed'] as const

/**
 * Illustrative only for now — GET /settlements isn't joined to a link here yet (it's
 * keyed by paymentId). Wired to the real settlement once the Payments/Balance step
 * (03-MERCHANT-WEB.md step 5) adds the settlements hooks.
 */
export function SettlementTimeline({ hasPayment }: { hasPayment: boolean }) {
  return (
    <div className="flex items-center gap-2">
      {STAGES.map((stage, i) => (
        <div key={stage} className="flex flex-1 items-center gap-2">
          <div
            className={cn(
              'flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs',
              hasPayment && i === 0 && 'border-success bg-success/10 text-success',
              hasPayment && i > 0 && 'border-muted-foreground/30 text-muted-foreground',
              !hasPayment && 'border-muted-foreground/30 text-muted-foreground',
            )}
          >
            {hasPayment && i === 0 ? <Check className="h-3.5 w-3.5" /> : hasPayment && i === 1 ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Circle className="h-2 w-2 fill-current" />
            )}
          </div>
          <span className="text-xs capitalize text-muted-foreground">{stage}</span>
          {i < STAGES.length - 1 && <div className="h-px flex-1 bg-border" />}
        </div>
      ))}
    </div>
  )
}
