-- Marsad dev/staging fixture — frozen at SUN 12 JUL 2026 09:41 GST
-- (2026-07-12 05:41 UTC). Applied by `supabase db reset` only; never runs on
-- prod (02 §22 step 16). Reference data (venues, sectors, indices, plans,
-- templates, rules, agents) is seeded by the migrations themselves; this file
-- adds the design-fixture working set: sample securities incl. 2222 Saudi
-- Aramco, delayed quotes, index levels, filings, the stc DPS 0.50→0.55 lake
-- revision chain, the MSX incident, and a published wire with citations.

begin;

-- Principals are seeded in 0002; re-assert idempotently so this file also
-- works against a database that predates that migration's seed.
insert into iam.principals (kind, handle, display_name) values
  ('system', 'SYSTEM', 'SYSTEM')
on conflict (handle) do nothing;
insert into iam.principals (kind, handle, display_name)
select 'agent', h, h from unnest(array[
  'DATA-TDWL','DATA-DFM','DATA-ADX','DATA-QE','DATA-MSX','DATA-BHB','DATA-FILINGS',
  'WRITER-1','WRITER-2','WRITER-3','EDITOR-1','EDITOR-2']) as h
on conflict (handle) do nothing;

-- ---------------------------------------------------------------------------
-- Securities (one per venue plus the fixture names).
insert into public.securities (venue_code, ticker, isin, name_en, sector, currency, free_float_pct, shares_outstanding, listing_date, score_eligible_from) values
  ('TDWL', '2222', 'SA14TG012N13', 'Saudi Arabian Oil Co. (Saudi Aramco)', 'energy',  'SAR',  2.500, 242000000000, '2019-12-11', '2020-04-20'),
  ('TDWL', '7010', 'SA0007879543', 'Saudi Telecom Co. (stc)',              'telecom', 'SAR', 25.000,   4980000000, '2003-01-25', '2003-06-01'),
  ('TDWL', '1120', 'SA0007879113', 'Al Rajhi Bank',                        'banks',   'SAR', 74.000,   4000000000, '1988-01-01', '1988-06-01'),
  ('DFM',  'EMAAR','AEE000301011', 'Emaar Properties PJSC',                'real_estate','AED', 60.000, 8779000000, '2000-01-01', '2000-06-01'),
  ('ADX',  'FAB',  'AEF000201010', 'First Abu Dhabi Bank PJSC',            'banks',   'AED', 40.000,  11047000000, '2017-04-02', '2017-08-15'),
  ('QE',   'QNBK', 'QA0006929895', 'Qatar National Bank (QPSC)',           'banks',   'QAR', 48.000,   9236000000, '1997-05-01', '1997-10-01'),
  ('MSX',  'OTEL', 'OM0000002549', 'Omantel',                              'telecom', 'OMR', 24.000,    750000000, '2005-07-01', '2005-12-01'),
  ('BHB',  'NBB',  'BH0004250288', 'National Bank of Bahrain',             'banks',   'BHD', 44.000,   2028000000, '1989-01-01', '1989-06-01');

-- Delayed quotes as of 09:26 GST (15-min delayed prints, scraped 09:26).
insert into public.quotes_latest (security_id, last, change, change_pct, open, high, low, volume, vwap, week52_high, week52_low, as_of, captured_at, tick_dir)
select s.id, q.last, q.chg, q.chg_pct, q.open, q.high, q.low, q.vol, q.vwap, q.hi52, q.lo52,
       timestamptz '2026-07-12 05:11:00+00', timestamptz '2026-07-12 05:26:00+00', q.dir
from (values
  ('TDWL','2222', 27.15,  0.20,  0.7424, 26.95, 27.20, 26.90,  8214550::numeric, 27.05, 32.10, 24.80,  1),
  ('TDWL','7010', 42.30,  0.85,  2.0507, 41.45, 42.40, 41.40,  3120400::numeric, 42.05, 44.90, 36.20,  1),
  ('TDWL','1120', 88.10, -0.60, -0.6764, 88.70, 89.00, 87.90,  2455100::numeric, 88.35, 96.40, 78.10, -1),
  ('QE',  'QNBK', 17.42,  0.11,  0.6355, 17.31, 17.45, 17.28,  1804300::numeric, 17.38, 18.90, 15.05,  1),
  ('MSX', 'OTEL',  1.024, 0.004, 0.3922,  1.020, 1.026, 1.018,  312800::numeric,  1.022, 1.110, 0.930, 1),
  ('BHB', 'NBB',   0.462, 0.000, 0.0000,  0.462, 0.463, 0.461,   88400::numeric,  0.462, 0.505, 0.428, 0)
) as q(venue, ticker, last, chg, chg_pct, open, high, low, vol, vwap, hi52, lo52, dir)
join public.securities s on s.venue_code = q.venue and s.ticker = q.ticker;

insert into public.index_levels (index_code, as_of, level, change, change_pct, day_high, day_low, value_traded) values
  ('TASI',  '2026-07-12 05:26:00+00', 11840.55,  62.10,  0.5272, 11862.40, 11778.20, 2845000000),
  ('QSI',   '2026-07-12 05:26:00+00', 10488.20,  31.45,  0.3008, 10501.10, 10455.90,  310000000),
  ('MSX30', '2026-07-12 05:19:00+00',  4712.80,  -8.35, -0.1769,  4725.60,  4708.10,   11200000),
  ('BAX',   '2026-07-12 05:26:00+00',  2044.15,   2.05,  0.1004,  2045.90,  2041.30,    2400000);

insert into public.ohlcv_daily (security_id, trade_date, open, high, low, close, volume, value_traded)
select s.id, d.td, d.o, d.h, d.l, d.c, d.v, d.vt
from (values
  ('2026-07-09'::date, 26.80, 27.05, 26.70, 26.95, 9120000::numeric, 245000000::numeric),
  ('2026-07-08'::date, 26.60, 26.90, 26.55, 26.85, 8410000::numeric, 224000000::numeric),
  ('2026-07-07'::date, 26.75, 26.85, 26.40, 26.55, 7930000::numeric, 211000000::numeric)
) as d(td, o, h, l, c, v, vt)
cross join (select id from public.securities where venue_code = 'TDWL' and ticker = '2222') s;

insert into public.index_sector_weights (index_code, sector, weight_pct, as_of) values
  ('TASI', 'banks',   38.200, '2026-06-30'),
  ('TASI', 'energy',  17.400, '2026-06-30'),
  ('TASI', 'telecom',  7.900, '2026-06-30');

-- Feed states at 09:41 GST — the MSX incident thread from the design fixture.
insert into public.venue_feed_status (venue_code, state, detail, last_sync_at, retry_count, latency_ms) values
  ('TDWL', 'delayed',      'DELAYED · 15-MIN · SYNCED 09:26',  '2026-07-12 05:26:00+00', 0,  840),
  ('DFM',  'closed',       'MARKET CLOSED (Mon–Fri venue)',    '2026-07-10 10:45:00+00', 0, null),
  ('ADX',  'closed',       'MARKET CLOSED (Mon–Fri venue)',    '2026-07-10 10:45:00+00', 0, null),
  ('QE',   'delayed',      'DELAYED · 15-MIN · SYNCED 09:26',  '2026-07-12 05:26:00+00', 0,  910),
  ('MSX',  'reconnecting', 'LAST SYNC 09:19 · RETRY 4',        '2026-07-12 05:19:00+00', 4, 4020),
  ('BHB',  'delayed',      'DELAYED · 15-MIN · SYNCED 09:26',  '2026-07-12 05:26:00+00', 0,  760)
on conflict (venue_code) do update
  set state = excluded.state, detail = excluded.detail, last_sync_at = excluded.last_sync_at,
      retry_count = excluded.retry_count, latency_ms = excluded.latency_ms;

insert into ops.incidents (severity, source, message, created_at) values
  ('degraded', 'feed:MSX', 'MSX quotes feed degraded — timeout, retry 4, fallback cadence 90s', '2026-07-12 05:22:00+00');

insert into ops.incident_banners (message, severity, surfaces, venue_code, created_by, starts_at)
values ('MSX data is syncing slower than usual. Last update 09:19 GST.', 'degraded',
        '{reader.msx,desk}', 'MSX',
        (select id from iam.principals where handle = 'SYSTEM'),
        '2026-07-12 05:25:00+00');

-- ---------------------------------------------------------------------------
-- Ingestion registry rows the sweep/scheduler operate on.
insert into ingest.sources (venue, data_type, entry_url, endpoint_config, transport, last_content_hash, last_changed_at, last_success_at, consecutive_failures) values
  ('TDWL', 'quotes',       'https://www.saudiexchange.sa/market-watch',        '{"kind":"xhr_board"}', 'http_bootstrap', 'a3f1c2', '2026-07-12 05:26:00+00', '2026-07-12 05:26:00+00', 0),
  ('TDWL', 'filings_list', 'https://www.saudiexchange.sa/announcements',       '{"kind":"list"}',      'http',           '9b77e0', '2026-07-12 05:05:00+00', '2026-07-12 05:40:00+00', 0),
  ('QE',   'quotes',       'https://www.qe.com.qa/market-watch',               '{"kind":"board"}',     'http',           'c410aa', '2026-07-12 05:26:00+00', '2026-07-12 05:26:00+00', 0),
  ('MSX',  'quotes',       'https://www.msx.om/market-watch',                  '{"kind":"board"}',     'http',           '77d2b9', '2026-07-12 05:19:00+00', '2026-07-12 05:19:00+00', 4),
  ('BHB',  'quotes',       'https://www.bahrainbourse.com/market-watch',       '{"kind":"bulletin"}',  'http',           '5e00c4', '2026-07-12 05:26:00+00', '2026-07-12 05:26:00+00', 0);

insert into ingest.schedules (source_id, cadence_minutes, session_only, offset_minutes)
select id, case data_type when 'quotes' then 10 else 5 end,
       data_type = 'quotes',
       case venue when 'TDWL' then 0 when 'QE' then 3 when 'MSX' then 4 when 'BHB' then 5 else 1 end
from ingest.sources;

-- ---------------------------------------------------------------------------
-- Filings behind the fixture.
insert into public.filings (security_id, venue_code, source_ref, form_code, filing_type, title, filed_at, full_text, extracted_facts, is_market_moving, pdf_en_path) values
  ((select id from public.securities where venue_code='TDWL' and ticker='7010'),
   'TDWL', 'TADAWUL CG-1-2026-4471', 'CG-1', 'DIVIDEND',
   'stc announces the distribution of cash dividends to shareholders for Q2 2026',
   '2026-07-12 05:05:00+00',
   'The board of Saudi Telecom Company announces an interim cash dividend of SAR 0.55 per share for Q2 2026. Ex-dividend date 28 July 2026, record date 29 July 2026, payment date 12 August 2026.',
   '{"dps": 0.55, "ccy": "SAR", "ex_date": "2026-07-28", "record_date": "2026-07-29", "pay_date": "2026-08-12"}',
   true, 'filings/tdwl/2026/07/cg-1-2026-4471.pdf'),
  ((select id from public.securities where venue_code='TDWL' and ticker='2222'),
   'TDWL', 'TADAWUL FS-1-2026-3982', 'FS-1', 'RESULTS',
   'Saudi Aramco announces its interim condensed consolidated financial results for Q1 2026',
   '2026-05-11 06:00:00+00',
   'Saudi Aramco reports Q1 2026 net income of SAR 98.6 billion and gas production of 10.2 bcfd.',
   '{"net_income_sar_bn": 98.6, "gas_production_bcfd": 10.2, "fiscal_period": "2026-Q1"}',
   true, 'filings/tdwl/2026/05/fs-1-2026-3982.pdf');

-- ---------------------------------------------------------------------------
-- Lake lineage: snapshot → parse run → stc DPS revision chain (0.50 → 0.55).
insert into lake.snapshots (sha256, source_key, source_url, venue_code, fetched_at, fetched_by, http_status, content_type, byte_size, storage_path) values
  ('4a1b0e6d9f2c8a7b5e3d1c0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b',
   'tdwl.filings.detail', 'https://www.saudiexchange.sa/announcements/4471', 'TDWL',
   '2026-07-12 05:06:00+00', (select id from iam.principals where handle='DATA-FILINGS'),
   200, 'text/html', 48211, 'raw/tdwl.filings.detail/2026/07/4a1b0e6d.gz'),
  ('b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1',
   'tdwl.filings.detail', 'https://www.saudiexchange.sa/announcements/4408', 'TDWL',
   '2026-04-20 06:10:00+00', (select id from iam.principals where handle='DATA-FILINGS'),
   200, 'text/html', 46102, 'raw/tdwl.filings.detail/2026/04/b2c3d4e5.gz');

insert into lake.parse_runs (agent_id, parser_key, parser_version, started_at, finished_at, status, objects_created)
values
  ((select id from iam.principals where handle='DATA-FILINGS'), 'tdwl_dividend_v3', '3.2.0',
   '2026-04-20 06:11:00+00', '2026-04-20 06:11:04+00', 'succeeded', 1),
  ((select id from iam.principals where handle='DATA-FILINGS'), 'tdwl_dividend_v3', '3.2.1',
   '2026-07-12 05:07:00+00', '2026-07-12 05:07:03+00', 'succeeded', 1);

insert into lake.parse_run_snapshots (parse_run_id, snapshot_id)
select pr.id, sn.id
from lake.parse_runs pr
join lake.snapshots sn
  on (pr.parser_version = '3.2.1' and sn.sha256 like '4a1b%')
  or (pr.parser_version = '3.2.0' and sn.sha256 like 'b2c3%');

-- Revision 2 first (rev 1 points at it via superseded_by).
insert into lake.objects (id, object_type, natural_key, security_id, venue_code, payload, numeric_value, unit, effective_date, state, confidence, revision, parse_run_id, source_rank, verified_at, verified_by, price_sensitive)
values
  ('11111111-1111-4111-8111-111111111102', 'DIVIDEND.DPS', 'DIVIDEND.DPS:TDWL:7010:2026-INT1',
   (select id from public.securities where venue_code='TDWL' and ticker='7010'), 'TDWL',
   '{"dps": 0.55, "ccy": "SAR", "ex_date": "2026-07-28", "metric_key": "dps", "period": "2026-INT1", "period_end": "2026-07-28"}',
   0.55, 'SAR', '2026-07-28', 'VERIFIED', 0.987, 2,
   (select id from lake.parse_runs where parser_version = '3.2.1'), 20,
   '2026-07-12 05:12:00+00', (select id from iam.principals where handle='SYSTEM'), true),
  ('11111111-1111-4111-8111-111111111103', 'FILING.FINANCIALS', 'FILING.FINANCIALS:TDWL:2222:2026-Q1',
   (select id from public.securities where venue_code='TDWL' and ticker='2222'), 'TDWL',
   '{"net_income_sar_bn": 98.6, "gas_production_bcfd": 10.2, "metric_key": "gas_production_bcfd", "period": "2026-Q1", "period_end": "2026-03-31"}',
   10.2, 'bcfd', '2026-03-31', 'VERIFIED', 0.992, 1,
   (select id from lake.parse_runs where parser_version = '3.2.1'), 20,
   '2026-05-11 07:00:00+00', (select id from iam.principals where handle='SYSTEM'), false);

insert into lake.objects (id, object_type, natural_key, security_id, venue_code, payload, numeric_value, unit, effective_date, state, confidence, revision, parse_run_id, source_rank, superseded_by, price_sensitive)
values
  ('11111111-1111-4111-8111-111111111101', 'DIVIDEND.DPS', 'DIVIDEND.DPS:TDWL:7010:2026-INT1',
   (select id from public.securities where venue_code='TDWL' and ticker='7010'), 'TDWL',
   '{"dps": 0.50, "ccy": "SAR", "ex_date": "2026-07-28"}',
   0.50, 'SAR', '2026-07-28', 'RETIRED', 0.981, 1,
   (select id from lake.parse_runs where parser_version = '3.2.0'), 20,
   '11111111-1111-4111-8111-111111111102', true);

insert into lake.object_revisions (natural_key, old_object_id, new_object_id, old_value, new_value, reason, actor_id, created_at)
values ('DIVIDEND.DPS:TDWL:7010:2026-INT1',
        '11111111-1111-4111-8111-111111111101', '11111111-1111-4111-8111-111111111102',
        '{"dps": 0.50}', '{"dps": 0.55}', 'source_update',
        (select id from iam.principals where handle='DATA-FILINGS'),
        '2026-07-12 05:08:00+00');

-- An open conflict for the 29a inspector.
insert into lake.objects (id, object_type, natural_key, security_id, venue_code, payload, numeric_value, unit, effective_date, state, confidence, revision, parse_run_id, source_rank, price_sensitive)
values
  ('11111111-1111-4111-8111-111111111104', 'DIVIDEND.EXDATE', 'DIVIDEND.EXDATE:QE:QNBK:FY2025',
   (select id from public.securities where venue_code='QE' and ticker='QNBK'), 'QE',
   '{"ex_date": "2026-07-21"}', null, null, '2026-07-21', 'CONFLICT', 0.610, 1,
   (select id from lake.parse_runs where parser_version = '3.2.1'), 90, true);

insert into lake.object_conflicts (natural_key, object_id, candidates, status)
values ('DIVIDEND.EXDATE:QE:QNBK:FY2025', '11111111-1111-4111-8111-111111111104',
        '[{"value": "2026-07-21", "source_key": "qe.press", "source_rank": 90},
          {"value": "2026-07-22", "source_key": "qe.exchange.page", "source_rank": 20}]',
        'open');

-- ---------------------------------------------------------------------------
-- The dividend row every surface reads (single-write fan-out, 02 §8).
insert into public.dividends (security_id, div_type, fiscal_ref, dps, currency, ex_date, record_date, pay_date, yield_at_announce, payout_ratio, verification, state, confirmed_by, confirmed_at, source_object_id)
values ((select id from public.securities where venue_code='TDWL' and ticker='7010'),
        'INTERIM', '2026-INT1', 0.55, 'SAR', '2026-07-28', '2026-07-29', '2026-08-12',
        0.0520, 0.7100, 'disclosure', 'live',
        (select id from iam.principals where handle='SYSTEM'), '2026-07-12 05:14:00+00',
        '11111111-1111-4111-8111-111111111102');

-- Datapoint series + values with lineage to the lake objects above.
insert into public.datapoint_series (security_id, metric_key, display_name, unit, cadence, maintainer_id)
values
  ((select id from public.securities where venue_code='TDWL' and ticker='7010'),
   'dps', 'Dividend per share', 'SAR', 'event', (select id from iam.principals where handle='DATA-FILINGS')),
  ((select id from public.securities where venue_code='TDWL' and ticker='2222'),
   'gas_production_bcfd', 'Gas production', 'bcfd', 'quarterly', (select id from iam.principals where handle='DATA-FILINGS'));

insert into public.datapoints (series_id, period, period_end, value, prev_value, source_object_id, as_of)
values
  ((select id from public.datapoint_series where metric_key='dps'),
   '2026-INT1', '2026-07-28', 0.55, 0.50, '11111111-1111-4111-8111-111111111102', '2026-07-12 05:12:00+00'),
  ((select id from public.datapoint_series where metric_key='gas_production_bcfd'),
   '2026-Q1', '2026-03-31', 10.2, 9.9, '11111111-1111-4111-8111-111111111103', '2026-05-11 07:00:00+00');

-- ---------------------------------------------------------------------------
-- Ratios, scores, earnings calendar.
insert into public.key_ratios (security_id, market_cap, pe, pb, eps_ttm, dividend_yield, payout_ratio, roe)
select s.id, k.mc, k.pe, k.pb, k.eps, k.dy, k.pr, k.roe
from (values
  ('TDWL','2222', 6570300000000::numeric, 16.750, 4.120, 1.6200, 0.0498, 0.8300, 0.2470),
  ('TDWL','7010',  210600000000::numeric, 15.900, 2.480, 2.6600, 0.0520, 0.7100, 0.1560),
  ('TDWL','1120',  352400000000::numeric, 17.300, 3.610, 5.0900, 0.0270, 0.4700, 0.2110),
  ('QE',  'QNBK',  160900000000::numeric,  9.800, 1.520, 1.7800, 0.0380, 0.3700, 0.1580)
) as k(venue, ticker, mc, pe, pb, eps, dy, pr, roe)
join public.securities s on s.venue_code = k.venue and s.ticker = k.ticker;

insert into public.scores (security_id, score, rating, weekly_delta, grade_value, grade_growth, grade_profitability, grade_momentum, grade_revisions, sector_percentile, sector_peer_count, computed_at, next_compute_at)
select s.id, sc.score, sc.rating, sc.wd, sc.gv, sc.gg, sc.gp, sc.gm, sc.gr, sc.pct, sc.peers,
       timestamptz '2026-07-12 00:00:00+00', timestamptz '2026-07-13 00:00:00+00'
from (values
  ('TDWL','2222', 74::smallint, 'OVERWEIGHT',  1::smallint, 'B+', 'B',  'A-', 'B',  'B+', 82::smallint, 34),
  ('TDWL','7010', 68::smallint, 'HOLD',        2::smallint, 'B',  'B-', 'B+', 'B+', 'B',  71::smallint, 12),
  ('TDWL','1120', 81::smallint, 'BUY',         0::smallint, 'B',  'A-', 'A',  'B+', 'A-', 91::smallint, 27)
) as sc(venue, ticker, score, rating, wd, gv, gg, gp, gm, gr, pct, peers)
join public.securities s on s.venue_code = sc.venue and s.ticker = sc.ticker;

insert into public.score_history (security_id, computed_on, score, rating, grades, sector_percentile)
select s.id, d, 66 + (random()*4)::int, 'HOLD', '{"value":"B","growth":"B-"}', 70
from public.securities s, generate_series(date '2026-07-05', date '2026-07-11', interval '1 day') d
where s.venue_code = 'TDWL' and s.ticker = '7010';

insert into public.score_events (security_id, event_kind, old_value, new_value, detail, occurred_at)
values ((select id from public.securities where venue_code='TDWL' and ticker='7010'),
        'score_change', '66', '68', '{"factor": "revisions", "from": "B-", "to": "B"}',
        '2026-07-12 00:05:00+00');

insert into public.earnings_events (security_id, fiscal_period, report_date, date_state, session, eps_consensus, eps_marsad, eps_prior)
values ((select id from public.securities where venue_code='TDWL' and ticker='2222'),
        '2026-Q2', '2026-08-04', 'estimated', 'post', 0.4100, 0.4150, 0.3980);

-- ---------------------------------------------------------------------------
-- Published TPL-01 wire citing the verified stc object (byline chain 31b).
insert into public.content_items (id, content_type, slug, section, headline, status, template_key, author_id, byline_chain, word_count, published_at, created_at)
values ('22222222-2222-4222-8222-222222222201', 'WIRE',
        'stc-interim-dividend-q2-2026', 'markets',
        'stc raises Q2 2026 interim dividend to SAR 0.55 per share',
        'live', 'TPL-01',
        (select id from iam.principals where handle='WRITER-2'),
        '[{"role": "drafted_by", "principal": "WRITER-2"}, {"role": "checked_by", "principal": "EDITOR-1"}]',
        38, '2026-07-12 05:35:00+00', '2026-07-12 05:20:00+00');

insert into public.content_tickers (content_id, security_id, is_primary)
values ('22222222-2222-4222-8222-222222222201',
        (select id from public.securities where venue_code='TDWL' and ticker='7010'), true);

insert into public.content_blocks (content_id, seq, block_kind, body, bound_object_id) values
  ('22222222-2222-4222-8222-222222222201', 1, 'paragraph',
   '{"text": "stc will pay an interim dividend of SAR 0.55 per share for Q2 2026, up from SAR 0.50 a year earlier. Ex-date is 28 July; payment lands 12 August."}',
   null),
  ('22222222-2222-4222-8222-222222222201', 2, 'BLK-EXDATE',
   '{"security": "TDWL:7010", "fiscal_ref": "2026-INT1"}',
   '11111111-1111-4111-8111-111111111102');

insert into lake.citations (content_id, object_id, block_key, claim_text, quoted_value, cited_by)
values ('22222222-2222-4222-8222-222222222201', '11111111-1111-4111-8111-111111111102',
        'BLK-EXDATE', 'interim dividend of SAR 0.55 per share', '0.55',
        (select id from iam.principals where handle='WRITER-2'));

insert into ops.pipeline_items (content_id, stage, writer_agent, editor_agent, confidence, queued_at, stage_entered_at, approval_decision, decided_by, decided_at)
values ('22222222-2222-4222-8222-222222222201', 'published',
        (select id from iam.principals where handle='WRITER-2'),
        (select id from iam.principals where handle='EDITOR-1'),
        0.940, '2026-07-12 05:21:00+00', '2026-07-12 05:35:00+00',
        'publish_now', (select id from iam.principals where handle='SYSTEM'), '2026-07-12 05:35:00+00');

-- Fixture audit trail entries (hash chain fills in via trigger).
select ops.audit((select id from iam.principals where handle='SYSTEM'), 'LAKE',
                 'verify_object', 'lake:11111111-1111-4111-8111-111111111102',
                 '{"dps": 0.50}', '{"dps": 0.55, "note": "stc DPS revision fixture"}');
select ops.audit((select id from iam.principals where handle='SYSTEM'), 'PUBLISH',
                 'approve_publish', 'content:22222222-2222-4222-8222-222222222201',
                 null, '{"template": "TPL-01", "word_count": 38}');

-- ---------------------------------------------------------------------------
-- Regression test (dev/staging only): a SECOND revision for an existing
-- (series, period_end) must verify cleanly — lake.fn_datapoint_fanout has to
-- supersede the live datapoint before inserting the replacement, or
-- datapoints_live_uni aborts the whole verification UPDATE (R-07 corrections).
-- Uses throwaway rows and deletes them afterwards; fixture data is untouched.
do $$
declare
  v_system   uuid := (select id from iam.principals where handle = 'SYSTEM');
  v_sec      bigint := (select id from public.securities where venue_code = 'TDWL' and ticker = '7010');
  v_run      bigint := (select id from lake.parse_runs where parser_version = '3.2.1');
  v_series   bigint;
  v_obj1     uuid := 'facade00-0000-4000-8000-000000000001';
  v_obj2     uuid := 'facade00-0000-4000-8000-000000000002';
  v_live_ct  int;
  v_live_val numeric;
  v_old_sup  bigint;
  v_new_id   bigint;
begin
  insert into public.datapoint_series (security_id, metric_key, display_name, unit, cadence, is_public)
  values (v_sec, 'regr_fanout_test', 'fanout regression (throwaway)', 'x', 'event', false)
  returning id into v_series;

  -- Revision 1: PENDING -> VERIFIED creates the first live datapoint.
  insert into lake.objects (id, object_type, natural_key, security_id, venue_code, payload,
                            numeric_value, unit, effective_date, state, revision, parse_run_id)
  values (v_obj1, 'TEST.REGR', 'TEST.REGR:TDWL:7010:P1', v_sec, 'TDWL',
          '{"metric_key": "regr_fanout_test", "period": "P1", "period_end": "2026-06-30"}',
          1, 'x', '2026-06-30', 'PENDING', 1, v_run);
  update lake.objects set state = 'VERIFIED', verified_by = v_system where id = v_obj1;

  -- Revision 2 via the documented supersede-then-insert flow (deferred FKs).
  update lake.objects set state = 'RETIRED', superseded_by = v_obj2 where id = v_obj1;
  insert into lake.objects (id, object_type, natural_key, security_id, venue_code, payload,
                            numeric_value, unit, effective_date, state, revision, parse_run_id)
  values (v_obj2, 'TEST.REGR', 'TEST.REGR:TDWL:7010:P1', v_sec, 'TDWL',
          '{"metric_key": "regr_fanout_test", "period": "P1", "period_end": "2026-06-30"}',
          2, 'x', '2026-06-30', 'PENDING', 2, v_run);
  update lake.objects set state = 'VERIFIED', verified_by = v_system where id = v_obj2;

  select count(*), max(d.value) into v_live_ct, v_live_val
  from public.datapoints d
  where d.series_id = v_series and d.superseded_by is null;
  if v_live_ct <> 1 or v_live_val <> 2 then
    raise exception 'fanout regression: expected one live datapoint of 2, got % row(s), value %',
      v_live_ct, v_live_val;
  end if;

  select d.superseded_by into v_old_sup
  from public.datapoints d
  where d.series_id = v_series and d.value = 1;
  select d.id into v_new_id
  from public.datapoints d
  where d.series_id = v_series and d.superseded_by is null;
  if v_old_sup is distinct from v_new_id then
    raise exception 'fanout regression: old datapoint superseded_by % does not point at live row %',
      v_old_sup, v_new_id;
  end if;

  -- Clean up so the frozen design fixture is exactly what remains.
  delete from public.datapoint_series where id = v_series;  -- cascades datapoints
  delete from lake.objects where id in (v_obj1, v_obj2);
  raise notice 'fanout regression: OK — second revision superseded and re-inserted cleanly';
end $$;

commit;
