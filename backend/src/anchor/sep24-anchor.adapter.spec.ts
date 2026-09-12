import { ConfigService } from '@nestjs/config';
import { Keypair } from '@stellar/stellar-sdk';
import { Decimal } from '../common/decimal';
import type { Merchant } from '../generated/prisma/client';
import type { Sep24Transaction } from './sep24';
import { Sep24AnchorAdapter } from './sep24-anchor.adapter';

const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const OUR_USDC = `stellar:USDC:${ISSUER}`;

/** An adapter whose anchor always reports `txn` — no network involved. */
function adapterSeeing(txn: Sep24Transaction): Sep24AnchorAdapter {
  const adapter = new Sep24AnchorAdapter(
    new ConfigService({
      ANCHOR_HOME_DOMAIN: 'testanchor.stellar.org',
      PLATFORM_ACCOUNT_SECRET: Keypair.random().secret(),
      HORIZON_URL: 'https://horizon-testnet.stellar.org',
      NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
      USDC_CODE: 'USDC',
      USDC_ISSUER: ISSUER,
    }),
  );
  jest
    .spyOn(
      adapter as unknown as {
        getTransaction(id: string): Promise<Sep24Transaction>;
      },
      'getTransaction',
    )
    .mockResolvedValue(txn);
  return adapter;
}

/** Resumes a settlement whose withdraw is already open and paid (anchorRef set). */
function resume(adapter: Sep24AnchorAdapter) {
  return adapter.settleToTRY({
    settlement: {
      id: 's1',
      amountUSDC: new Decimal('1.0000000'),
      anchorRef: 'anchor-1',
      interactiveUrl: null,
      anchorTxHash: 'hash',
      anchorTxXdr: 'xdr',
    },
    merchant: { iban: 'TR330006100519786457841326' } as Merchant,
    save: jest.fn(),
  });
}

describe('Sep24AnchorAdapter — completed withdraw', () => {
  it('fails with unexpected_fee_asset when the fee is in another asset (returned, not thrown)', async () => {
    const result = await resume(
      adapterSeeing({
        id: 'anchor-1',
        status: 'completed',
        fee_details: { total: '0.1', asset: 'iso4217:USD' },
      }),
    );
    expect(result).toMatchObject({
      status: 'failed',
      ref: 'anchor-1',
      reason: 'unexpected_fee_asset',
    });
    expect(result.status === 'failed' && result.detail).toContain(
      'iso4217:USD',
    );
  });

  it('completes with the fee when it is in our USDC', async () => {
    const result = await resume(
      adapterSeeing({
        id: 'anchor-1',
        status: 'completed',
        fee_details: { total: '0.1', asset: OUR_USDC },
      }),
    );
    expect(result).toMatchObject({ status: 'completed', ref: 'anchor-1' });
    expect(result.status === 'completed' && result.feeUSDC.toFixed(7)).toBe(
      '0.1000000',
    );
  });

  it('fails with anchor_status when the anchor ends the withdraw in error', async () => {
    const result = await resume(
      adapterSeeing({
        id: 'anchor-1',
        status: 'error',
        message: 'bank rejected',
      }),
    );
    expect(result).toMatchObject({
      status: 'failed',
      reason: 'anchor_status',
      detail: 'anchor transaction error: bank rejected',
    });
  });
});
