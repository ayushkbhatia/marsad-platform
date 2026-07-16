import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFilingsDetailPoll } from '../filings-detail-poll.js';
import { makeFakeSql, makeCtx, makeFakeRuntime, makeSource, activeAgentRows } from './fakes.js';
import type { FilingPdfResult } from '../ingestion-runtime.js';

function pendingRow(externalId: string, over: Record<string, unknown> = {}) {
  return {
    source_id: '5',
    external_id: externalId,
    detail_url: `https://x.test/${externalId}`,
    pdf_url: `https://x.test/${externalId}.pdf`,
    title: `Title ${externalId}`,
    filed_at: '2026-07-16T09:00:00Z',
    ...over,
  };
}

test('filings_detail_poll: stored PDF ⇒ filings linkage + extract queue + seen_items fetched', async () => {
  const fakeSql = makeFakeSql();
  fakeSql.on('iam.agent_accounts', activeAgentRows());
  fakeSql.on('si.detail_state', [pendingRow('A-1'), pendingRow('A-2', { pdf_url: null })]);
  fakeSql.on('into public.filings', [{ id: '55' }]);

  const results: FilingPdfResult[] = [
    { externalId: 'A-1', ok: true, storageKey: 'dfm/_unmapped/sha1.pdf', sha256: 'sha1', contentType: 'application/pdf', bytes: 120 },
    { externalId: 'A-2', ok: false, error: 'no pdf link on detail page' },
  ];

  const runtime = makeFakeRuntime({
    loadSource: async () => makeSource({ id: 33, venue: 'DFM', dataType: 'filing_detail', active: true }),
    agentAccountForSource: () => 'DATA-FILINGS',
    fetchFilingPdfs: async () => results,
  });

  await makeFilingsDetailPoll(runtime)({ handler: 'filings_detail_poll', sourceId: 33 }, makeCtx(fakeSql.sql));

  const q = fakeSql.queries;
  assert.ok(q.some((x) => x.text.includes('into public.filings')), 'upserts the filing linkage row');
  assert.ok(q.some((x) => x.text.includes('ops.filing_extract_queue')), 'enqueues the extraction placeholder');
  assert.ok(q.some((x) => x.text.includes("detail_state = 'fetched'")), 'ok result flips seen_items to fetched');
  // the miss flips to a terminal state via a bound param value
  assert.ok(
    q.some((x) => x.text.includes('update ingest.seen_items') && (x.values as unknown[]).includes('nopdf')),
    'no-pdf result flips seen_items to nopdf (terminal, no poison)',
  );
  assert.ok(!q.some((x) => x.text.includes("interval '2 minutes'")), 'a short chunk does not self-chain');
});

test('filings_detail_poll: no pending ⇒ clean skip, no fetch', async () => {
  const fakeSql = makeFakeSql();
  fakeSql.on('iam.agent_accounts', activeAgentRows());
  fakeSql.on('si.detail_state', []); // nothing pending

  let fetched = false;
  const runtime = makeFakeRuntime({
    loadSource: async () => makeSource({ id: 33, venue: 'DFM', dataType: 'filing_detail', active: true }),
    agentAccountForSource: () => 'DATA-FILINGS',
    fetchFilingPdfs: async () => {
      fetched = true;
      return [];
    },
  });

  await makeFilingsDetailPoll(runtime)({ handler: 'filings_detail_poll', sourceId: 33 }, makeCtx(fakeSql.sql));
  assert.equal(fetched, false, 'no pending ⇒ fetchFilingPdfs never called');
  assert.ok(!fakeSql.queries.some((x) => x.text.includes('into public.filings')), 'no linkage write');
});

test('filings_detail_poll: a full chunk self-chains a cooldown follow-up', async () => {
  const fakeSql = makeFakeSql();
  fakeSql.on('iam.agent_accounts', activeAgentRows());
  // DETAIL_CHUNK_SIZE is 10 — a full chunk means more likely remain.
  const rows = Array.from({ length: 10 }, (_u, i) => pendingRow(`B-${i}`));
  fakeSql.on('si.detail_state', rows);
  fakeSql.on('into public.filings', [{ id: '77' }]);

  const runtime = makeFakeRuntime({
    loadSource: async () => makeSource({ id: 33, venue: 'MSX', dataType: 'filing_detail', active: true }),
    agentAccountForSource: () => 'DATA-FILINGS',
    fetchFilingPdfs: async ({ targets }) =>
      targets.map((t) => ({ externalId: t.externalId, ok: true, storageKey: `msx/_unmapped/${t.externalId}.pdf`, sha256: t.externalId, contentType: 'application/pdf', bytes: 10 })),
  });

  await makeFilingsDetailPoll(runtime)({ handler: 'filings_detail_poll', sourceId: 33 }, makeCtx(fakeSql.sql));
  assert.ok(
    fakeSql.queries.some((x) => x.text.includes('into ingest.job_queue') && x.text.includes("interval '2 minutes'")),
    'full chunk enqueues a 2-min self-chain wake-up',
  );
});

test('filings_detail_poll: inactive source ⇒ skip', async () => {
  const fakeSql = makeFakeSql();
  const runtime = makeFakeRuntime({
    loadSource: async () => makeSource({ id: 33, venue: 'DFM', dataType: 'filing_detail', active: false }),
    agentAccountForSource: () => 'DATA-FILINGS',
  });
  await makeFilingsDetailPoll(runtime)({ handler: 'filings_detail_poll', sourceId: 33 }, makeCtx(fakeSql.sql));
  assert.ok(!fakeSql.queries.some((x) => x.text.includes('si.detail_state')), 'never queries pending when inactive');
});
