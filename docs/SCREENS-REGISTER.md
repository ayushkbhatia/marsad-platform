# Marsad — Screens Register

_The running ledger of every design screen shared → its route, build status, and the schema
tables that feed it. This is the human-readable precursor to the `public.surfaces` catalog
(see `BRIDGE-PLAN.md` §3). Update this row-by-row as screens are shared, built, and wired._

**Status legend:** `pixel-sample` → `pixel-sample` (built pixel-perfect, sample-seeded) →
`partial-wired` → `live` (real adapter bound). **Wire-readiness** per `BRIDGE-PLAN.md` §2.

## Reader surfaces

| ID | Screen | Route | Status | Feeds (schema) | Sample module / DEF | Wire-readiness |
|----|--------|-------|--------|----------------|---------------------|----------------|
| 1b | Ledger / Today (home) | `/` | pixel-sample | `content_items`, `index_levels`, `mv_movers`, `quotes_latest`, `filings` | `sample/ledger.ts` · DEF-LEDGER-LIVE-DATA | partial |
| 1d | Newswire | `/wire` | pixel-sample | `filings` (ready), `dividends` (broken), `score_events_feed`, analytics (none) | `sample/newswire.ts` · DEF-NEWSWIRE-LIVE-DATA | partial (core feed only) |
| 1h | Watchlist | `/watchlist` | pixel-sample | `quotes_latest`, `v_scores_public` + per-user `watchlists`/`alerts`/`notes` (empty) | `sample/watchlist.ts` · DEF-WATCHLIST-LIVE-DATA | blocked-producer + blocked-auth |
| 1l | Research index | `/research` | pixel-sample | `content_items` (1 live) | `sample/research.ts` · DEF-RESEARCH-LIVE-DATA | partial |
| 1k | Article (template) | `/articles/[slug]` | pixel-sample | `content_items` + `content_blocks` (RLS free/premium) | `sample/research.ts` · DEF-RESEARCH-LIVE-DATA | partial (premium cut needs auth) |
| 1i | Coverage Desk | `/analysts` | pixel-sample | `analysts` (0), `analyst_calls` (0); `v_scores_public` for a scores view | `sample/analysts.ts` · DEF-ANALYSTS-LIVE-DATA | blocked-producer |
| 1j | Analyst Profile (template) | `/analysts/[slug]` | pixel-sample | `analysts` — **no slug/display_name column** (migration needed) | `sample/analysts.ts` · DEF-ANALYSTS-LIVE-DATA | hard-blocked |
| 3a | Stock — Overview | `/stocks/[venue]/[ticker]` | pixel-sample | `securities`, `quotes_latest`, `ohlcv_daily`, `v_key_ratios_public`, `v_scores_public`, peers | `sample/stock.ts` · DEF-STOCK-LIVE-DATA | mostly-ready (financials gated) |
| 3b | Stock — Financials | `/stocks/[venue]/[ticker]/financials` | pixel-sample | `financial_statements` (51k, worker-only → premium/service-role) | ″ | partial (premium/anon-gated) |
| 3c | Stock — Filings & Concalls | `/stocks/[venue]/[ticker]/filings` | pixel-sample | `filings` (ready), `transcripts` (0), `content_items` | ″ | partial (concalls empty) |
| 3d | Stock — Ownership & People | `/stocks/[venue]/[ticker]/ownership` | pixel-sample | `holders`/`ownership_snapshots`/`company_people` (all 0) | ″ | blocked-producer |

_Prior wave-1/2 stock tabs (chart, dividends, earnings) already read real data; being folded
into the 3a–3d pixel pass._

## Reader surfaces already reading real data (wave-1/2, not yet pixel-audited to a 3x design)

`/markets`, `/screener`, `/heatmap`, `/earnings`, `/dividends`, `/ipo`, `/filings`, `/learn`,
`/compare`, `/search`, `/investors`, `/datapoints` — status varies; revisit when their
design screens are shared.

## Admin / Desk surfaces

_(none shared yet — user has flagged more admin-level screens are coming)_

---
_Every new screen the owner shares gets a row here first (`pixel-sample`), then flows
through the pixel-sample → wired lifecycle. This register is mirrored by `public.surfaces`
once that catalog lands (BRIDGE-PLAN Phase 0)._
