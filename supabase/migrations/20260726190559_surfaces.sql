-- 20260726190559 — public.surfaces: the client-facing surface catalog (BRIDGE-BUILD-PLAN P0.3,
-- implementing the DDL in BRIDGE-PLAN §3).
--
-- GOVERNANCE, NOT LAYOUT. One row per client-facing *surface* (a route pattern), never one row
-- per slug: template surfaces (1k article, 1j analyst profile, the stock tabs, /wire/[slug]) get
-- exactly ONE row with kind='template'; every instance lives as a content row elsewhere
-- (content_items, securities, filings…). Layout stays in git; this table only records WHICH
-- surfaces exist and what state their data wiring is in. Nothing renders from these rows —
-- moving layout into the database is the schema-driven-UI trap (BRIDGE-PLAN §0).
--
-- Consumers: nav/sitemap generation (nav_config_live is 0 rows today), the P8.6 contract-drift
-- CI guard (assert each adapter_module still compiles against its view_model_type), and the
-- Desk authoring loop (BRIDGE-PLAN §4 phase 6).
--
-- ENUM CONVENTION: `text` + a `check (… in (…))` constraint, matching every other constrained
-- column in `public` (0713000003 securities.status, 0713000006 earnings_events.date_state, …).
-- The only real pg enums in this schema live in iam/lake. Text+check stays cheap to extend.

set search_path = '';

create table if not exists public.surfaces (
  surface_key      text primary key,
  title            text not null,
  description      text,
  route_pattern    text not null,
  route_group      text not null check (route_group in ('reader','dataroom','admin')),
  -- template = one layout, many instances (every slug is a row elsewhere, never a surfaces row).
  kind             text not null check (kind in ('index','detail','template')),
  -- NAME of the exported TS view-model contract ('NewswireData'…). The *shape* is enforced by
  -- tsc against src/lib/contracts/*; this column only cross-references it for the CI guard.
  view_model_type  text,
  adapter_module   text,
  content_model    text not null default 'none' check (content_model in ('none','content_items')),
  gating           text not null default 'public' check (gating in ('public','premium','member')),
  producer_status  text not null check (producer_status in ('live','partial','pending')),
  wire_readiness   text not null check (wire_readiness in ('ready-now','partial','blocked-producer','blocked-auth')),
  -- Link to the DEF-* row in BUILD-STATUS §7 that tracks the remaining gap.
  def_backlog_id   text,
  -- true = a real adapter is bound; false = the surface renders a sample module.
  is_live          boolean not null default false,
  registered_by    text not null default 'bridge-p0',
  registered_at    timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.surfaces is
  'Catalog of client-facing surfaces (one row per route pattern, ONE row per template). '
  'Metadata/governance only — never renders anything. BRIDGE-PLAN §3.';
comment on column public.surfaces.view_model_type is
  'Name of the exported TS contract in src/lib/contracts/*; shape enforced by tsc, not by this row.';
comment on column public.surfaces.is_live is
  'Real adapter bound (true) vs sample-module fallback (false).';

create index if not exists surfaces_route_group_idx on public.surfaces (route_group);
create index if not exists surfaces_wire_readiness_idx on public.surfaces (wire_readiness);

-- ---------------------------------------------------------------------------
-- RLS — world-readable (nav/sitemap are built from it), writes are worker/service-role only.
-- Mirrors the 0713000014_rls.sql families: `world_read` for anon+authenticated, `worker_all`
-- for the marsad_worker role.
alter table public.surfaces enable row level security;

drop policy if exists world_read on public.surfaces;
create policy world_read on public.surfaces
  for select to anon, authenticated using (true);

drop policy if exists worker_all on public.surfaces;
create policy worker_all on public.surfaces
  for all to marsad_worker using (true) with check (true);

grant select on public.surfaces to anon, authenticated;
grant select, insert, update, delete on public.surfaces to marsad_worker;

-- ---------------------------------------------------------------------------
-- Seed — one row per surface, derived from the BRIDGE-BUILD-PLAN §5 master map plus the
-- already-live routes, cross-checked against the real route tree (`find src/app -name page.tsx`
-- = 46 files → 46 rows). `is_live` is measured, not assumed: false exactly where the page.tsx
-- still imports from src/lib/data/sample/*.

insert into public.surfaces (
  surface_key, title, description, route_pattern, route_group, kind,
  view_model_type, adapter_module, content_model, gating,
  producer_status, wire_readiness, def_backlog_id, is_live
) values
-- ── Reader: front page + newswire ──────────────────────────────────────────
('ledger','The Ledger','Broadsheet front page — index rails, movers, lead story, analyst calls.','/','reader','index','LedgerData','src/lib/data/adapters/ledger.ts','content_items','public','partial','partial','DEF-LEDGER-MACRO-SOURCE',false),
('newswire','The Newswire','Real-time filings + wire feed with venue/category facets.','/wire','reader','index','NewswireData','src/lib/data/adapters/newswire.ts','content_items','public','live','ready-now','DEF-WIRE-CORPACTIONS',false),
('wire_item','Wire item','A single published WIRE content_item.','/wire/[slug]','reader','template',null,null,'content_items','public','partial','partial',null,true),

-- ── Reader: editorial ──────────────────────────────────────────────────────
('research_index','Research','Research index — section facets, featured card, article grid.','/research','reader','index','ResearchIndexData','src/lib/data/adapters/research.ts','content_items','public','partial','partial','DEF-RESEARCH-LIVE-DATA',false),
('article','Article','Article template (1k) — one layout, one content_items row per slug.','/articles/[slug]','reader','template','Article','src/lib/data/adapters/article.ts','content_items','premium','partial','partial','DEF-ARTICLE-LIVE-DATA',false),
('coverage_desk','The Coverage Desk','Analyst leaderboard, desk research strip, coverage by sector.','/analysts','reader','index','CoverageDeskData','src/lib/data/adapters/analysts.ts','content_items','public','pending','blocked-producer','DEF-ANALYSTS-LIVE-DATA',false),
('analyst_profile','Analyst profile','Analyst profile template (1j) — reads public.v_analysts_public by slug.','/analysts/[slug]','reader','template','AnalystProfile','src/lib/data/adapters/analysts.ts','none','public','pending','blocked-producer','DEF-ANALYSTS-LIVE-DATA',false),
('analyst_apply','Analyst application','Public application form writing public.analyst_applications.','/analysts/apply','reader','detail',null,null,'none','public','live','ready-now',null,true),

-- ── Reader: stock workspace (7 tabs, one template row each) ────────────────
('stock_overview','Stock overview','Quote header, key ratios, chart, peers, dividend box.','/stocks/[venue]/[ticker]','reader','template','Overview','src/lib/data/adapters/stock.ts','none','public','live','ready-now','DEF-STOCK-EDITORIAL-FIELDS',false),
('stock_chart','Stock chart','Interactive OHLCV chart tab.','/stocks/[venue]/[ticker]/chart','reader','template',null,null,'none','public','live','ready-now',null,true),
('stock_financials','Stock financials','Income/balance/cashflow tab over financial_statements.','/stocks/[venue]/[ticker]/financials','reader','template','Financials','src/lib/data/financials.ts','none','premium','partial','partial','DEF-TDWL-EPS-MAPPING',false),
('stock_filings','Filings & concalls','Per-security filings list plus concall transcripts.','/stocks/[venue]/[ticker]/filings','reader','template','FilingsConcalls','src/lib/data/adapters/stock.ts','none','public','partial','partial','DEF-STOCK-LIVE-DATA',false),
('stock_ownership','Ownership & people','Shareholding structure, top holders, board and management.','/stocks/[venue]/[ticker]/ownership','reader','template','Ownership','src/lib/data/adapters/stock.ts','none','public','pending','blocked-producer','DEF-OWNERSHIP-PRODUCER',false),
('stock_earnings','Stock earnings','Per-security earnings history and next event.','/stocks/[venue]/[ticker]/earnings','reader','template',null,null,'none','public','partial','partial','DEF-EARNINGS-REPORTDATE',true),
('stock_dividends','Stock dividends','Per-security dividend history.','/stocks/[venue]/[ticker]/dividends','reader','template',null,null,'none','public','pending','blocked-producer','DEF-DIVIDENDS-CONFIRM',true),
('stock_thesis','AI thesis','Generated investment thesis (10d) over public.ai_theses.','/stocks/[venue]/[ticker]/thesis','reader','template','AiThesis',null,'none','premium','pending','blocked-producer','DEF-THESIS-LIVE-DATA',false),

-- ── Reader: calendars ──────────────────────────────────────────────────────
('earnings_calendar','Earnings calendar','Week grid of earnings events with KPIs.','/earnings','reader','index','EarningsWeek','src/lib/data/adapters/calendars.ts','none','public','partial','partial','DEF-EARNINGS-REPORTDATE',false),
('earnings_event','Earnings event','A single earnings event detail page.','/earnings/[eventId]','reader','template',null,null,'none','public','partial','partial','DEF-ESTIMATES-AGG',true),
('dividends_calendar','Dividends calendar','Week grid of ex/pay dates plus yield leaders.','/dividends','reader','index','DividendWeek','src/lib/data/adapters/calendars.ts','none','public','pending','blocked-producer','DEF-DIVIDENDS-CONFIRM',false),

-- ── Reader: IPO ────────────────────────────────────────────────────────────
('ipo_pipeline','IPO pipeline','Pipeline stages, upcoming offers and just-listed debuts.','/ipo','reader','index','IpoPipelineData','src/lib/data/adapters/ipo.ts','none','public','pending','blocked-producer','DEF-IPO-PRODUCER',false),
('ipo_offer','IPO offer','Offer detail template — timeline, proceeds, financials.','/ipo/[offerSlug]','reader','template','IpoOfferDetail','src/lib/data/adapters/ipo.ts','none','public','pending','blocked-producer','DEF-IPO-PRODUCER',false),
('ipo_listing','IPO listing debut','Listing-day debut template — KPIs, allocation, listed peers.','/ipo/listing/[slug]','reader','template','IpoListingData','src/lib/data/adapters/ipo.ts','none','public','pending','blocked-producer','DEF-IPO-PRODUCER',false),

-- ── Reader: market data + reference ────────────────────────────────────────
('markets','Markets','Venue boards, index tape and market state.','/markets','reader','index',null,null,'none','public','live','ready-now',null,true),
('filings_index','Filings','All-venue filings index with facets.','/filings','reader','index',null,null,'none','public','live','ready-now',null,true),
('filing_detail','Filing','A single filing with its AI summary when present.','/filings/[filingId]','reader','template',null,null,'none','public','live','ready-now',null,true),
('search','Search','Full-text search over securities and filings.','/search','reader','index',null,null,'none','public','partial','partial','DEF-SEARCH-CONTENT-ITEMS',true),
('compare','Compare','Side-by-side comparison of securities on public ratios.','/compare','reader','index',null,null,'none','public','live','ready-now',null,true),
('datapoint_series','Datapoint series','A public datapoint_series time series.','/datapoints/[seriesId]','reader','template',null,null,'none','public','live','ready-now',null,true),
('investors_index','Investors','Investor/institution index.','/investors','reader','index',null,null,'none','public','partial','partial',null,true),
('investor_detail','Investor','A single investor profile.','/investors/[slug]','reader','template',null,null,'none','public','partial','partial',null,true),
('learn_index','Learn','Explainer and methodology library index.','/learn','reader','index',null,null,'none','public','live','ready-now',null,true),
('learn_doc','Learn doc','A single explainer/methodology document.','/learn/[docSlug]','reader','template',null,null,'none','public','live','ready-now',null,true),

-- ── Reader: member surfaces (blocked on auth, D-2/O-3) ─────────────────────
('watchlist','Watchlist','Per-user watchlists with quote/score columns.','/watchlist','reader','index','WatchlistData',null,'none','member','pending','blocked-auth','DEF-WATCHLIST-LIVE-DATA',false),
('alerts','Alerts','Per-user price, screen and phrase alerts.','/alerts','reader','index','AlertsData',null,'none','member','pending','blocked-auth','DEF-ALERTS-LIVE-DATA',false),
('two_factor','Two-factor settings','TOTP enrolment against auth.mfa_factors.','/settings/two-factor','reader','detail',null,null,'none','member','pending','blocked-auth','DEF-AUTH-GROUP',false),

-- ── Data room ──────────────────────────────────────────────────────────────
('heatmap','Sector heatmap','Sector/venue performance heatmap.','/heatmap','dataroom','index',null,null,'none','public','live','ready-now',null,true),
('screener','Screener','Multi-factor equity screener.','/screener','dataroom','index',null,null,'none','public','live','ready-now',null,true),
('screens_index','Saved screens','Saved and shared screen library.','/screens','dataroom','index',null,null,'none','public','live','ready-now',null,true),
('screen_detail','Screen','A single saved screen and its latest run.','/screens/[screenId]','dataroom','template',null,null,'none','public','live','ready-now',null,true),

-- ── Admin / internal ───────────────────────────────────────────────────────
('admin_home','Admin','Internal desk home.','/admin','admin','index',null,null,'none','member','live','ready-now',null,true),
('admin_agents','Agent fleet','iam.agent_accounts status board.','/admin/agents','admin','index',null,null,'none','member','live','ready-now',null,true),
('admin_approvals','Approvals desk','Newsroom approval queue.','/admin/approvals','admin','index',null,null,'none','member','live','ready-now',null,true),
('admin_approval_detail','Approval','A single approval item with its draft and rule violations.','/admin/approvals/[id]','admin','template',null,null,'none','member','live','ready-now',null,true),
('admin_lake','Lake','lake.objects browser.','/admin/lake','admin','index',null,null,'none','member','live','ready-now',null,true),
('admin_ops','Ops','ops.* job, incident and budget dashboards.','/admin/ops','admin','index',null,null,'none','member','live','ready-now',null,true),
('styleguide','Styleguide','Internal design-system reference; intentionally unlinked from nav.','/styleguide','admin','index',null,null,'none','public','live','ready-now',null,true)
on conflict (surface_key) do nothing;
