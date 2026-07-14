import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgaamIndex, newRefs, argaamIndexUrl } from './discover.js';

// Real Argaam English link shapes captured live 2026-07-14 from the financial-pdf index.
const HTML = `
<table>
 <tr><td>SABIC</td>
   <td><a href="https://argaamplus.s3.amazonaws.com/6460fe8e-aa0b-4fcb-9dae-57fd13701368.pdf">Ar</a>
       <a href="https://www.argaam.com/en/Tadawul/TASI/sabic/financial-report/2026/Q1/91ffd49e-e704-4f03-a1e4-e2862600626e.pdf">En</a></td></tr>
 <tr><td>MAADEN</td>
   <td><a href="https://www.argaam.com/en/Tadawul/TASI/maaden/financial-report/2025/Annual/e4a4cad2-6200-4628-802d-18907fd3c71f.pdf">En</a></td></tr>
 <tr><td>NUP</td>
   <td><a href="/en/Tadawul/NOMU/nup/financial-report/2025/Q3/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.pdf">En</a></td></tr>
</table>`;

test('parseArgaamIndex: recovers ticker/year/period/uuid + open S3 URL from the EN link', () => {
  const refs = parseArgaamIndex(HTML, 'https://www.argaam.com/en/company/financial-pdf/3/2025');
  const sabic = refs.find((r) => r.ticker === 'sabic')!;
  assert.equal(sabic.venue, 'TDWL');
  assert.equal(sabic.year, 2026);
  assert.equal(sabic.period, 'Q1');
  assert.equal(sabic.periodKind, 'quarter');
  assert.equal(sabic.lang, 'en');
  assert.equal(sabic.uuid, '91ffd49e-e704-4f03-a1e4-e2862600626e');
  assert.equal(sabic.pdfUrl, 'https://argaamplus.s3.amazonaws.com/91ffd49e-e704-4f03-a1e4-e2862600626e.pdf');
  assert.equal(sabic.sourceUrl, 'https://www.argaam.com/en/company/financial-pdf/3/2025');
});

test('parseArgaamIndex: Annual → periodKind annual; NOMU → TDWL; relative links parsed', () => {
  const refs = parseArgaamIndex(HTML);
  const maaden = refs.find((r) => r.ticker === 'maaden')!;
  assert.equal(maaden.period, 'Annual');
  assert.equal(maaden.periodKind, 'annual');
  const nup = refs.find((r) => r.ticker === 'nup')!;
  assert.equal(nup.venue, 'TDWL'); // NOMU maps to TDWL
  assert.equal(nup.periodKind, 'quarter');
});

test('parseArgaamIndex: dedupes on uuid (same statement linked twice)', () => {
  const dup = HTML + HTML;
  const refs = parseArgaamIndex(dup);
  const uuids = refs.map((r) => r.uuid);
  assert.equal(new Set(uuids).size, uuids.length);
  assert.equal(refs.length, 3);
});

test('newRefs: incremental filter drops already-ingested uuids (the coverage invariant)', () => {
  const refs = parseArgaamIndex(HTML);
  const known = new Set(['91ffd49e-e704-4f03-a1e4-e2862600626e']); // SABIC already ingested
  const fresh = newRefs(refs, known);
  assert.equal(fresh.length, 2);
  assert.ok(!fresh.some((r) => r.ticker === 'sabic'));
});

test('argaamIndexUrl builds the headless-render target', () => {
  assert.equal(argaamIndexUrl(3, 2025), 'https://www.argaam.com/en/company/financial-pdf/3/2025');
});
