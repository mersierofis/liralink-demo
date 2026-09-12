import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { formatTRY, formatUSDC } from '@/lib/money'
import type { Balance } from '@/api/types'

export function BalanceCard({ balance, isLoading }: { balance: Balance | undefined; isLoading: boolean }) {
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

  const savedUSDC = Number(balance.savedUSDC)
  const unallocatedUSDC = Number(balance.unallocatedUSDC)

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>Available balance</CardDescription>
        <CardTitle className="text-3xl">{formatTRY(balance.availableTRY)}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
        <div>
          <p className="text-muted-foreground">Pending</p>
          <p className="font-medium">{formatTRY(balance.pendingTRY)}</p>
        </div>
        {savedUSDC > 0 && (
          <div>
            <p className="text-muted-foreground">Saved (USDC)</p>
            <p className="font-medium">{formatUSDC(balance.savedUSDC)}</p>
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
