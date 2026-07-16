// BHB CompanyProfile "Statements" tab parser test. Golden-tested against the REAL
// webapi.bahrainbourse.com/api/data/GetCompanyFinancialStatements JSON for ALBH
// (ingestion/fixtures/bhb/financials-live.json, captured live 2026-07-16). Zero network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  parseCompanyFinancialStatements,
  parseStatementPeriod,
  companyFinancialStatementsUrl,
  statementFileId,
  BHB_FINANCIALS_PARSER_VERSION,
} from './financials.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, '../../../fixtures/bhb/financials-live.json');

test('BHB financials: parses the live GetCompanyFinancialStatements fixture into PDF targets', () => {
  const body = readFileSync(fixturePath);
  const docs = parseCompanyFinancialStatements(body);

  // 10 period groups; the 2025 group carries TWO files (View + Annual Report) ⇒ 11 downloadable PDFs.
  assert.equal(docs.length, 11);

  const first = docs[0]!;
  assert.equal(first.periodTitle, 'Financial Statements for the period ended 31 December 2025');
  assert.equal(first.label, 'View');
  assert.ok(first.url.startsWith('https://bahrainbourse.com/Documents/'), 'absolute PDF url');
  assert.ok(!first.url.includes(' '), 'spaces encoded');
  assert.equal(first.fiscalPeriod, 'FY2025');
  assert.equal(first.periodKind, 'annual');
  assert.equal(first.periodEnd, '2025-12-31');
  assert.equal(first.sourceRef, `BHB-FS-${first.fileId}`);

  // The second file of the 2025 group: same period, different label + fileId.
  const second = docs[1]!;
  assert.equal(second.periodTitle, first.periodTitle);
  assert.equal(second.label, 'Annual Report');
  assert.notEqual(second.fileId, first.fileId);

  // A legacy /resources/files/*.pdf link (2020) resolves absolute + keeps its %20 encoding.
  const y2020 = docs.find((d) => d.fiscalPeriod === 'FY2020')!;
  assert.ok(y2020.url.startsWith('https://bahrainbourse.com/resources/files/'), '2020 legacy path absolute');
  assert.ok(y2020.url.includes('%20'), '2020 spaces stay encoded');

  // Every target is a unique PDF with a stable BHB-FS- source_ref.
  assert.equal(new Set(docs.map((d) => d.fileId)).size, docs.length);
  for (const d of docs) {
    assert.ok(/\.pdf/i.test(d.url), 'target is a pdf');
    assert.ok(d.sourceRef.startsWith('BHB-FS-'), 'namespaced source_ref');
    assert.ok(d.fiscalPeriod === null || /^(FY\d{4}|\d{4}-Q[1-4])$/.test(d.fiscalPeriod), 'period shape');
  }

  // All ten years 2016..2025 are present.
  const years = new Set(docs.map((d) => d.periodEnd?.slice(0, 4)));
  for (let y = 2016; y <= 2025; y++) assert.ok(years.has(String(y)), `year ${y} present`);
});

test('BHB financials: parseStatementPeriod maps quarter-end month to fiscal quarter', () => {
  assert.deepEqual(parseStatementPeriod('Interim statements for the period ended 31 March 2025'), {
    fiscalPeriod: '2025-Q1',
    periodKind: 'quarter',
    periodEnd: '2025-03-31',
  });
  assert.deepEqual(parseStatementPeriod('Condensed statements for the period ended 30 June 2024'), {
    fiscalPeriod: '2024-Q2',
    periodKind: 'quarter',
    periodEnd: '2024-06-30',
  });
  assert.deepEqual(parseStatementPeriod('for the period ended 30 September 2023'), {
    fiscalPeriod: '2023-Q3',
    periodKind: 'quarter',
    periodEnd: '2023-09-30',
  });
  assert.deepEqual(parseStatementPeriod('year ended 31 December 2022'), {
    fiscalPeriod: 'FY2022',
    periodKind: 'annual',
    periodEnd: '2022-12-31',
  });
  assert.deepEqual(parseStatementPeriod('no date here'), {
    fiscalPeriod: null,
    periodKind: null,
    periodEnd: null,
  });
});

test('BHB financials: builds the CompanyProfile Statements URL with double-encoded space', () => {
  assert.equal(
    companyFinancialStatementsUrl('ALBH'),
    'https://webapi.bahrainbourse.com/api/data/GetCompanyFinancialStatements' +
      '?listUrl=%2Fen%2Fcompany%2FALBH%2FLists%2FFinancial%2520Statements%2F&websiteID=bhb',
  );
});

test('BHB financials: fileId is stable + case/encoding-insensitive for the same path', () => {
  assert.equal(
    statementFileId('/resources/files/2020%20financial%20statements%20-%20english.pdf'),
    statementFileId('/resources/files/2020 financial statements - english.pdf'),
  );
});

test('BHB financials: non-1 status / garbage bytes yield zero targets, not a throw', () => {
  assert.equal(parseCompanyFinancialStatements(Buffer.from('{"status":2,"data":null}', 'utf8')).length, 0);
  assert.equal(parseCompanyFinancialStatements(Buffer.from('<html>401</html>', 'utf8')).length, 0);
  assert.equal(parseCompanyFinancialStatements('not json').length, 0);
  assert.equal(BHB_FINANCIALS_PARSER_VERSION, 1);
});
