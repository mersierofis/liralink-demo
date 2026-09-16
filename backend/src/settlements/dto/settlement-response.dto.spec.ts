import { Decimal } from '../../common/decimal';
import type { Settlement } from '../../generated/prisma/client';
import { SettlementResponseDto } from './settlement-response.dto';

const URL =
  'https://testanchor.stellar.org/sep24/transactions/withdraw/webapp?token=t';

function settlement(overrides: Partial<Settlement>): Settlement {
  return {
    id: 's1',
    merchantId: 'm1',
    paymentId: 'p1',
    amountUSDC: new Decimal('1'),
    amountTRY: new Decimal('34'),
    fxRate: new Decimal('34'),
    savedUSDC: new Decimal('0'),
    feeUSDC: null,
    netTRY: null,
    provider: 'sep24',
    status: 'processing',
    anchorRef: 'anchor-1',
    createdAt: new Date('2026-09-13T00:00:00Z'),
    completedAt: null,
    interactiveUrl: URL,
    anchorStatus: 'incomplete',
    blockedReason: null,
    failReason: null,
    anchorTxHash: null,
    anchorTxXdr: null,
    anchorMemo: null,
    ...overrides,
  };
}

describe('SettlementResponseDto.interactiveUrl', () => {
  it('is exposed while the anchor waits for the merchant (processing, incomplete)', () => {
    expect(
      SettlementResponseDto.fromEntity(settlement({})).interactiveUrl,
    ).toBe(URL);
  });

  it.each([
    ['the anchor moved on', { anchorStatus: 'pending_user_transfer_start' }],
    ['no status seen yet', { anchorStatus: null }],
    ['completed', { status: 'completed', anchorStatus: 'completed' }],
    ['failed', { status: 'failed', anchorStatus: 'incomplete' }],
    ['mock', { provider: 'mock', interactiveUrl: null, anchorStatus: null }],
  ] as [string, Partial<Settlement>][])('is null when %s', (_label, o) => {
    expect(
      SettlementResponseDto.fromEntity(settlement(o)).interactiveUrl,
    ).toBeNull();
  });
});
