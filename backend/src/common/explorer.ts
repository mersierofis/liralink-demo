// Testnet-only for this hackathon build — see docs/00-PROJECT.md §4.
const EXPLORER_TX_BASE = 'https://stellar.expert/explorer/testnet/tx/';
const EXPLORER_ACCOUNT_BASE =
  'https://stellar.expert/explorer/testnet/account/';

export function explorerTxUrl(txHash: string): string {
  return `${EXPLORER_TX_BASE}${txHash}`;
}

export function explorerAccountUrl(address: string): string {
  return `${EXPLORER_ACCOUNT_BASE}${address}`;
}
