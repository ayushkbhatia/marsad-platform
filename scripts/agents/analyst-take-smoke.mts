#!/usr/bin/env tsx
/**
 * Phase D smoke agent — the FIRST caller of chatComplete() (src/lib/llm/gateway.ts had zero
 * callers since P0). Proves the full agent-context chain end-to-end:
 *
 *   lake.fn_writer_context(security) → prompt → chatComplete('analyst_take') → a grounded
 *   one-page take → ops.llm_runs accounting row (no anonymous LLM spend).
 *
 * Output goes to STDOUT + /tmp/analyst-take-<ticker>.md for owner review. It is NOT written
 * to content_items — publishing is P3's job, behind the rules engine + approval queue.
 *
 * Run on the VPS (keys live in /etc/marsad/worker.env; the gateway is dependency-free TS,
 * executed via the ingestion package's tsx):
 *   set -a; source /etc/marsad/worker.env; set +a
 *   /opt/marsad/ingestion/node_modules/.bin/tsx /opt/marsad/scripts/agents/analyst-take-smoke.mts QE QNBK
 */
import { writeFileSync } from 'node:fs';
import { chatComplete } from '../../src/lib/llm/gateway';
// @ts-expect-error — the worker package's postgres.js, resolved at runtime on the VPS
const postgres = (await import('/opt/marsad/worker/node_modules/postgres/src/index.js').then((m) => m.default ?? m));

const [venue = 'QE', ticker = 'QNBK'] = process.argv.slice(2);
const { SUPABASE_DB_URL } = process.env;
if (!SUPABASE_DB_URL) { console.error('missing SUPABASE_DB_URL'); process.exit(1); }

const sql = postgres(SUPABASE_DB_URL, { max: 2, prepare: false });
const sec = await sql`select id, name_en from public.securities where venue_code=${venue} and ticker=${ticker} limit 1`;
if (!sec[0]) { console.error(`no security ${venue}:${ticker}`); await sql.end(); process.exit(1); }
const pack = (await sql`select lake.fn_writer_context(${sec[0].id}) as pack`)[0].pack;
// The gateway mandates an accountable agent principal — use the analyst-take-adjacent WRITER seat.
const agent = await sql`select principal_id from iam.agent_accounts where agent_class in ('writer','WRITER') order by principal_id limit 1`;
const agentId = agent[0]?.principal_id ?? (await sql`select principal_id from iam.agent_accounts limit 1`)[0].principal_id;

const SYSTEM = [
  'You are a Marsad equity research analyst covering GCC exchanges. You are given a structured',
  'CONTEXT PACK (JSON) for one listed company: identity, delayed price data, computed ratios,',
  'Marsad Score, financial statements (each with row_id / source_object_id), and recent filings',
  '(each with filing_id).',
  'Write a tight one-page analyst take in markdown:',
  '  1. **What just happened** — the latest reported quarter vs its comparative.',
  '  2. **The numbers that matter** — profitability, balance-sheet position, dividends/equity moves.',
  '  3. **Valuation & positioning** — ratios, score, price momentum.',
  '  4. **Watch items** — what the next filing should answer.',
  'HARD RULES: every number MUST come from the pack — never compute beyond simple ratios of pack',
  'values, never estimate, never fill gaps from memory. Cite each fact inline as [row_id:N],',
  '[obj:UUID-prefix-8] or [filing:N]. A section with no pack data says "no data in pack". State',
  'the price delay. British English, no hype.',
].join('\n');

console.error(`pack for ${venue}:${ticker} — ${JSON.stringify(pack).length} chars; agent ${agentId}`);
const t0 = Date.now();
const res = await chatComplete(
  'analyst_take',
  [{ role: 'user', content: `CONTEXT PACK:\n\n${JSON.stringify(pack)}` }],
  { system: SYSTEM, maxTokens: 2200, temperature: 0.3, runContext: { agentId, purpose: 'phase-d-smoke-analyst-take' } },
);
const out = `# Analyst take — ${sec[0].name_en} (${venue}:${ticker})\n\n_${res.provider}:${res.model} · $${res.costUsd.toFixed(4)} · ${res.latencyMs}ms · smoke output, NOT published_\n\n${res.text}\n`;
writeFileSync(`/tmp/analyst-take-${ticker}.md`, out);
console.log(out);
console.error(`DONE ${(Date.now() - t0) / 1000 | 0}s | ${res.provider}:${res.model} | tokens in/out ${res.usage?.inputTokens ?? '?'}/${res.usage?.outputTokens ?? '?'} | $${res.costUsd.toFixed(4)}`);
await sql.end();
