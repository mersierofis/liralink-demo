/** Matches the documented `Balance` contract (docs/api.types.ts, 00-PROJECT.md §6). */
export class BalanceDto {
  availableTRY: string; // decimal string, 2 dp
  pendingTRY: string; // decimal string, 2 dp
  paidOutTRY: string; // decimal string, 2 dp — completed auto_payout settlements, already on the IBAN
  savedUSDC: string; // decimal string, 7 dp
  unallocatedUSDC: string; // decimal string, 7 dp — excess from overpaid links + stray payments
}
