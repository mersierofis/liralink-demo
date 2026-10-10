// LiraLink Agent — Week 2 (read tools + create_payment_link with confirmation in code)
// Run from backend/:  node --env-file=.env scripts/agent.mjs
// Importable: import { createAgent } from './agent.mjs'  (used by evals/run-evals.mjs)

import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const system = fs.readFileSync(path.join(HERE, 'system-prompt.md'), 'utf8');
const AUDIT_LOG = path.join(HERE, '..', 'agent-audit.log');
const API = 'http://localhost:3000/api';
const MAX_STEPS = 8;
const MAX_LINK_TRY = Number(process.env.AGENT_MAX_LINK_TRY ?? 340); // ~10 USDC on testnet

// ---------------------------------------------------------------------------
// 1) TOOLS — the agent's hands. create_payment_link only PROPOSES; code confirms.
// ---------------------------------------------------------------------------
export const tools = [
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
  {
    name: 'create_payment_link',
    description:
      'PROPOSE a new TRY payment link. This does not create anything by itself: the merchant is shown the proposal and must confirm in the terminal. Only say a link exists if the result contains a code.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        amountTRY: { type: 'number' },
        description: { type: 'string' },
      },
      required: ['title', 'amountTRY'],
    },
  },
];

// ---------------------------------------------------------------------------
// 2) Our code runs the tools — the model never does
// ---------------------------------------------------------------------------
let token;

async function login() {
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

async function post(path, body) {
  if (!token) await login();
  const r = await fetch(API + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) return { error: `HTTP ${r.status} on ${path}` };
  return r.json();
}

async function getFx() {
  const fx = await fetch(`${API}/fx`).then((r) => r.json());
  return { ...fx, rate: Number(fx.rate) }; // 1 USDC = rate TRY
}

// Append-only JSON-lines audit trail of every tool call and confirm/cancel.
function audit(tool, input, outcome) {
  const line = JSON.stringify({
    time: new Date().toISOString(),
    tool,
    input,
    outcome,
  });
  try {
    fs.appendFileSync(AUDIT_LOG, line + '\n');
  } catch (e) {
    console.error(`[audit] could not write log: ${e.message}`);
  }
}

// The model proposes; this function validates, shows the proposal, asks the
// merchant, and only then talks to POST /links. Confirmation lives in code.
async function proposeLink(input, ctx) {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const amount = Number(input.amountTRY);
  if (!title) return { error: 'title is required.' };
  if (!Number.isFinite(amount) || amount <= 0) {
    return { error: 'amountTRY must be greater than 0.' };
  }
  if (amount > MAX_LINK_TRY) {
    return {
      error: `Over the agent limit: links created here may not exceed ${MAX_LINK_TRY} TRY. Nothing was asked of the merchant. They can create larger links in the LiraLink merchant panel.`,
      code: 'over_limit',
    };
  }

  const fx = await getFx();
  const estUsdc = (amount / fx.rate).toFixed(2);
  console.log('\n  --- Proposed payment link ---');
  console.log(`  Title:       ${title}`);
  console.log(`  Amount:      ${amount.toFixed(2)} TRY`);
  console.log(`  Est. USDC:   ${estUsdc} (rate ${fx.rate}, ${fx.source})`);
  if (input.description) console.log(`  Description: ${input.description}`);

  ctx.confirmAsked = true;
  const answer = (await ctx.confirm('  Create this link? (y/n) '))
    .trim()
    .toLowerCase();
  if (answer !== 'y') {
    audit('create_payment_link', input, 'cancelled');
    return { cancelled: true };
  }
  audit('create_payment_link', input, 'confirmed');

  const body = { title, amountTRY: amount.toFixed(2) };
  if (input.description) body.description = String(input.description);
  const link = await post('/links', body);
  if (link.error) return link;
  console.log(`  [link] created ${link.code}`);
  return {
    code: link.code,
    payUrl: link.payUrl,
    amountTRY: link.amountTRY,
    quotedUSDC: link.quotedUSDC,
  };
}

// ctx = { confirm(question) -> Promise<string>, confirmAsked: boolean }
export async function runTool(name, input, ctx) {
  let out;
  try {
    if (name === 'get_fx_quote') {
      const fx = await getFx();
      out = {
        amountTRY: input.amountTRY,
        rate: fx.rate,
        usdc: Number((input.amountTRY / fx.rate).toFixed(2)),
        source: fx.source,
        fetchedAt: fx.fetchedAt,
      };
    } else if (name === 'get_payment_link') {
      const code = String(input.code).toUpperCase();
      const mine = await get(`/links?limit=100`); // known limit: first 100 links only
      const owns = (mine.items ?? []).some((l) => l.code === code);
      if (!owns) out = { error: 'Link not found for this merchant.' };
      else out = await get(`/pay/${encodeURIComponent(code)}`);
    } else if (name === 'list_payment_links') {
      const q = input.status
        ? `?status=${encodeURIComponent(input.status)}`
        : '';
      out = await get(`/links${q}`);
    } else if (name === 'create_payment_link') {
      out = await proposeLink(input, ctx);
    } else {
      out = { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    out = { error: e.message }; // errors go back to the model, the program keeps running
  }

  // proposeLink logs confirm/cancel itself; every call also gets a final outcome line
  const outcome = out?.cancelled
    ? 'cancelled'
    : name === 'create_payment_link' && out?.code && out.code !== 'over_limit'
      ? `created:${out.code}`
      : out?.code === 'over_limit'
        ? 'over_limit'
        : out?.error
          ? `error: ${out.error}`
          : 'ok';
  if (outcome !== 'cancelled') audit(name, input, outcome);
  return out;
}

// ---------------------------------------------------------------------------
// 3) MEMORY + 4) THE AGENT LOOP — think → act (tool) → observe → repeat
// One agent = one conversation. Evals create a fresh agent per case.
// ---------------------------------------------------------------------------
export function createAgent({
  confirm,
  model = process.env.LLM_MODEL,
  client = new Anthropic(), // reads ANTHROPIC_API_KEY from env
} = {}) {
  const messages = [];
  const trace = []; // [{ tool, input, output, confirmAsked }] for evals/debugging

  async function handle(question) {
    messages.push({ role: 'user', content: question });

    for (let step = 0; step < MAX_STEPS; step++) {
      const res = await client.messages.create({
        model,
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
        return text;
      }

      const results = [];
      for (const block of res.content) {
        if (block.type !== 'tool_use') continue;
        console.log(`  [tool] ${block.name} ${JSON.stringify(block.input)}`);
        const ctx = { confirm, confirmAsked: false };
        const out = await runTool(block.name, block.input, ctx);
        trace.push({
          tool: block.name,
          input: block.input,
          output: out,
          confirmAsked: ctx.confirmAsked,
        });
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(out),
        });
      }
      messages.push({ role: 'user', content: results });
    }

    const text = `(stopped after ${MAX_STEPS} steps)`;
    console.log(`\nagent> ${text}`);
    return text;
  }

  return { handle, messages, trace };
}

// ---------------------------------------------------------------------------
// 5) Simple terminal chat — only when run directly, not when imported
// ---------------------------------------------------------------------------
async function main() {
  if (!process.env.ANTHROPIC_API_KEY || !process.env.LLM_MODEL) {
    console.error('Missing ANTHROPIC_API_KEY or LLM_MODEL in backend/.env');
    process.exit(1);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const agent = createAgent({ confirm: (q) => rl.question(q) });
  console.log('LiraLink agent ready. Ask a question (Ctrl+C to quit).');

  while (true) {
    const q = (await rl.question('\nmerchant> ')).trim();
    if (!q) continue;
    try {
      await agent.handle(q);
    } catch (e) {
      console.error(`\n[error] ${e.message}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
