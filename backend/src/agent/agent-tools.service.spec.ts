import { NotFoundException } from '@nestjs/common';
import { Decimal } from '../common/decimal';
import { AgentToolsService, type ToolContext } from './agent-tools.service';
import { ProposalStore } from './proposal.store';

function build(max = 340) {
  const links = {
    findOneByCodeForMerchant: jest.fn(),
    findAll: jest.fn().mockResolvedValue({ items: [], total: 0 }),
  };
  const fx = {
    getRate: jest.fn().mockResolvedValue({
      rate: new Decimal('34'),
      source: 'mock',
      fetchedAt: new Date('2026-10-10T00:00:00Z'),
    }),
  };
  const proposals = new ProposalStore();
  const audit = { record: jest.fn() };
  const config = {
    get: jest.fn((k: string) => (k === 'AGENT_MAX_LINK_TRY' ? max : undefined)),
  };
  const tools = new AgentToolsService(
    links as never,
    fx as never,
    proposals,
    audit as never,
    config as never,
  );
  const ctx = (): ToolContext => ({ merchantId: 'm1', conversationId: 'c1' });
  return { tools, links, fx, proposals, audit, ctx };
}

describe('AgentToolsService', () => {
  it("get_payment_link: another merchant's code is 'not found'", async () => {
    const { tools, links, ctx } = build();
    links.findOneByCodeForMerchant.mockRejectedValue(new NotFoundException());
    const r = await tools.run(ctx(), 'get_payment_link', { code: 'xyz12345' });
    expect(r.output).toEqual({ error: 'Link not found for this merchant.' });
    // always scoped to the signed-in merchant, code upper-cased
    expect(links.findOneByCodeForMerchant).toHaveBeenCalledWith(
      'm1',
      'XYZ12345',
    );
  });

  it('create_payment_link over the limit: error, no proposal, no FX call', async () => {
    const { tools, fx, proposals, ctx } = build();
    const c = ctx();
    const r = await tools.run(c, 'create_payment_link', {
      title: 'Big',
      amountTRY: 340.01,
    });
    expect(String(r.output.error)).toContain('340');
    expect(c.proposal).toBeUndefined();
    expect(fx.getRate).not.toHaveBeenCalled();
    expect(() => proposals.settle('m1', 'anything', 'confirmed')).toThrow();
  });

  it('create_payment_link at the limit makes a proposal and no link code', async () => {
    const { tools, ctx } = build();
    const c = ctx();
    const r = await tools.run(c, 'create_payment_link', {
      title: 'Logo',
      amountTRY: 340,
    });
    expect(c.proposal).toMatchObject({
      amountTRY: '340.00',
      estimatedUSDC: '10.00',
      status: 'pending',
    });
    expect(r.output.proposalId).toBe(c.proposal!.id);
    expect(r.output).not.toHaveProperty('code');
  });

  it.each([0, -5, 0.5, NaN])('rejects amount %p', async (amountTRY) => {
    const { tools, ctx } = build();
    const c = ctx();
    const r = await tools.run(c, 'create_payment_link', {
      title: 'x',
      amountTRY,
    });
    expect(r.output.error).toBeDefined();
    expect(c.proposal).toBeUndefined();
  });

  it('rejects a missing title', async () => {
    const { tools, ctx } = build();
    const r = await tools.run(ctx(), 'create_payment_link', {
      title: '  ',
      amountTRY: 10,
    });
    expect(r.output.error).toBeDefined();
  });

  it('list_payment_links rejects "overpaid" and passes valid statuses through', async () => {
    const { tools, links, ctx } = build();
    expect(
      (await tools.run(ctx(), 'list_payment_links', { status: 'overpaid' }))
        .output.error,
    ).toBeDefined();
    await tools.run(ctx(), 'list_payment_links', { status: 'underpaid' });
    expect(links.findAll).toHaveBeenCalledWith('m1', {
      status: 'underpaid',
      page: 1,
      limit: 50,
    });
  });

  it('writes an audit line for every call and unexpected errors stay generic', async () => {
    const { tools, links, audit, ctx } = build();
    links.findOneByCodeForMerchant.mockRejectedValue(
      new Error('prisma exploded: secret details'),
    );
    const r = await tools.run(ctx(), 'get_payment_link', { code: 'ABC' });
    expect(JSON.stringify(r)).not.toContain('secret');
    expect(audit.record).toHaveBeenCalledWith(
      'm1',
      'get_payment_link',
      { code: 'ABC' },
      expect.stringContaining('error'),
    );
  });
});
