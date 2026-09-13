import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatUSDCDisplay } from '@/stellar/format'

/**
 * Primary action is the classic memo rail today.
 * When `rails.contract` is present we keep a slot for a future "Pay via contract" primary.
 */
export function PayButton({
  amountUSDC,
  disabled,
  loading,
  hasContractRail,
  onPayMemo,
}: {
  amountUSDC: string
  disabled?: boolean
  loading?: boolean
  hasContractRail?: boolean
  onPayMemo: () => void
}) {
  return (
    <div className="space-y-2">
      <Button
        type="button"
        className="w-full"
        size="lg"
        disabled={disabled || loading}
        onClick={onPayMemo}
      >
        {loading ? <Loader2 className="animate-spin" /> : null}
        {loading ? 'Signing…' : `Pay ${formatUSDCDisplay(amountUSDC)} USDC`}
      </Button>
      {hasContractRail ? (
        <p className="text-center text-[11px] text-muted-foreground">
          Contract rail available — memo payment is active for this build.
        </p>
      ) : null}
    </div>
  )
}
