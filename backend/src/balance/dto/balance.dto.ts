/** Matches the documented `Balance` contract (docs/api.types.ts, 00-PROJECT.md §6). */
export class BalanceDto {
  availableTRY: string; // decimal string, 2 dp
  pendingTRY: string; // decimal string, 2 dp
  savedUSDC: string; // decimal string, 7 dp
  unallocatedUSDC: string; // decimal string, 7 dp — excess from overpaid links + stray payments
}
