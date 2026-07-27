#!/usr/bin/env node
/**
 * Verify every HuggingFace model pinned in roles.ts against the live router.
 *
 * WHY THIS EXISTS. `supports_structured_output` is a property of the (model, provider) PAIR, not of
 * the model — and the router's default routing policy is `:fastest`. On openai/gpt-oss-20b the
 * fastest upstream (groq, 693 tok/s) reports it FALSE. So an unpinned id, or a pin to the wrong
 * upstream, routes strict-JSON work to a provider that cannot honour `response_format` — and the
 * failure surfaces as a model regression, not as a routing change.
 *
 * This caught a real defect on the day PE.8 landed: the `writer` role was pinned to
 * Qwen3-235B@deepinfra, which reports FALSE (and is 2.7x slower than novita at the same price).
 *
 * Uses the PUBLIC model endpoint — no token required, safe to run in CI.
 *
 *   node scripts/llm/verify-hf-pins.mjs          # report
 *   node scripts/llm/verify-hf-pins.mjs --check  # exit 1 if any pin cannot do structured output
 */
import { readFileSync } from 'node:fs';

const CHECK = process.argv.includes('--check');
const src = readFileSync(new URL('../../ingestion/src/llm/roles.ts', import.meta.url), 'utf8');

// Pull the huggingface block's "role: <model:provider>" pairs straight from the source of truth.
const block = src.slice(src.indexOf('huggingface: {'), src.indexOf('};', src.indexOf('huggingface: {')));
const pins = [...block.matchAll(/^\s*(\w+):\s*"([^"]+)"/gm)]
  .map(([, role, spec]) => ({ role, spec }))
  .filter(({ spec }) => spec.includes(':'));

let bad = 0;
for (const { role, spec } of pins) {
  const at = spec.lastIndexOf(':');
  const model = spec.slice(0, at);
  const pinned = spec.slice(at + 1);
  let row = null;
  try {
    const res = await fetch(`https://router.huggingface.co/v1/models/${model}`, { signal: AbortSignal.timeout(15000) });
    const j = await res.json();
    row = (j?.data?.providers ?? []).find((p) => p.provider === pinned && p.status === 'live');
  } catch (e) {
    console.log(`?  ${role.padEnd(13)} ${spec} — router unreachable (${String(e).slice(0, 40)})`);
    continue;
  }
  if (!row) { console.log(`✗  ${role.padEnd(13)} ${spec} — provider "${pinned}" is not live for this model`); bad++; continue; }
  const ok = row.supports_structured_output === true;
  if (!ok) bad++;
  console.log(
    `${ok ? '✓' : '✗'}  ${role.padEnd(13)} ${spec.padEnd(46)} ` +
    `JSON ${ok ? '✓' : '✗'}  $${row.pricing.input}/$${row.pricing.output}  ${Math.round(row.throughput || 0)} tok/s`,
  );
}

if (bad) {
  console.error(`\n${bad} pin(s) cannot honour response_format — strict-JSON roles would fail at run time.`);
  if (CHECK) process.exit(1);
} else {
  console.log(`\n✓ all ${pins.length} pins support structured output`);
}
