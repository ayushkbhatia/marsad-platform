-- P3.3 — Seed real editorial content (owner decision D-1(a)).
--
-- Replaces the TypeScript `SAMPLE_*` editorial modules with real rows so the reader
-- runs the production query path (`content_items` -> `content_blocks` -> `content_tickers`
-- -> `lake.citations` / `v_content_citations`) end to end. When the newsroom conveyor is
-- rebuilt (P4/P5) it becomes a *producer* swap with zero front-end change.
--
-- TWO OWNER RULINGS THAT BIND THIS SEED (2026-07-27)
--   1. House byline only. Every piece is authored by the `Marsad Desk` principal
--      (iam.principals.id = 00000000-0000-4000-a000-00000000d35c, handle MARSAD-DESK).
--      No named analysts, no first-person opinion attributable to an individual.
--   2. Only real figures. EVERY number below was read out of the live database
--      (public.financial_statements, public.quotes_latest, public.v_key_ratios_public,
--      public.securities) and, where a period comparison is made, the period was first
--      reconciled (sum-of-quarters vs filed annual) to prove the filing is discrete and
--      not cumulative. Figures that could not be reconciled were cut, not estimated.
--      Notably: Emirates NBD's interim income statements do NOT reconcile
--      (Q2+Q3+Q4 2025 = AED 30.35bn vs a filed annual AED 23.981bn), so no Emirates NBD
--      *performance* claim appears anywhere; it is cited only in the EXPLAINER as an
--      example of a cumulative filing, which is a statement about the filing, not the bank.
--
-- RETIREMENT HANDLE: every seeded content_items row carries
--   byline_chain @> '[{"seed":"bridge-p3"}]'
-- so P5 can find and retire the whole set in one predicate. The seed marker is merged into
-- the byline entry itself (rather than appended as a bare object) because
-- src/lib/data/editorial.ts `toByline()` maps every array element to a rendered byline.
--
-- Idempotent: stable UUIDs; child rows are deleted and re-inserted; parents upsert on id.

begin;

-- ---------------------------------------------------------------------------
-- 0. Clear child rows for the seeded ids so re-running produces the same state.
-- ---------------------------------------------------------------------------
delete from lake.citations       where content_id in (
  'a1000000-0000-4000-a000-000000000001','a1000000-0000-4000-a000-000000000002',
  'a1000000-0000-4000-a000-000000000003','a1000000-0000-4000-a000-000000000004',
  'a1000000-0000-4000-a000-000000000005','a1000000-0000-4000-a000-000000000006',
  'a1000000-0000-4000-a000-000000000007','a1000000-0000-4000-a000-000000000008',
  'a1000000-0000-4000-a000-000000000009','a1000000-0000-4000-a000-000000000010');
delete from public.content_blocks  where content_id in (
  'a1000000-0000-4000-a000-000000000001','a1000000-0000-4000-a000-000000000002',
  'a1000000-0000-4000-a000-000000000003','a1000000-0000-4000-a000-000000000004',
  'a1000000-0000-4000-a000-000000000005','a1000000-0000-4000-a000-000000000006',
  'a1000000-0000-4000-a000-000000000007','a1000000-0000-4000-a000-000000000008',
  'a1000000-0000-4000-a000-000000000009','a1000000-0000-4000-a000-000000000010');
delete from public.content_tickers where content_id in (
  'a1000000-0000-4000-a000-000000000001','a1000000-0000-4000-a000-000000000002',
  'a1000000-0000-4000-a000-000000000003','a1000000-0000-4000-a000-000000000004',
  'a1000000-0000-4000-a000-000000000005','a1000000-0000-4000-a000-000000000006',
  'a1000000-0000-4000-a000-000000000007','a1000000-0000-4000-a000-000000000008',
  'a1000000-0000-4000-a000-000000000009','a1000000-0000-4000-a000-000000000010');

-- ---------------------------------------------------------------------------
-- 0. The house byline principal this seed's FK depends on.
-- ---------------------------------------------------------------------------
-- `content_items.author_id` is NOT NULL and FKs to `iam.principals`, and every row
-- below is authored by MARSAD-DESK. That principal's own migration is
-- 20260727090000_marsad_desk_principal — a LATER version than this file, so on a
-- from-scratch replay the FK has nothing to point at and the seed dies with
-- `content_items_author_id_fkey (SQLSTATE 23503)`. The live database never noticed:
-- both migrations were already applied there, so nothing re-ran in dependency order.
-- CI could not see it either, because the from-scratch job only runs when supabase/**
-- or ci.yml changes, and neither had since.
--
-- Inserted here rather than renaming 20260727090000 to sort earlier: that version is
-- already stamped in live `supabase_migrations.schema_migrations`, and renaming an
-- applied migration is precisely the drift the ledger exists to prevent. This is
-- idempotent and byte-identical to the row that migration writes, so whichever runs
-- first wins and the other is a no-op.
insert into iam.principals (id, kind, handle, display_name, is_active)
values (
  '00000000-0000-4000-a000-00000000d35c',
  'system',
  'MARSAD-DESK',
  'Marsad Desk',
  true
)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 1. content_items
-- ---------------------------------------------------------------------------
insert into public.content_items
  (id, content_type, slug, section, kicker, dek, headline, status, template_key,
   author_id, byline_chain, is_premium, premium_cut_after_block, read_minutes,
   evergreen, review_cadence_days, published_at, word_count)
values
-- 1 --------------------------------------------------------------------- QE / lead
('a1000000-0000-4000-a000-000000000001','ARTICLE',
 'qatar-banks-are-earning-more-and-keeping-less','Banks','EARNINGS · QATAR',
 'Nine Doha-listed lenders lifted second-quarter revenue 7.2% and net profit 1.7%. The shortfall is not a credit event — aggregate impairment charges actually fell. It is dispersion, and two names own almost all of it.',
 'Qatar''s banks are earning more and keeping less','live','TPL-08',
 '00000000-0000-4000-a000-00000000d35c',
 '[{"role":"desk","principal":"Marsad Desk","seed":"bridge-p3","seeded_at":"2026-07-27"}]'::jsonb,
 true, 4, 5, false, null, '2026-07-27T05:30:00Z', 620),
-- 2 -------------------------------------------------------------------- TDWL / cash
('a1000000-0000-4000-a000-000000000002','ARTICLE',
 'almarai-dividend-is-running-ahead-of-its-cash','Consumer','CASH FLOW · SAUDI ARABIA',
 'First-half revenue rose 8.8% and net profit fell 0.7%. The more interesting number sits below the income statement: SAR 1.14bn paid out against SAR 579m of free cash flow.',
 'Almarai''s dividend is running ahead of its cash','live','TPL-08',
 '00000000-0000-4000-a000-00000000d35c',
 '[{"role":"desk","principal":"Marsad Desk","seed":"bridge-p3","seeded_at":"2026-07-27"}]'::jsonb,
 true, 3, 5, false, null, '2026-07-27T06:10:00Z', 570),
-- 3 --------------------------------------------------------------------- BHB / Alba
('a1000000-0000-4000-a000-000000000003','ARTICLE',
 'alba-quadrupled-its-first-quarter-profit-the-stock-is-down','Energy & Materials',
 'OPERATING LEVERAGE · BAHRAIN',
 'Aluminium Bahrain turned a 2.6% revenue increase into a 315.6% profit increase — the cleanest case of operating leverage in the Gulf''s filed accounts. Its shares have gone backwards over a year.',
 'Alba quadrupled its first-quarter profit. The stock is down.','live','TPL-07',
 '00000000-0000-4000-a000-00000000d35c',
 '[{"role":"desk","principal":"Marsad Desk","seed":"bridge-p3","seeded_at":"2026-07-27"}]'::jsonb,
 false, null, 4, false, null, '2026-07-26T14:45:00Z', 440),
-- 4 --------------------------------------------------------------------- MSX / banks
('a1000000-0000-4000-a000-000000000004','ARTICLE',
 'omans-banks-are-the-mirror-image-of-qatars','Banks','EARNINGS · OMAN',
 'Sohar International, National Bank of Oman and Bank Dhofar grew second-quarter net profit 14.0% between them. Their Qatari peers managed 1.7% on much faster revenue growth.',
 'Oman''s banks are the mirror image of Qatar''s','live','TPL-02',
 '00000000-0000-4000-a000-00000000d35c',
 '[{"role":"desk","principal":"Marsad Desk","seed":"bridge-p3","seeded_at":"2026-07-27"}]'::jsonb,
 false, null, 4, false, null, '2026-07-26T16:20:00Z', 520),
-- 5 ---------------------------------------------------------------------- DFM / DTC
('a1000000-0000-4000-a000-000000000005','ARTICLE',
 'dubai-taxis-gross-margin-has-halved-twice-in-three-quarters','Consumer','MARGINS · DUBAI',
 'Gross margin went 24.5% to 18.1% to 9.8%. Second-quarter net profit came in at AED 10.4m against AED 105.4m a year earlier — a fall of 90.1%.',
 'Dubai Taxi''s gross margin has halved twice in three quarters','live','TPL-03',
 '00000000-0000-4000-a000-00000000d35c',
 '[{"role":"desk","principal":"Marsad Desk","seed":"bridge-p3","seeded_at":"2026-07-27"}]'::jsonb,
 false, null, 4, false, null, '2026-07-25T11:00:00Z', 430),
-- 6 ------------------------------------------------------------------ EXPLAINER
('a1000000-0000-4000-a000-000000000006','EXPLAINER',
 'why-q2-is-not-one-number-across-six-gcc-venues','Method','METHOD',
 'Some Gulf issuers file discrete quarters. Some file cumulative year-to-date and label it a quarter. Reading the two the same way will hand you a growth rate that does not exist.',
 'Why ''Q2'' is not one number across six GCC venues','live','TPL-06',
 '00000000-0000-4000-a000-00000000d35c',
 '[{"role":"desk","principal":"Marsad Desk","seed":"bridge-p3","seeded_at":"2026-07-27"}]'::jsonb,
 false, null, 6, true, 90, '2026-07-27T04:00:00Z', 640),
-- 7 ------------------------------------------------------------------- WIRE / CBQK
('a1000000-0000-4000-a000-000000000007','WIRE',
 'commercial-bank-q2-profit-falls-16-as-impairment-charge-jumps','Banks','WIRE · QATAR',
 'Revenue rose 12.4%. The charge for credit losses rose faster.',
 'Commercial Bank Q2 profit falls 16% as impairment charge jumps 75%','live','TPL-01',
 '00000000-0000-4000-a000-00000000d35c',
 '[{"role":"desk","principal":"Marsad Desk","seed":"bridge-p3","seeded_at":"2026-07-27"}]'::jsonb,
 false, null, 1, false, null, '2026-07-26T09:05:00Z', 35),
-- 8 ------------------------------------------------------------------- WIRE / QFBQ
('a1000000-0000-4000-a000-000000000008','WIRE',
 'lesha-bank-q2-net-profit-up-72-5-percent-to-qar-75-1m','Banks','WIRE · QATAR',
 'The smallest of Qatar''s nine listed lenders posted the sector''s fastest growth.',
 'Lesha Bank Q2 net profit up 72.5% to QAR 75.1m','live','TPL-01',
 '00000000-0000-4000-a000-00000000d35c',
 '[{"role":"desk","principal":"Marsad Desk","seed":"bridge-p3","seeded_at":"2026-07-27"}]'::jsonb,
 false, null, 1, false, null, '2026-07-26T09:40:00Z', 33),
-- 9 -------------------------------------------------------------------- WIRE / SIB
('a1000000-0000-4000-a000-000000000009','WIRE',
 'sharjah-islamic-bank-q2-profit-up-11-9-percent-on-20-percent-revenue-growth','Banks',
 'WIRE · ABU DHABI',
 'Net financing income rose 28.3%. The balance sheet crossed AED 94bn.',
 'Sharjah Islamic Bank Q2 profit up 11.9% on 20% revenue growth','live','TPL-01',
 '00000000-0000-4000-a000-00000000d35c',
 '[{"role":"desk","principal":"Marsad Desk","seed":"bridge-p3","seeded_at":"2026-07-27"}]'::jsonb,
 false, null, 1, false, null, '2026-07-25T08:15:00Z', 36),
-- 10 ------------------------------------------------------------------ WIRE / OQBI
('a1000000-0000-4000-a000-000000000010','WIRE',
 'oq-base-industries-q2-net-profit-more-than-doubles','Industrials','WIRE · OMAN',
 'Revenue nearly doubled year on year to OMR 107.3m.',
 'OQ Base Industries Q2 net profit more than doubles to OMR 26.4m','live','TPL-01',
 '00000000-0000-4000-a000-00000000d35c',
 '[{"role":"desk","principal":"Marsad Desk","seed":"bridge-p3","seeded_at":"2026-07-27"}]'::jsonb,
 false, null, 1, false, null, '2026-07-26T10:50:00Z', 34)
on conflict (id) do update set
  content_type            = excluded.content_type,
  slug                    = excluded.slug,
  section                 = excluded.section,
  kicker                  = excluded.kicker,
  dek                     = excluded.dek,
  headline                = excluded.headline,
  status                  = excluded.status,
  template_key            = excluded.template_key,
  author_id               = excluded.author_id,
  byline_chain            = excluded.byline_chain,
  is_premium              = excluded.is_premium,
  premium_cut_after_block = excluded.premium_cut_after_block,
  read_minutes            = excluded.read_minutes,
  evergreen               = excluded.evergreen,
  review_cadence_days     = excluded.review_cadence_days,
  published_at            = excluded.published_at,
  word_count              = excluded.word_count;

-- ---------------------------------------------------------------------------
-- 2. content_blocks
--    `gated = true` on every block beyond premium_cut_after_block, so the RLS cut
--    (content_blocks.published_read: `(not gated) or jwt_tier() <> 'free'`) is what
--    truncates the piece for anon — not a CSS mask.
-- ---------------------------------------------------------------------------
-- `bound_object_id` is a LOOKUP, not a literal, on purpose. These 23 object ids are
-- real rows the scrapers produced; they exist in the live database and in no other.
-- Written as literals, a from-scratch replay dies on `content_blocks_bound_object_id_fkey`,
-- which broke the CI job that proves the schema can be rebuilt. A scalar subquery yields
-- the id where the object exists and NULL where it does not, and the column is nullable —
-- so live is byte-identical and a fresh database gets unbound blocks rather than no blocks.
-- The prose never depended on the binding; it is provenance, not content.
insert into public.content_blocks (content_id, seq, block_kind, body, bound_object_id, gated) values

-- === 1. Qatar banks (premium, cut after block 4) ===========================
('a1000000-0000-4000-a000-000000000001',1,'text',
 jsonb_build_object('text','Every Qatari bank that has filed for the second quarter has now told the same story twice: the top line is working, and less of it is arriving at the bottom. Across the nine lenders on the Qatar Exchange with a comparable Q2 2026 income statement, revenue reached QAR 21.66bn against QAR 20.20bn a year earlier — up 7.2%. Net profit reached QAR 7.53bn against QAR 7.40bn — up 1.7%.'),
 (select o.id from lake.objects o where o.id = 'be1b03cf-a41c-4e81-8d00-db74138d6fb4'), false),
('a1000000-0000-4000-a000-000000000001',2,'text',
 jsonb_build_object('text','That five-and-a-half point gap is the quarter. It shows up as margin: 34.76% of revenue reached net profit, against 36.63% a year earlier — 187 basis points surrendered in twelve months. The obvious suspect is credit, and the obvious suspect is innocent. Aggregate impairment charges across the same nine banks were QAR 3.36bn, down 1.2% from QAR 3.40bn. Whatever is eating the margin, it is not, in aggregate, bad loans.'),
 null, false),
('a1000000-0000-4000-a000-000000000001',3,'pull_quote',
 jsonb_build_object('text','Revenue grew at four times the speed of profit. Aggregate impairments went down, not up.'),
 null, false),
('a1000000-0000-4000-a000-000000000001',4,'text',
 jsonb_build_object('text','The aggregate hides an unusually wide spread: five of the nine grew profit, four shrank it. QNB, alone more than half the sample''s revenue, lifted net profit 5.0% to QAR 4.43bn on revenue up 11.2% to QAR 11.80bn, and carried total assets to QAR 1.438 trillion. Qatar Islamic Bank added 4.8% to QAR 1.24bn. Dukhan managed 2.4%, International Islamic 3.8%. Lesha Bank, the smallest of the nine, grew profit 72.5% off a base of QAR 43.5m.'),
 (select o.id from lake.objects o where o.id = 'f811963a-bb92-458e-b249-6d37d6362ed4'), false),
('a1000000-0000-4000-a000-000000000001',5,'heading',
 jsonb_build_object('text','Where the shortfall actually sits'), null, true),
('a1000000-0000-4000-a000-000000000001',6,'text',
 jsonb_build_object('text','Two banks account for essentially the whole miss. The Commercial Bank grew revenue 12.4% to QAR 1.28bn and lost 16.0% of net profit, down to QAR 512.3m from QAR 610.0m. Its impairment charge went the other way from the sector: QAR 302.1m against QAR 172.7m, a 74.9% increase. The distance between operating profit and pre-tax profit widened from QAR 95m to QAR 299m in a single year. Earnings per share fell to QAR 0.13 from QAR 0.16.'),
 (select o.id from lake.objects o where o.id = 'c778accb-59bf-4351-aae1-e4caa1cf0523'), true),
('a1000000-0000-4000-a000-000000000001',7,'text',
 jsonb_build_object('text','Masraf Al Rayan is the other. Revenue fell 5.4% to QAR 2.14bn and net profit fell 19.0% to QAR 339.3m. Its total impairment line was lower than a year ago — QAR 189.4m against QAR 204.2m — but the composition moved hard, with the charge recognised directly in profit or loss rising to QAR 243.9m from QAR 75.5m. Operating expenses rose 54.8% to QAR 494.9m and the tax line went from QAR 8.7m to QAR 49.8m. Between them, Commercial Bank and Al Rayan gave back QAR 177m of profit; the other seven added QAR 306m.'),
 (select o.id from lake.objects o where o.id = '1bdeddaf-1ef4-4631-b4f9-48fb59bbba19'), true),
('a1000000-0000-4000-a000-000000000001',8,'heading',
 jsonb_build_object('text','The market voted before the filings landed'), null, true),
('a1000000-0000-4000-a000-000000000001',9,'text',
 jsonb_build_object('text','On 26 July, QNB traded at QAR 16.60 — 0.6% above its 52-week low of QAR 16.50 — on a trailing price/earnings ratio of 9.5x. Qatar Islamic at QAR 21.42 was 2.5% off its low of QAR 20.90. Commercial Bank at QAR 4.02 sat 1.0% above QAR 3.98. Al Rayan at QAR 1.963 was through its QAR 1.970 low. Doha Bank is the exception: 16.9% above its low and up 39.2% over the trailing twelve months to one month ago. Four of Qatar''s five largest listed lenders are priced at the bottom of their year in the same week they reported the sector''s highest revenue on record in this dataset. Either the margin compression is permanent, or something here is mispriced.'),
 (select o.id from lake.objects o where o.id = '6b1fce39-98be-42d7-9a2c-0d06e2f053f0'), true),

-- === 2. Almarai (premium, cut after block 3) ===============================
('a1000000-0000-4000-a000-000000000002',1,'text',
 jsonb_build_object('text','Almarai sold more in the first half of 2026 than in any comparable period in its filed history, and made slightly less money doing it. Revenue across the two quarters came to SAR 12.03bn against SAR 11.06bn a year earlier, up 8.8%. Net profit came to SAR 1.369bn against SAR 1.379bn — down 0.7%.'),
 (select o.id from lake.objects o where o.id = '45de2a63-74d5-454a-a7d2-91ad7ecddd24'), false),
('a1000000-0000-4000-a000-000000000002',2,'text',
 jsonb_build_object('text','The squeeze is entirely at the gross line. Half-year gross profit was SAR 3.69bn on SAR 12.03bn of sales, a 30.68% margin, against 31.49% a year earlier. The second quarter alone was worse: 31.08% against 32.39%, 131 basis points gone. Cost of sales rose 10.1% while revenue rose 8.8%. That is the whole of the earnings story, and on its own it would be unremarkable.'),
 (select o.id from lake.objects o where o.id = '7272b5e7-df67-4f01-b8b0-95fb285648a0'), false),
('a1000000-0000-4000-a000-000000000002',3,'pull_quote',
 jsonb_build_object('text','SAR 1.14bn went out as dividends. SAR 579m of free cash flow came in to fund it.'),
 null, false),
('a1000000-0000-4000-a000-000000000002',4,'heading',
 jsonb_build_object('text','The half-year cash statement'), null, true),
('a1000000-0000-4000-a000-000000000002',5,'text',
 jsonb_build_object('text','Almarai files its cash flow statement cumulatively, and that is where the strain shows. Operating cash flow for the half was SAR 2.372bn, down 7.1% from SAR 2.553bn. Capital expenditure was SAR 1.793bn, down 14.5% from SAR 2.097bn. That leaves SAR 579m of free cash flow, against SAR 456m a year earlier — an improvement. Dividends paid were SAR 1.137bn, up 15.4% from SAR 985m. The payout was 1.96 times what the business generated after capex; last year it was 2.16 times. Two halves in a row.'),
 (select o.id from lake.objects o where o.id = '6767da37-c469-4d39-8dea-dce5f3c65a57'), true),
('a1000000-0000-4000-a000-000000000002',6,'text',
 jsonb_build_object('text','The balance sheet absorbed the difference. Cash fell to SAR 457m at 30 June from SAR 900m three months earlier. Equity fell to SAR 20.63bn from SAR 21.12bn over the same quarter even as total assets rose to SAR 42.81bn. Measured against a year ago the asymmetry is clearer still: assets up 13.4%, equity up 6.5%. The growth is being funded, and it is not being funded out of retained profit.'),
 (select o.id from lake.objects o where o.id = '7bf54256-100c-486d-b686-5bb460002d19'), true),
('a1000000-0000-4000-a000-000000000002',7,'text',
 jsonb_build_object('text','None of this is distress. Almarai is a SAR 46.2bn company that earned SAR 1.369bn in the half and returned SAR 1.137bn of it to shareholders. But a business that funds growth and dividends out of operations is a different business from one that needs the balance sheet to bridge capex, and 2026 is the second consecutive half in which the second description fits better. The shares closed at SAR 45.10 on 26 July, down 2.3% on the day, having returned minus 4.4% over the twelve months to one month ago and plus 10.4% over the last three.'),
 (select o.id from lake.objects o where o.id = 'a0086fda-e4a9-4dec-9a27-a8d1106d920c'), true),

-- === 3. Alba (free) ========================================================
('a1000000-0000-4000-a000-000000000003',1,'text',
 jsonb_build_object('text','Aluminium Bahrain reported first-quarter 2026 revenue of BHD 419.6m, up 2.6% from BHD 409.0m, and net profit of BHD 75.3m, up 315.6% from BHD 18.1m. A single-digit move in the top line produced a more-than-fourfold move in the bottom line. That is the arithmetic of a business whose costs barely move with output, and it cuts both ways.'),
 null, false),
('a1000000-0000-4000-a000-000000000003',2,'text',
 jsonb_build_object('text','The 2025 quarters make the shape obvious. Net profit ran BHD 18.1m, then 24.6m, then 67.3m, then 108.7m, while revenue ran BHD 409.0m, 434.1m, 449.4m, 486.3m. Revenue rose 18.9% from the first quarter to the fourth. Profit rose 500%. The full year landed at BHD 1,778.8m of revenue and BHD 218.7m of profit, against BHD 1,621.7m and BHD 184.5m in 2024 — up 9.7% and 18.5% respectively.'),
 (select o.id from lake.objects o where o.id = '3fef5f85-bd6b-4943-b9f9-3ec70dce7a95'), false),
('a1000000-0000-4000-a000-000000000003',3,'pull_quote',
 jsonb_build_object('text','Revenue up 2.6%. Profit up 315.6%. Net margin 17.95% against 4.43%.'),
 null, false),
('a1000000-0000-4000-a000-000000000003',4,'text',
 jsonb_build_object('text','Margin is the whole story. Alba converted 17.95% of first-quarter revenue into net profit against 4.43% a year earlier — a 13.5 percentage point swing on a revenue base that barely moved. Nothing in the filed accounts requires a volume explanation; the same revenue simply cost far less to produce.'),
 null, false),
('a1000000-0000-4000-a000-000000000003',5,'heading',
 jsonb_build_object('text','What the market paid for it'), null, false),
('a1000000-0000-4000-a000-000000000003',6,'text',
 jsonb_build_object('text','Not much. Alba closed at BHD 0.924 on 26 July, capitalising the company at BHD 1.31bn. On trailing twelve-month earnings per share of BHD 0.1949 — a figure that already contains both the strong fourth quarter and this first quarter — that is a price/earnings ratio of 4.7x. Over the twelve months to one month ago the shares returned minus 3.1%.'),
 (select o.id from lake.objects o where o.id = '0789bdd9-f12a-45ec-9164-40242c7d94ef'), false),
('a1000000-0000-4000-a000-000000000003',7,'text',
 jsonb_build_object('text','There are honest reasons a cyclical smelter trades at four-and-a-half times a peak-ish earnings number, and a reader can supply most of them without help. What is not in dispute is the distance between what the accounts did and what the price did. It is also worth noting how stale the best available information is: none of the 41 Bahraini securities we track has yet filed a second-quarter income statement, so a March-quarter print remains the market''s most recent hard number on Alba, almost four months after the period closed.'),
 null, false),

-- === 4. Oman banks (free) ==================================================
('a1000000-0000-4000-a000-000000000004',1,'text',
 jsonb_build_object('text','Three of Oman''s listed banks have filed second-quarter accounts, and all three did the thing their Qatari peers could not: they converted revenue into profit at a better rate than a year earlier. Sohar International grew net profit 9.1% to OMR 26.9m. National Bank of Oman grew it 15.8% to OMR 19.6m. Bank Dhofar grew it 22.0% to OMR 14.0m. Together, OMR 60.6m against OMR 53.1m — up 14.0%.'),
 null, false),
('a1000000-0000-4000-a000-000000000004',2,'text',
 jsonb_build_object('text','The contrast with Doha is not subtle. Nine Qatar Exchange banks grew second-quarter revenue 7.2% and net profit 1.7% over exactly the same period. The Omani three grew profit at eight times that rate, on top lines that moved far less: Sohar''s reported revenue rose to OMR 65.2m from OMR 55.6m, National Bank of Oman''s to OMR 40.4m from OMR 39.3m.'),
 null, false),
('a1000000-0000-4000-a000-000000000004',3,'text',
 jsonb_build_object('text','The sequential picture is more sober and belongs alongside it. Sohar''s second-quarter revenue of OMR 65.2m was well below the OMR 88.0m it booked in the first quarter, and National Bank of Oman''s OMR 40.4m was below OMR 46.2m. Both still grew profit quarter on quarter — Sohar OMR 26.9m against OMR 26.1m, NBO OMR 19.6m against OMR 19.5m. A smaller quarter that earned more of itself is a cost story, not a growth story.'),
 (select o.id from lake.objects o where o.id = '48f4e76a-4a53-4be6-b04b-d9d84565913f'), false),
('a1000000-0000-4000-a000-000000000004',4,'pull_quote',
 jsonb_build_object('text','Oman''s three lenders grew profit 14.0%. Qatar''s nine managed 1.7%.'),
 null, false),
('a1000000-0000-4000-a000-000000000004',5,'heading',
 jsonb_build_object('text','The rest of the Omani tape'), null, false),
('a1000000-0000-4000-a000-000000000004',6,'text',
 jsonb_build_object('text','Muscat is the Gulf''s second-busiest second-quarter reporter: 20 of its 120 listed securities have a filed Q2 2026 income statement, against 17 of 49 in Doha, six of 72 in Dubai, four of 93 in Abu Dhabi, two of 387 in Riyadh and none of 41 in Manama. Among the industrials, OQ Base Industries reported net profit of OMR 26.4m against OMR 12.1m, Phoenix Power OMR 16.1m against OMR 9.4m, and Oman Cables OMR 5.87m against OMR 5.76m on revenue up 40.4%.'),
 (select o.id from lake.objects o where o.id = 'ac66526f-2ff5-4fdb-9194-20b5ef4ef709'), false),
('a1000000-0000-4000-a000-000000000004',7,'text',
 jsonb_build_object('text','Oman Cables is the one to sit with: revenue up 40.4%, net profit up 2.0%. Gross profit went from OMR 9.52m to OMR 10.66m while cost of sales went from OMR 58.68m to OMR 85.10m — an 11.1% gross margin against 14.0%. That is revenue arriving thinner, the exact inverse of Alba''s quarter, and by far the more common shape in this reporting season.'),
 null, false),
('a1000000-0000-4000-a000-000000000004',8,'text',
 jsonb_build_object('text','Sohar traded at OMR 0.173 on 26 July and National Bank of Oman at OMR 0.450. OQ Base Industries traded at OMR 0.237, up 1.3% on the day. Over the trailing twelve months to one month ago Phoenix Power has returned 181.5% and OQ Base Industries 84.5%, while Oman Cables has returned minus 84.4% — three names, one market, and no common factor worth the name.'),
 (select o.id from lake.objects o where o.id = '17bc5dd6-58f5-4422-a8d3-cf937fda573b'), false),

-- === 5. Dubai Taxi (free) ==================================================
('a1000000-0000-4000-a000-000000000005',1,'text',
 jsonb_build_object('text','Dubai Taxi Company reported second-quarter revenue of AED 484.5m, down 22.5% from AED 625.1m a year earlier, and net profit of AED 10.4m against AED 105.4m — a fall of 90.1%. The revenue decline is bad. The margin decline is the story.'),
 (select o.id from lake.objects o where o.id = 'c69d453b-2e30-40aa-9408-1884c162658f'), false),
('a1000000-0000-4000-a000-000000000005',2,'text',
 jsonb_build_object('text','Three consecutive quarters of gross margin: 24.5% in Q2 2025, 18.1% in Q1 2026, 9.8% in Q2 2026. In absolute terms gross profit went from AED 153.3m to AED 99.6m to AED 47.2m while revenue went from AED 625.1m to AED 551.1m to AED 484.5m. Revenue fell 22.5% across the year. Gross profit fell 69.2%.'),
 (select o.id from lake.objects o where o.id = 'cc1c04ec-b520-46a4-bf2c-c7fbc4d7649e'), false),
('a1000000-0000-4000-a000-000000000005',3,'pull_quote',
 jsonb_build_object('text','Revenue fell 22.5%. Gross profit fell 69.2%. Operating profit fell 82.2%.'),
 null, false),
('a1000000-0000-4000-a000-000000000005',4,'text',
 jsonb_build_object('text','Operating profit fell from AED 128.5m to AED 22.9m. After AED 1.4m of tax the company kept AED 10.4m, or 2.1% of revenue, against 16.9% a year earlier. The cost base is not following the top line down: direct costs were AED 345.1m in the quarter against AED 359.2m in the first — down 3.9% while revenue fell 12.1%.'),
 null, false),
('a1000000-0000-4000-a000-000000000005',5,'text',
 jsonb_build_object('text','Cash held up better than earnings, which is what you would expect of a fleet. First-half operating cash flow was AED 243.0m against AED 108.2m of depreciation, the company paid AED 142.0m of dividends, and closed June with AED 317.6m of cash. The gap between reported profit and cash generated is almost entirely the depreciation line — which also means the eventual replacement of that fleet is a future cash event the income statement has already partly recognised.'),
 (select o.id from lake.objects o where o.id = '70cd0776-b5aa-4ac0-a5f6-f20d6c928a82'), false),
('a1000000-0000-4000-a000-000000000005',6,'text',
 jsonb_build_object('text','The shares closed at AED 2.10 on 24 July, down 0.9%, inside a 52-week range of AED 1.97 to AED 2.89 and capitalising the company at AED 5.25bn. On trailing earnings per share of AED 0.0914 that is 23 times — and the trailing figure still contains three quarters that look nothing like this one.'),
 null, false),
('a1000000-0000-4000-a000-000000000005',7,'text',
 jsonb_build_object('text','For context on the Dubai tape: six of the emirate''s 72 listed securities have filed a second-quarter income statement so far. Dubai Islamic Bank, much the largest of them, reported net profit of AED 1.856bn against AED 1.858bn — flat to four significant figures.'),
 (select o.id from lake.objects o where o.id = '1bb13619-091b-4c92-aede-945c5812e474'), false),

-- === 6. Explainer (free, evergreen) ========================================
('a1000000-0000-4000-a000-000000000006',1,'text',
 jsonb_build_object('text','The single most common way to be wrong about Gulf earnings is to assume that a filing labelled Q2 covers three months. Across the six venues Marsad tracks, some issuers file discrete quarters and some file cumulative year-to-date figures under the same period label. Both are permitted under IFRS interim reporting. Compared to each other without care, they manufacture growth rates that are pure artefact.'),
 null, false),
('a1000000-0000-4000-a000-000000000006',2,'heading',
 jsonb_build_object('text','How to tell the difference'), null, false),
('a1000000-0000-4000-a000-000000000006',3,'text',
 jsonb_build_object('text','The test is arithmetic and it takes one query: sum an issuer''s four filed quarters for a completed year and compare the total to its filed annual statement. If they match, the quarters are discrete. If the fourth quarter alone matches the annual, they are cumulative. Applied to the current data: National Bank of Oman''s four 2025 quarters sum to OMR 70,207,000 of net profit against a filed annual OMR 70,207,000. The Commercial Bank of Qatar''s sum to QAR 2,204,944,000 against a filed QAR 2,204,944,000. Dubai Islamic Bank''s sum to AED 7,500,278,000 against a filed AED 7,500,278,000. Three venues, three exact reconciliations, three discrete filers.'),
 null, false),
('a1000000-0000-4000-a000-000000000006',4,'text',
 jsonb_build_object('text','The counter-example sits in the same dataset. Emirates NBD''s filed Q3 2025 income statement reports AED 19.0bn of net profit; its filed Q2 2025 statement reports AED 6.301bn and its filed Q4 2025 statement AED 5.045bn. Add the three and you get AED 30.35bn against a filed full-year AED 23.981bn. The reconciliation fails, which tells you the interim figures are cumulative, not discrete — the Q3 number is a nine-month total wearing a quarterly label. Treated as a quarter it would describe a bank that earned three times as much in three months as in the six months before. It did not; the label did.'),
 (select o.id from lake.objects o where o.id = '8cff089b-2cac-475f-85c3-383aa294b877'), false),
('a1000000-0000-4000-a000-000000000006',5,'heading',
 jsonb_build_object('text','Statement types can disagree inside one filing'), null, false),
('a1000000-0000-4000-a000-000000000006',6,'text',
 jsonb_build_object('text','It is not even consistent within a single issuer. Almarai files discrete quarterly income statements — Q1 2026 revenue SAR 6.160bn, Q2 2026 revenue SAR 5.868bn — alongside a cumulative cash flow statement. Its Q2 2026 statement of changes in equity reports profit for the period of SAR 1,368,618,000, which is exactly Q1''s SAR 732,438,000 plus Q2''s SAR 636,180,000. So the income statement is discrete and the equity and cash flow statements are half-year. A reader who takes operating cash flow of SAR 2.372bn for a quarterly number overstates it by roughly a factor of two.'),
 (select o.id from lake.objects o where o.id = '447cb561-f77d-455e-ac7a-274cffcee3d8'), false),
('a1000000-0000-4000-a000-000000000006',7,'heading',
 jsonb_build_object('text','Why the calendar matters more than usual right now'), null, false),
('a1000000-0000-4000-a000-000000000006',8,'text',
 jsonb_build_object('text','As of 26 July 2026 the second-quarter picture is 49 companies deep across a 762-security universe: 20 of 120 in Muscat, 17 of 49 in Doha, six of 72 in Dubai, four of 93 in Abu Dhabi, two of 387 in Riyadh, and none of 41 in Manama. The first quarter, by contrast, is 512 companies deep. Any cross-venue claim about "Q2 earnings season" at this date is really a claim about Qatar and Oman with a Saudi footnote — and Riyadh is 51% of the universe by count.'),
 null, false),
('a1000000-0000-4000-a000-000000000006',9,'text',
 jsonb_build_object('text','The desk rule, applied to every figure in every piece we publish: quote what the filing filed, in the currency it filed, under the period label it filed — and reconcile the period before comparing it to anything else. Where the reconciliation fails, the figure does not get published. That is why several eye-catching growth rates in this quarter''s Gulf tape do not appear anywhere in our copy.'),
 null, false),

-- === 7-10. Wires ===========================================================
('a1000000-0000-4000-a000-000000000007',1,'text',
 jsonb_build_object('text','The Commercial Bank reported Q2 2026 net profit of QAR 512.3m, down 16.0% from QAR 610.0m, on revenue up 12.4% to QAR 1.28bn. Its impairment charge rose to QAR 302.1m from QAR 172.7m.'),
 (select o.id from lake.objects o where o.id = 'c778accb-59bf-4351-aae1-e4caa1cf0523'), false),
('a1000000-0000-4000-a000-000000000008',1,'text',
 jsonb_build_object('text','Lesha Bank reported Q2 2026 net profit of QAR 75.1m, up 72.5% from QAR 43.5m, on revenue up 69.5% to QAR 211.4m. Operating profit was QAR 160.6m; total assets reached QAR 11.08bn.'),
 (select o.id from lake.objects o where o.id = '84e7fef0-5be9-4733-8ae9-f7f865940766'), false),
('a1000000-0000-4000-a000-000000000009',1,'text',
 jsonb_build_object('text','Sharjah Islamic Bank reported Q2 2026 net profit of AED 423.2m, up 11.9% from AED 378.3m, on revenue up 20.0% to AED 756.9m. Net financing income rose 28.3% to AED 490.9m. Total assets reached AED 94.55bn.'),
 (select o.id from lake.objects o where o.id = 'b37e096a-7900-4c89-9c3e-79418b70483d'), false),
('a1000000-0000-4000-a000-000000000010',1,'text',
 jsonb_build_object('text','OQ Base Industries reported Q2 2026 net profit of OMR 26.4m, up 117.6% from OMR 12.1m, on revenue up 88.7% to OMR 107.3m. The shares traded at OMR 0.237 on 26 July, up 1.3%.'),
 (select o.id from lake.objects o where o.id = '17bc5dd6-58f5-4422-a8d3-cf937fda573b'), false);

-- ---------------------------------------------------------------------------
-- 3. content_tickers — bind each piece to real securities.
-- ---------------------------------------------------------------------------
insert into public.content_tickers (content_id, security_id, is_primary) values
-- 1: Qatar banks
('a1000000-0000-4000-a000-000000000001',579,true),   -- QNBK
('a1000000-0000-4000-a000-000000000001',573,false),  -- QIBK
('a1000000-0000-4000-a000-000000000001',543,false),  -- CBQK
('a1000000-0000-4000-a000-000000000001',554,false),  -- MARK
('a1000000-0000-4000-a000-000000000001',545,false),  -- DHBK
('a1000000-0000-4000-a000-000000000001',547,false),  -- DUBK
('a1000000-0000-4000-a000-000000000001',575,false),  -- QIIK
('a1000000-0000-4000-a000-000000000001',568,false),  -- QFBQ
-- 2: Almarai
('a1000000-0000-4000-a000-000000000002',72,true),    -- 2280
-- 3: Alba
('a1000000-0000-4000-a000-000000000003',655,true),   -- ALBH
-- 4: Oman
('a1000000-0000-4000-a000-000000000004',602,true),   -- BKSB
('a1000000-0000-4000-a000-000000000004',617,false),  -- NBOB
('a1000000-0000-4000-a000-000000000004',599,false),  -- BKDB
('a1000000-0000-4000-a000-000000000004',635,false),  -- OQBI
('a1000000-0000-4000-a000-000000000004',623,false),  -- OCAI
('a1000000-0000-4000-a000-000000000004',642,false),  -- PHPC
-- 5: Dubai Taxi
('a1000000-0000-4000-a000-000000000005',506,true),   -- DTC
('a1000000-0000-4000-a000-000000000005',502,false),  -- DIB
-- 6: Explainer
('a1000000-0000-4000-a000-000000000006',72,true),    -- 2280
('a1000000-0000-4000-a000-000000000006',617,false),  -- NBOB
('a1000000-0000-4000-a000-000000000006',543,false),  -- CBQK
('a1000000-0000-4000-a000-000000000006',502,false),  -- DIB
-- 7-10: wires
('a1000000-0000-4000-a000-000000000007',543,true),   -- CBQK
('a1000000-0000-4000-a000-000000000008',568,true),   -- QFBQ
('a1000000-0000-4000-a000-000000000009',470,true),   -- SIB
('a1000000-0000-4000-a000-000000000010',635,true);   -- OQBI

-- ---------------------------------------------------------------------------
-- 4. lake.citations — the row-level claim ledger that `public.v_content_citations`
--    reads. Note the view deliberately excludes any piece that has a gated block, so
--    citations are seeded only for the free pieces (3, 4, 5, 6 and the four wires);
--    the two premium pieces still carry `content_blocks.bound_object_id` bindings.
-- ---------------------------------------------------------------------------
-- Same reason as the bindings above, but `lake.citations.object_id` is NOT NULL, so a
-- missing object cannot be softened to NULL — the row itself has to not exist. Hence
-- VALUES + `where exists` instead of a plain VALUES list: live keeps all 15 citations,
-- a fresh database keeps none, and neither fails. A citation to an object that was never
-- ingested would be a false provenance claim anyway.
insert into lake.citations (content_id, object_id, block_key, claim_text, quoted_value, cited_by, claim_key)
select v.content_id::uuid, v.object_id::uuid, v.block_key, v.claim_text, v.quoted_value,
       v.cited_by::uuid, v.claim_key
  from (values
('a1000000-0000-4000-a000-000000000003','3fef5f85-bd6b-4943-b9f9-3ec70dce7a95','b2',
 'Alba full-year 2025 revenue and net profit as filed','BHD 1,778.8m revenue / BHD 218.7m net profit',
 '00000000-0000-4000-a000-00000000d35c','albh.fy2025.income'),
('a1000000-0000-4000-a000-000000000003','0789bdd9-f12a-45ec-9164-40242c7d94ef','b6',
 'Alba last traded price, 26 July 2026','BHD 0.924',
 '00000000-0000-4000-a000-00000000d35c','albh.quote.2026-07-26'),
('a1000000-0000-4000-a000-000000000004','48f4e76a-4a53-4be6-b04b-d9d84565913f','b3',
 'Sohar International Q1 2026 revenue and net profit','OMR 87.995m revenue / OMR 26.069m net profit',
 '00000000-0000-4000-a000-00000000d35c','bksb.q1-2026.income'),
('a1000000-0000-4000-a000-000000000004','ac66526f-2ff5-4fdb-9194-20b5ef4ef709','b6',
 'Oman Cables Q2 2026 revenue, gross profit and cost of sales','OMR 95.758m revenue / OMR 10.657m gross profit',
 '00000000-0000-4000-a000-00000000d35c','ocai.q2-2026.income'),
('a1000000-0000-4000-a000-000000000004','17bc5dd6-58f5-4422-a8d3-cf937fda573b','b8',
 'OQ Base Industries last traded price, 26 July 2026','OMR 0.237 (+1.28%)',
 '00000000-0000-4000-a000-00000000d35c','oqbi.quote.2026-07-26'),
('a1000000-0000-4000-a000-000000000005','c69d453b-2e30-40aa-9408-1884c162658f','b1',
 'Dubai Taxi Q2 2026 revenue and net profit','AED 484.537m revenue / AED 10.414m net profit',
 '00000000-0000-4000-a000-00000000d35c','dtc.q2-2026.income'),
('a1000000-0000-4000-a000-000000000005','cc1c04ec-b520-46a4-bf2c-c7fbc4d7649e','b2',
 'Dubai Taxi Q1 2026 revenue and gross profit','AED 551.090m revenue / AED 99.641m gross profit',
 '00000000-0000-4000-a000-00000000d35c','dtc.q1-2026.income'),
('a1000000-0000-4000-a000-000000000005','70cd0776-b5aa-4ac0-a5f6-f20d6c928a82','b5',
 'Dubai Taxi H1 2026 operating cash flow, dividends paid and closing cash',
 'AED 242.999m CFO / AED 142.000m dividends / AED 317.590m cash',
 '00000000-0000-4000-a000-00000000d35c','dtc.h1-2026.cashflow'),
('a1000000-0000-4000-a000-000000000005','1bb13619-091b-4c92-aede-945c5812e474','b7',
 'Dubai Islamic Bank Q2 2026 net profit','AED 1,855.894m',
 '00000000-0000-4000-a000-00000000d35c','dib.q2-2026.income'),
('a1000000-0000-4000-a000-000000000006','8cff089b-2cac-475f-85c3-383aa294b877','b4',
 'Emirates NBD Q3 2025 interim net profit as filed (cumulative nine-month)','AED 19,000m',
 '00000000-0000-4000-a000-00000000d35c','enbd.q3-2025.income.cumulative'),
('a1000000-0000-4000-a000-000000000006','447cb561-f77d-455e-ac7a-274cffcee3d8','b6',
 'Almarai Q2 2026 statement of changes in equity, profit for the period','SAR 1,368,618,000',
 '00000000-0000-4000-a000-00000000d35c','2280.h1-2026.equity_change'),
('a1000000-0000-4000-a000-000000000007','c778accb-59bf-4351-aae1-e4caa1cf0523','b1',
 'The Commercial Bank Q2 2026 revenue, net profit and impairment charge',
 'QAR 1,283.418m revenue / QAR 512.278m net profit / QAR 302.058m impairment',
 '00000000-0000-4000-a000-00000000d35c','cbqk.q2-2026.income'),
('a1000000-0000-4000-a000-000000000008','84e7fef0-5be9-4733-8ae9-f7f865940766','b1',
 'Lesha Bank Q2 2026 revenue, net profit and operating profit',
 'QAR 211.390m revenue / QAR 75.097m net profit / QAR 160.606m operating profit',
 '00000000-0000-4000-a000-00000000d35c','qfbq.q2-2026.income'),
('a1000000-0000-4000-a000-000000000009','b37e096a-7900-4c89-9c3e-79418b70483d','b1',
 'Sharjah Islamic Bank Q2 2026 revenue, net profit and net financing income',
 'AED 756.948m revenue / AED 423.232m net profit / AED 490.865m NII',
 '00000000-0000-4000-a000-00000000d35c','sib.q2-2026.income'),
('a1000000-0000-4000-a000-000000000010','17bc5dd6-58f5-4422-a8d3-cf937fda573b','b1',
 'OQ Base Industries last traded price, 26 July 2026','OMR 0.237 (+1.28%)',
 '00000000-0000-4000-a000-00000000d35c','oqbi.quote.2026-07-26.wire')
       ) as v(content_id, object_id, block_key, claim_text, quoted_value, cited_by, claim_key)
 where exists (select 1 from lake.objects o where o.id = v.object_id::uuid);

commit;
