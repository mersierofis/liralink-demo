import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EmptyState } from '@/components/EmptyState'
import { ErrorState } from '@/components/ErrorState'
import { ExplorerLink } from '@/components/ExplorerLink'
import { useUsdcWithdrawals } from '@/api/hooks'
import { HttpError } from '@/api/client'
import { formatUSDC, formatUSDCFull } from '@/lib/money'
import { formatDateTime, shortAddress } from '@/lib/format'
import type { UsdcWdStatus } from '@/api/types'

const STATUS: Record<UsdcWdStatus, { label: string; variant: 'success' | 'warning' | 'destructive' }> = {
  submitted: { label: 'Submitted', variant: 'warning' },
  completed: { label: 'Completed', variant: 'success' },
  failed: { label: 'Failed', variant: 'destructive' },
}

export function UsdcWithdrawalsList() {
  const { data, isLoading, isError, error, refetch } = useUsdcWithdrawals({ limit: 50 })

  // Older backend without the route: nothing to show.
  if (isError && error instanceof HttpError && error.statusCode === 404) return null

  return (
    <div>
      <h2 className="mb-3 text-lg font-medium">USDC withdrawals</h2>
      {isLoading && <Skeleton className="h-12 w-full" />}
      {isError && (
        <ErrorState message={error instanceof HttpError ? error.message : 'Could not load USDC withdrawals.'} onRetry={() => refetch()} />
      )}
      {data && data.items.length === 0 && (
        <EmptyState title="No USDC withdrawals yet" description="Use “Send to my wallet” on the dashboard to move USDC to your own wallet." />
      )}
      {data && data.items.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Amount</TableHead>
              <TableHead>From</TableHead>
              <TableHead>Destination</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Tx</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.items.map((w) => (
              <TableRow key={w.id}>
                <TableCell className="text-sm text-muted-foreground">{formatDateTime(w.createdAt)}</TableCell>
                <TableCell title={formatUSDCFull(w.amountUSDC)}>{formatUSDC(w.amountUSDC)}</TableCell>
                <TableCell>{w.source === 'saved' ? 'Held in USD' : 'Unallocated'}</TableCell>
                <TableCell className="font-mono text-xs">{shortAddress(w.destination, 6, 6)}</TableCell>
                <TableCell>
                  <Badge variant={STATUS[w.status].variant} title={w.failReason ? `Reason: ${w.failReason}` : undefined}>
                    {STATUS[w.status].label}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  <ExplorerLink href={w.explorerUrl}>{shortAddress(w.txHash, 4, 4)}</ExplorerLink>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
