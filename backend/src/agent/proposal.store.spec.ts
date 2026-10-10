import {
  ConflictException,
  GoneException,
  NotFoundException,
} from '@nestjs/common';
import { PROPOSAL_TTL_MS, ProposalStore } from './proposal.store';

const input = (merchantId = 'm1', conversationId = 'c1') => ({
  merchantId,
  conversationId,
  title: 'Logo design',
  amountTRY: '200.00',
  estimatedUSDC: '5.88',
});

describe('ProposalStore', () => {
  let store: ProposalStore;
  beforeEach(() => {
    jest.useFakeTimers();
    store = new ProposalStore();
  });
  afterEach(() => jest.useRealTimers());

  it('confirms a pending proposal once', () => {
    const p = store.create(input());
    expect(store.settle('m1', p.id, 'confirmed').status).toBe('confirmed');
    expect(() => store.settle('m1', p.id, 'confirmed')).toThrow(
      ConflictException,
    );
  });

  it('cannot cancel after confirming, nor confirm after cancelling', () => {
    const a = store.create(input('m1', 'c1'));
    store.settle('m1', a.id, 'confirmed');
    expect(() => store.settle('m1', a.id, 'cancelled')).toThrow(
      ConflictException,
    );
    const b = store.create(input('m1', 'c2'));
    store.settle('m1', b.id, 'cancelled');
    expect(() => store.settle('m1', b.id, 'confirmed')).toThrow(
      ConflictException,
    );
  });

  it('expires after 10 minutes', () => {
    const p = store.create(input());
    jest.advanceTimersByTime(PROPOSAL_TTL_MS - 1);
    expect(store.settle('m1', p.id, 'confirmed').status).toBe('confirmed');
    const q = store.create(input('m1', 'c2'));
    jest.advanceTimersByTime(PROPOSAL_TTL_MS);
    expect(() => store.settle('m1', q.id, 'confirmed')).toThrow(GoneException);
  });

  it('another merchant cannot confirm or cancel (looks like not found)', () => {
    const p = store.create(input('m1'));
    expect(() => store.settle('m2', p.id, 'confirmed')).toThrow(
      NotFoundException,
    );
    expect(() => store.settle('m2', p.id, 'cancelled')).toThrow(
      NotFoundException,
    );
    // and the owner can still use it
    expect(store.settle('m1', p.id, 'confirmed').status).toBe('confirmed');
  });

  it('unknown id is not found', () => {
    expect(() => store.settle('m1', 'nope', 'confirmed')).toThrow(
      NotFoundException,
    );
  });

  it('a new proposal in the same conversation supersedes the pending one', () => {
    const a = store.create(input('m1', 'c1'));
    const b = store.create(input('m1', 'c1'));
    expect(() => store.settle('m1', a.id, 'confirmed')).toThrow(
      ConflictException,
    );
    expect(store.settle('m1', b.id, 'confirmed').status).toBe('confirmed');
  });
});
