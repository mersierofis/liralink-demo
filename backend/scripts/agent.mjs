// LiraLink Agent — Week 1 (read-only)
// Run from backend/:  node --env-file=.env scripts/agent.mjs

import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import readline from 'node:readline/promises';

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
const system = fs.readFileSync('scripts/system-prompt.md', 'utf8');
const API = 'http://localhost:3000/api';
const MAX_STEPS = 8;

// ---------------------------------------------------------------------------
// 1) TOOLS — the agent's hands (read-only this week)
// ---------------------------------------------------------------------------
const tools = [
  {
    name: 'get_fx_quote',
    description:
      "Convert an amount in Turkish lira (TRY) to USDC at LiraLink's current rate. Only TRY is supported.",
    input_schema: {
      type: 'object',
      properties: { amountTRY: { type: 'number' } },
      required: ['amountTRY'],
    },
  },
  {
    name: 'get_payment_link',
    description:
      'Get one payment link by its code (e.g. S7473UAW): status (open, underpaid, paid, expired, cancelled), amounts, and which rail detected the payment.',
    input_schema: {
      type: 'object',
      properties: { code: { type: 'string' } },
      required: ['code'],
    },
  },
  {
    name: 'list_payment_links',
    description:
      "List the merchant's payment links, optionally filtered by status. Use for questions like 'who hasn't paid'.",
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['open', 'underpaid', 'paid', 'expired', 'cancelled'],
        },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// 2) Our code runs the tools — the model never does
// ---------------------------------------------------------------------------
let token;

async function login() {
  // ① Check the login path against Claude Code's endpoint list
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'demo@liralink.app',
      password: process.env.SEED_DEMO_PASSWORD,
    }),
  });
  if (!r.ok) throw new Error(`Login failed: HTTP ${r.status}`);
  const body = await r.json();
  // ② Check the token field name (accessToken / token / access_token)
  token = body.accessToken ?? body.token ?? body.access_token;
  if (!token) throw new Error('Login response had no token field');
}

async function get(path) {
  if (!token) await login();
  const r = await fetch(API + path, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return { error: `HTTP ${r.status} on ${path}` };
  return r.json();
}

async function runTool(name, input) {
  try {
    if (name === 'get_fx_quote') {
      const fx = await fetch(`${API}/fx`).then((r) => r.json());
      const rate = Number(fx.rate); // 1 USDC = rate TRY
      return {
        amountTRY: input.amountTRY,
        rate,
        usdc: Number((input.amountTRY / rate).toFixed(2)),
        source: fx.source,
        fetchedAt: fx.fetchedAt,
      };
    }
    if (name === 'get_payment_link') {
      const code = String(input.code).toUpperCase();
      const mine = await get(`/links?limit=100`);
      const owns = (mine.items ?? []).some((l) => l.code === code);
      if (!owns) return { error: 'Link not found for this merchant.' };
      return await get(`/pay/${encodeURIComponent(code)}`);
    }
    if (name === 'list_payment_links') {
      // ③ Check the list path and the status filter parameter
      const q = input.status
        ? `?status=${encodeURIComponent(input.status)}`
        : '';
      return await get(`/links${q}`);
    }
    return { error: `Unknown tool: ${name}` };
  } catch (e) {
    return { error: e.message }; // errors go back to the model, the program keeps running
  }
}

// ---------------------------------------------------------------------------
// 3) MEMORY — the conversation lives in this array; the API itself is stateless
// ---------------------------------------------------------------------------
const messages = [];

// ---------------------------------------------------------------------------
// 4) THE AGENT LOOP — think → act (tool) → observe → repeat until done
// ---------------------------------------------------------------------------
async function handle(question) {
  messages.push({ role: 'user', content: question });

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await client.messages.create({
      model: process.env.LLM_MODEL,
      max_tokens: 1024,
      system,
      tools,
      messages,
    });
    messages.push({ role: 'assistant', content: res.content });

    if (res.stop_reason !== 'tool_use') {
      const text = res.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      console.log(`\nagent> ${text}`);
      return;
    }

    const results = [];
    for (const block of res.content) {
      if (block.type !== 'tool_use') continue;
      console.log(`  [tool] ${block.name} ${JSON.stringify(block.input)}`);
      const out = await runTool(block.name, block.input);
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(out),
      });
    }
    messages.push({ role: 'user', content: results });
  }

  console.log(`\nagent> (stopped after ${MAX_STEPS} steps)`);
}

// ---------------------------------------------------------------------------
// 5) Simple terminal chat
// ---------------------------------------------------------------------------
if (!process.env.ANTHROPIC_API_KEY || !process.env.LLM_MODEL) {
  console.error('Missing ANTHROPIC_API_KEY or LLM_MODEL in backend/.env');
  process.exit(1);
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});
console.log('LiraLink agent ready. Ask a question (Ctrl+C to quit).');

while (true) {
  const q = (await rl.question('\nmerchant> ')).trim();
  if (!q) continue;
  try {
    await handle(q);
  } catch (e) {
    console.error(`\n[error] ${e.message}`);
  }
}
