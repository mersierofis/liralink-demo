import type { PayQuote, Payment } from '@/api/types'

const PLATFORM = 'GDWV6USF4R2ULWR5XW3TEUZSIRGRCU7PQWGSBDYJVIRFNAJ3LVNQ34N2'
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
const PAYER = 'GBRZSG7K6ZXJRCMYM2O2HO2DKR7RO2ACZ5FARBMQZBB4YZMDFDXFUTV7'

function payment(partial: Partial<Payment> & Pick<Payment, 'txHash' | 'amountUSDC' | 'linkId'>): Payment {
  return {
    id: partial.id ?? crypto.randomUUID(),
    rail: 'memo',
    payerAddress: PAYER,
    ledger: partial.ledger ?? 4642155,
    explorerUrl: `https://stellar.expert/explorer/testnet/tx/${partial.txHash}`,
    detectedAt: partial.detectedAt ?? new Date().toISOString(),
    ...partial,
  }
}

function baseQuote(overrides: Partial<PayQuote> & Pick<PayQuote, 'code' | 'status'>): PayQuote {
  const code = overrides.code
  return {
    merchantName: 'Erdemli Narenciye A.Ş.',
    title: 'Lemon order #1042',
    amountTRY: '5000.00',
    amountUSDC: '147.0588236',
    fxRate: '34.0000000',
    quoteExpiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    receivedUSDC: '0.0000000',
    rails: { memo: { destination: PLATFORM, memo: code } },
    asset: { code: 'USDC', issuer: USDC_ISSUER },
    network: 'testnet',
    payments: [],
    ...overrides,
    code,
  }
}

/** Mutable mock store — handlers flip status after /submitted. */
export const mockStore: Record<string, PayQuote> = {
  DEMO0001: baseQuote({
    code: 'DEMO0001',
    status: 'open',
    title: 'Lemon order #1042',
    amountTRY: '5000.00',
    amountUSDC: '147.0588236',
  }),
  DEMO0002: (() => {
    const tx = '7b80b57dfba0d61ca744496457e98e34299397da35d39d7cd32f8caacaa6af94'
    const p = payment({
      linkId: 'demo-2',
      txHash: tx,
      amountUSDC: '10.0000000',
    })
    return baseQuote({
      code: 'DEMO0002',
      status: 'paid',
      title: 'Kuru kayisi 5kg',
      amountTRY: '340.00',
      amountUSDC: '10.0000000',
      receivedUSDC: '10.0000000',
      payment: p,
      payments: [p],
    })
  })(),
  DEMO0003: baseQuote({
    code: 'DEMO0003',
    status: 'expired',
    quoteExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  }),
  DEMO0004: baseQuote({
    code: 'DEMO0004',
    status: 'cancelled',
  }),
  DEMO0005: baseQuote({
    code: 'DEMO0005',
    status: 'underpaid',
    title: 'Partial lemon crate',
    amountTRY: '170.00',
    amountUSDC: '5.0000000',
    receivedUSDC: '3.0000000',
    shortfallUSDC: '2.0000000',
    payments: [
      payment({
        linkId: 'demo-5',
        txHash: '6733184393bebb22e404e0aa67dfd41a9401e95793a93327c16f34a773dc38f5',
        amountUSDC: '3.0000000',
      }),
    ],
  }),
  // Real paid fixtures from handoff (for UI rehearsal)
  VHHCJ8QZ: (() => {
    const tx = '7b80b57dfba0d61ca744496457e98e34299397da35d39d7cd32f8caacaa6af94'
    const p = payment({
      id: '0d9f6008-e2e6-49ec-8b00-e4f0cc43a101',
      linkId: '3dab58cc-528f-4afd-b40b-c705cd47f3ba',
      txHash: tx,
      amountUSDC: '10.0000000',
      ledger: 4642155,
      detectedAt: '2026-09-12T17:32:44.172Z',
    })
    return baseQuote({
      code: 'VHHCJ8QZ',
      status: 'paid',
      title: 'Kuru kayisi 5kg',
      amountTRY: '340.00',
      amountUSDC: '10.0000000',
      receivedUSDC: '10.0000000',
      payment: p,
      payments: [p],
    })
  })(),
}

/** After /submitted, DEMO0001 flips to paid on the 3rd status poll. */
export const mockPollCounts: Record<string, number> = {}
