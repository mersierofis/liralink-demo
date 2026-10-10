import { useEffect, useState } from 'react'
import { CheckCircle2, Clock, QrCode, XCircle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { formatTRY } from '@/lib/money'
import type { AgentProposal, PaymentLink } from '@/api/types'

export type ProposalUiState =
  | { status: 'pending' }
  | { status: 'confirming' }
  | { status: 'cancelling' }
  | { status: 'confirmed'; link: PaymentLink }
  | { status: 'cancelled' }
  | { status: 'failed'; message: string }

function secondsLeft(expiresAt: string): number {
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000))
}

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export function ProposalCard({
  proposal,
  state,
  onConfirm,
  onCancel,
  onShowLink,
}: {
  proposal: AgentProposal
  state: ProposalUiState
  onConfirm: () => void
  onCancel: () => void
  onShowLink?: (link: PaymentLink) => void
}) {
  const [left, setLeft] = useState(() => secondsLeft(proposal.expiresAt))

  useEffect(() => {
    setLeft(secondsLeft(proposal.expiresAt))
    const timer = setInterval(() => setLeft(secondsLeft(proposal.expiresAt)), 1000)
    return () => clearInterval(timer)
  }, [proposal.expiresAt])

  const open = state.status === 'pending' || state.status === 'confirming' || state.status === 'cancelling'
  const expired = open && left === 0
  const busy = state.status === 'confirming' || state.status === 'cancelling'

  return (
    <Card className="max-w-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{proposal.title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 text-sm">
        <p className="text-2xl font-semibold">{formatTRY(proposal.amountTRY)}</p>
        <p className="text-muted-foreground">≈ {proposal.estimatedUSDC} USDC (estimate)</p>
        {proposal.description && <p className="text-muted-foreground">{proposal.description}</p>}
      </CardContent>
      <CardFooter className="flex flex-col items-stretch gap-2">
        {open && !expired && (
          <>
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="h-3 w-3" />
              Expires in {formatCountdown(left)}
            </p>
            <div className="flex gap-2">
              <Button size="sm" onClick={onConfirm} disabled={busy}>
                {state.status === 'confirming' ? 'Creating…' : 'Confirm'}
              </Button>
              <Button size="sm" variant="outline" onClick={onCancel} disabled={busy}>
                {state.status === 'cancelling' ? 'Cancelling…' : 'Cancel'}
              </Button>
            </div>
          </>
        )}
        {expired && (
          <p className="flex items-center gap-1 text-sm text-muted-foreground">
            <XCircle className="h-4 w-4" />
            Expired. Ask the assistant again.
          </p>
        )}
        {state.status === 'confirmed' && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="flex items-center gap-1 text-green-700 dark:text-green-400">
              <CheckCircle2 className="h-4 w-4" />
              Link {state.link.code} created
            </span>
            {onShowLink && (
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => onShowLink(state.link)}>
                <QrCode className="h-3.5 w-3.5" />
                Copy link / QR
              </Button>
            )}
          </div>
        )}
        {state.status === 'cancelled' && (
          <p className="flex items-center gap-1 text-sm text-muted-foreground">
            <XCircle className="h-4 w-4" />
            Cancelled. No link was created.
          </p>
        )}
        {state.status === 'failed' && (
          <p role="alert" className="text-sm text-destructive">
            {state.message}
          </p>
        )}
      </CardFooter>
    </Card>
  )
}
