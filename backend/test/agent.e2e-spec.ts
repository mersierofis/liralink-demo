import { restoreEnv } from './helpers/agent.env'; // must stay the first import
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { LLM_CLIENT } from '../src/agent/agent.service';
import { PrismaService } from '../src/prisma/prisma.service';

type Block = { type: string; [k: string]: unknown };
const text = (t: string) => ({
  content: [{ type: 'text', text: t }],
  stop_reason: 'end_turn',
});
const toolUse = (name: string, input: object) => ({
  content: [{ type: 'tool_use', id: 'tu_1', name, input }],
  stop_reason: 'tool_use',
});

describe('Assistant (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const stamp = Date.now();
  const emails = [
    `e2e-agent-a-${stamp}@example.com`,
    `e2e-agent-b-${stamp}@example.com`,
  ];
  let tokenA: string;
  let tokenB: string;

  // The scripted model: each create() call shifts the next canned response.
  const script: object[] = [];
  const create = jest.fn(() => Promise.resolve(script.shift()));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LLM_CLIENT)
      .useValue({ messages: { create } })
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    prisma = moduleRef.get(PrismaService);
    await app.init();

    const reg = async (email: string, name: string) =>
      (
        await request(app.getHttpServer())
          .post('/api/auth/register')
          .send({ email, password: 'demo1234', businessName: name })
      ).body.token as string;
    tokenA = await reg(emails[0], 'Agent e2e A');
    tokenB = await reg(emails[1], 'Agent e2e B');
  });

  afterAll(async () => {
    const merchants = await prisma.merchant.findMany({
      where: { email: { in: emails } },
    });
    for (const m of merchants) {
      await prisma.paymentLink.deleteMany({ where: { merchantId: m.id } });
      await prisma.merchant.delete({ where: { id: m.id } });
    }
    await app.close();
    restoreEnv();
  });

  const chat = (token: string, body: object) =>
    request(app.getHttpServer())
      .post('/api/agent/chat')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  const post = (token: string, path: string) =>
    request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${token}`);
  const linksOf = async (email: string) =>
    prisma.paymentLink.findMany({ where: { merchant: { email } } });

  let conversationId: string;
  let proposalId: string;
  let linkCode: string;

  it('requires a login', async () => {
    await request(app.getHttpServer())
      .post('/api/agent/chat')
      .send({ message: 'hi' })
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/agent/proposals/x/confirm')
      .expect(401);
  });

  it('validates the message', async () => {
    await chat(tokenA, { message: '' }).expect(400);
    await chat(tokenA, { message: 'x'.repeat(2001) }).expect(400);
  });

  it('chat → proposal: nothing is created yet', async () => {
    script.push(
      toolUse('create_payment_link', { title: 'Logo design', amountTRY: 200 }),
      text('Ready to confirm.'),
    );
    const res = await chat(tokenA, {
      message: 'Create a 200 TRY link for Logo design',
    }).expect(200);
    conversationId = res.body.conversationId;
    proposalId = res.body.proposal.id;
    expect(res.body.reply).toBe('Ready to confirm.');
    expect(res.body.toolCalls).toEqual([
      expect.objectContaining({
        name: 'create_payment_link',
        summary: expect.stringContaining('200.00 TRY'),
      }),
    ]);
    expect(res.body.proposal).toMatchObject({
      title: 'Logo design',
      amountTRY: '200.00',
      estimatedUSDC: expect.any(String),
    });
    expect(JSON.stringify(res.body)).not.toContain('e2e-not-a-real-key');
    expect(await linksOf(emails[0])).toHaveLength(0);
  });

  it('another merchant cannot confirm or cancel it', async () => {
    await post(tokenB, `/api/agent/proposals/${proposalId}/confirm`).expect(
      404,
    );
    await post(tokenB, `/api/agent/proposals/${proposalId}/cancel`).expect(404);
    expect(await linksOf(emails[0])).toHaveLength(0);
    expect(await linksOf(emails[1])).toHaveLength(0);
  });

  it('confirm → the link exists, once', async () => {
    const res = await post(
      tokenA,
      `/api/agent/proposals/${proposalId}/confirm`,
    ).expect(201);
    linkCode = res.body.code;
    expect(res.body).toMatchObject({
      title: 'Logo design',
      amountTRY: '200.00',
      status: 'open',
    });
    expect(res.body.payUrl).toContain(linkCode);
    const links = await linksOf(emails[0]);
    expect(links).toHaveLength(1);
    expect(links[0].code).toBe(linkCode);
    await post(tokenA, `/api/agent/proposals/${proposalId}/confirm`).expect(
      409,
    );
    await post(tokenA, `/api/agent/proposals/${proposalId}/cancel`).expect(409);
    expect(await linksOf(emails[0])).toHaveLength(1);
  });

  it('the next turn carries the confirmation as a separate <system_event> block', async () => {
    script.push(text(`Your link is ${linkCode}.`));
    await chat(tokenA, { conversationId, message: 'thanks' }).expect(200);
    const params = create.mock.calls.at(-1)![0] as {
      messages: { role: string; content: Block[] }[];
    };
    const last = params.messages.filter((m) => m.role === 'user').at(-1)!;
    expect(last.content).toHaveLength(2);
    expect(last.content[0].text).toMatch(
      new RegExp(`^<system_event>.*${linkCode}.*</system_event>$`),
    );
    expect(last.content[1].text).toBe('thanks');
  });

  it("merchant B asking about A's link code gets 'not found' from the tool", async () => {
    script.push(
      toolUse('get_payment_link', { code: linkCode }),
      text('I could not find that link.'),
    );
    const res = await chat(tokenB, {
      message: `status of ${linkCode}?`,
    }).expect(200);
    expect(res.body.toolCalls[0]).toMatchObject({
      name: 'get_payment_link',
      summary: 'Link not found for this merchant.',
    });
    expect(JSON.stringify(res.body)).not.toContain('Logo design');
  });

  it('merchant A can read their own link by code', async () => {
    script.push(
      toolUse('get_payment_link', { code: linkCode.toLowerCase() }),
      text('It is open.'),
    );
    const res = await chat(tokenA, { message: 'status?' }).expect(200);
    expect(res.body.toolCalls[0].summary).toBe(`${linkCode}: open, 200.00 TRY`);
  });

  it('over the limit: no proposal, no link', async () => {
    script.push(
      toolUse('create_payment_link', { title: 'Big', amountTRY: 5000 }),
      text('Too large.'),
    );
    const res = await chat(tokenA, {
      message: 'Create a 5000 TRY link',
    }).expect(200);
    expect(res.body.proposal).toBeUndefined();
    expect(res.body.toolCalls[0].summary).toContain('limit');
    expect(await linksOf(emails[0])).toHaveLength(1);
  });

  it('cancel path creates nothing', async () => {
    script.push(
      toolUse('create_payment_link', { title: 'Second', amountTRY: 50 }),
      text('Ready.'),
    );
    const res = await chat(tokenA, { message: 'Create a 50 TRY link' }).expect(
      200,
    );
    const cancelled = await post(
      tokenA,
      `/api/agent/proposals/${res.body.proposal.id}/cancel`,
    ).expect(200);
    expect(cancelled.body).toEqual({
      id: res.body.proposal.id,
      status: 'cancelled',
    });
    expect(await linksOf(emails[0])).toHaveLength(1);
  });

  it('daily cap: 429 with a friendly message', async () => {
    let status = 0;
    let message = '';
    for (let i = 0; i < 15 && status !== 429; i++) {
      script.push(text('ok'));
      const res = await chat(tokenB, { message: `ping ${i}` });
      status = res.status;
      message = String(res.body.message);
    }
    expect(status).toBe(429);
    expect(message).toContain("today's limit of 12");
  });
});
