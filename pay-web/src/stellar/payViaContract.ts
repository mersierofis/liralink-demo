import { Client } from 'invoice-client'
import type { PayQuote } from '@/api/types'
import { WalletNetwork } from './walletKit'

const RPC_URL = 'https://soroban-testnet.stellar.org'

export function isContractRailEnabled(): boolean {
  // Default ON; set VITE_CONTRACT_RAIL=false to hide / skip contract pay.
  return import.meta.env.VITE_CONTRACT_RAIL !== 'false'
}

/**
 * Pay through the Soroban invoice contract (primary when rails.contract is present).
 * Uses packages/invoice-client; wallet kit signs the assembled tx.
 */
export async function payViaContract(opts: {
  quote: PayQuote
  payer: string
  signXdr: (xdr: string) => Promise<string>
}): Promise<{ hash: string }> {
  const rail = opts.quote.rails.contract
  if (!rail?.contractId || !rail.invoiceCode) {
    throw new Error('This link has no contract payment rail.')
  }

  const client = new Client({
    contractId: rail.contractId,
    networkPassphrase: WalletNetwork.TESTNET,
    rpcUrl: RPC_URL,
    publicKey: opts.payer,
  })

  let assembled
  try {
    assembled = await client.pay({
      code: rail.invoiceCode,
      payer: opts.payer,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Contract simulation failed: ${msg}`)
  }

  try {
    const sent = await assembled.signAndSend({
      signTransaction: async (xdr: string) => {
        const signedTxXdr = await opts.signXdr(xdr)
        return { signedTxXdr }
      },
    })
    const hash =
      (sent as { hash?: string; getTransactionResponse?: { txHash?: string } }).hash ??
      (sent as { getTransactionResponse?: { txHash?: string } }).getTransactionResponse?.txHash
    if (!hash) {
      throw new Error('Contract pay submitted but no tx hash was returned.')
    }
    return { hash }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/reject|denied|cancel|user/i.test(msg)) {
      throw new Error('Signature rejected in the wallet. Nothing was sent.')
    }
    throw new Error(msg)
  }
}
