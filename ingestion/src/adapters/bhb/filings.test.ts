// BHB filings_list parser test. Golden-tested against the REAL
// webapi.bahrainbourse.com/api/data/GetAllAnnouncements JSON
// (ingestion/fixtures/bhb/filings-live.json). Zero network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { bhbFilingsList } from './filings.js';
import type { StoredSnapshot } from '../../core/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, '../../../fixtures/bhb/filings-live.json');

function snap(body: Buffer): StoredSnapshot {
  return {
    snapshotId: 1,
    sourceId: 17,
    venue: 'BHB',
    dataType: 'filings_list',
    contentType: 'application/json',
    externalId: null,
    body,
    fetchedAt: '2026-07-13T18:00:00.000Z',
    meta: { lang: 'en' },
  };
}

test('BHB filings: parses the live GetAllAnnouncements fixture into refs', () => {
  const body = readFileSync(fixturePath);
  const { rows, parserVersion } = bhbFilingsList.parse(snap(body));
  assert.equal(parserVersion, bhbFilingsList.parserVersion);
  assert.ok(rows.length >= 1, 'expected at least one announcement');
  assert.equal(rows.length, 30);

  const first = rows[0]!;
  assert.equal(first.venue, 'BHB');
  // external_id namespaces the per-company itemid under the issuer symbol (e.g. BHB-INOVEST-541).
  assert.equal(first.externalId, 'BHB-INOVEST-541');
  assert.ok(first.title.length > 0, 'title present');
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(first.filedAt), 'filedAt is ISO');
  // linkUrl (with spaces) resolves to an absolute encoded bahrainbourse.com detail url.
  assert.ok(first.detailUrl.startsWith('https://bahrainbourse.com/'), 'detailUrl absolute');
  assert.ok(!first.detailUrl.includes(' '), 'spaces encoded');

  for (const r of rows) {
    assert.ok(r.externalId !== '' && r.title !== '');
  }
  assert.equal(new Set(rows.map((r) => r.externalId)).size, rows.length);
});

test('BHB filings: messageDate "Monday, July 13, 2026 01:09 PM" → UTC (Bahrain UTC+3)', () => {
  const payload = {
    status: 1,
    data: {
      Announcements: [
        {
          symbol: 'INOVEST',
          title: 'Appointment in Management',
          messageDate: 'Monday, July 13, 2026 01:09 PM',
          linkUrl: '/en/News and Events/CompanyAnnouncements/AnnouncementDetail?itemid=541&year=2026',
        },
      ],
    },
  };
  const { rows } = bhbFilingsList.parse(snap(Buffer.from(JSON.stringify(payload), 'utf8')));
  assert.equal(rows.length, 1);
  // 01:09 PM Bahrain (UTC+3) = 10:09 UTC.
  assert.equal(rows[0]!.filedAt, '2026-07-13T10:09:00.000Z');
  assert.equal(rows[0]!.externalId, 'BHB-INOVEST-541');
});

test('BHB filings: 401/HTML (auth failure, wrong bytes) yields zero rows, not a throw', () => {
  const { rows } = bhbFilingsList.parse(snap(Buffer.from('<html>401 Unauthorized</html>', 'utf8')));
  assert.equal(rows.length, 0);
});
