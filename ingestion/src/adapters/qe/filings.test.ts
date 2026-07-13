// QE filings_list parser test. QE's disclosure-list feed URL is NOT yet pinned (needs one more VPS
// headless capture) so there is NO golden fixture — the parser is verified against BOTH shapes it is
// written to survive (Liferay portlet JSON + server-rendered HTML anchors) via inline samples. Zero
// network. Replace with a golden once the q-disclosure resource URL is captured.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { qeFilingsList } from './filings.js';
import type { StoredSnapshot } from '../../core/types.js';

function snap(body: Buffer, meta: Record<string, unknown> = { lang: 'en' }): StoredSnapshot {
  return {
    snapshotId: 1,
    sourceId: 11,
    venue: 'QE',
    dataType: 'filings_list',
    contentType: 'application/json',
    externalId: null,
    body,
    fetchedAt: '2026-07-13T18:00:00.000Z',
    meta,
  };
}

test('QE filings: parses a Liferay-portlet JSON disclosure list (common keys)', () => {
  const payload = {
    data: {
      disclosures: [
        { id: 4471, title: 'QNB Q2 2026 interim financial statements', publishDate: '2026-07-13T10:00:00Z', detailUrl: '/q-disclosure/4471', pdfUrl: '/files/4471.pdf', symbol: 'QNBK' },
        { id: 4472, title: 'Board of Directors meeting outcome', publishDate: '2026-07-13T11:30:00Z' },
        { title: 'orphan no id' },
      ],
    },
  };
  const { rows, parserVersion } = qeFilingsList.parse(snap(Buffer.from(JSON.stringify(payload), 'utf8')));
  assert.equal(parserVersion, qeFilingsList.parserVersion);
  assert.equal(rows.length, 2);

  const first = rows.find((r) => r.externalId === 'QE-4471')!;
  assert.equal(first.venue, 'QE');
  assert.equal(first.title, 'QNB Q2 2026 interim financial statements');
  assert.equal(first.filedAt, '2026-07-13T10:00:00.000Z');
  assert.equal(first.detailUrl, 'https://www.qe.com.qa/q-disclosure/4471');
  assert.equal(first.pdfUrl, 'https://www.qe.com.qa/files/4471.pdf');
});

test('QE filings: config-driven field map overrides key resolution', () => {
  const payload = { payload: { items: [{ discId: 'Q-9', headline: 'Rating action', ts: '2026-07-13T09:00:00Z' }] } };
  const fm = { rowsPath: 'payload.items', externalId: 'discId', title: 'headline', filedAt: 'ts' };
  const { rows } = qeFilingsList.parse(snap(Buffer.from(JSON.stringify(payload), 'utf8'), { lang: 'en', filingFieldMap: fm }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.externalId, 'QE-Q-9');
  assert.equal(rows[0]!.title, 'Rating action');
});

test('QE filings: falls back to HTML anchor extraction when the feed is server-rendered', () => {
  const html =
    '<ul><li><a href="/q-disclosure/detail?id=8801">Ooredoo dividend distribution</a></li>' +
    '<li><a href="/q-disclosure/detail?id=8802">Industries Qatar results</a></li></ul>';
  const { rows } = qeFilingsList.parse(snap(Buffer.from(html, 'utf8'), { lang: 'en' }));
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.externalId, 'QE-8801');
  assert.equal(rows[0]!.detailUrl, 'https://www.qe.com.qa/q-disclosure/detail?id=8801');
});

test('QE filings: an unrecognized/empty layout yields zero rows (PARSE_DRIFT signal)', () => {
  const { rows } = qeFilingsList.parse(snap(Buffer.from('<html><body>no announcements</body></html>', 'utf8')));
  assert.equal(rows.length, 0);
});

test('QE filings: task exposes the frozen dataType', () => {
  assert.equal(qeFilingsList.dataType, 'filings_list');
});
