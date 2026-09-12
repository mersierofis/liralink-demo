import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { formatTRY, formatUSDC } from '@/lib/money'
import type { Balance, SettlementMode } from '@/api/types'

export function BalanceCard({
  balance,
  isLoading,
  settlementMode,
}: {
  balance: Balance | undefined
  isLoading: boolean
  settlementMode: SettlementMode | undefined
}) {
  if (isLoading || !balance) {
    return (
      <Card>
        <CardHeader>
          <CardDescription>Available balance</CardDescription>
          <Skeleton className="h-9 w-40" />
        </CardHeader>
      </Card>
    )
  }

  const isAutoPayout = settlementMode === 'auto_payout'
  const savedUSDC = Number(balance.savedUSDC)
  const unallocatedUSDC = Number(balance.unallocatedUSDC)

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{isAutoPayout ? 'Paid out to your IBAN' : 'Available balance'}</CardDescription>
        <CardTitle className="text-3xl">{formatTRY(isAutoPayout ? balance.paidOutTRY : balance.availableTRY)}</CardTitle>
        {isAutoPayout && (
          <p className="text-xs text-muted-foreground">
            Your anchor pays each settlement straight to your IBAN — there's no balance to withdraw manually.
          </p>
        )}
      </CardHeader>
      <CardContent className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
        <div>
          <p className="text-muted-foreground">Pending</p>
          <p className="font-medium">{formatTRY(balance.pendingTRY)}</p>
        </div>
        {!isAutoPayout && Number(balance.paidOutTRY) > 0 && (
          <div>
            <p className="text-muted-foreground">Paid out (auto)</p>
            <p className="font-medium">{formatTRY(balance.paidOutTRY)}</p>
          </div>
        )}
        {savedUSDC > 0 && (
          <div>
            <p className="text-muted-foreground">Held in USD (USDC)</p>
            <p className="font-medium">{formatUSDC(balance.savedUSDC)}</p>
            <p className="text-xs text-muted-foreground">Held by LiraLink until you request a transfer</p>
          </div>
        )}
        {unallocatedUSDC > 0 && (
          <div>
            <p className="text-muted-foreground">Unallocated USDC</p>
            <p className="font-medium">{formatUSDC(balance.unallocatedUSDC)}</p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
