# Marsad venue researchers

Off-band financial-statement scrapers that run on the VPS from `/home/deploy/` (not the worker CI deploy).
**TDWL** needs headed Chromium through the Geonode residential proxy (Akamai blocks `saudiexchange.sa` from
our IPs) — the platform's **only heavy proxy consumers**; see `docs/architecture/08-worker-fleet.md` §5/§6
for the fleet map, the 9 GB incident, and the event-driven redesign. **DFM** is direct-fetchable (plain
http, no WAF) so it is **Class-A: no browser, no proxy, no OOM ceiling** — a lightweight `fetch` worker.

| Script | Purpose | Persist | source_rank |
|---|---|---|---|
| `tadawul-researcher.mjs` | TDWL free XBRL path: scrape `XBRL_DOCS/*.html`, parse deterministically → `financial_statements`; archive the source HTML + statement PDFs to the `filings` bucket | XBRL objects | 10 (wins) |
| `tadawul-gapfill.mjs` | TDWL LLM path (`claude -p`, $0 via subscription): for periods XBRL doesn't cover, download `fsPdf/*.pdf`, LLM-extract → `financial_statements` | fsPdf-LLM objects | 20 (gap-fill only; a downgrade guard never overwrites XBRL) |
| `dfm-backfill.mjs` | **DFM** LLM path, **Class-A (no browser/proxy)**: per name, GET the eFsah `financial_reports` list → download the statement PDF from `feeds.dfm.ae/documents` → `claude -p` extract → `financial_statements`; catalogue the PDF in the `filings` bucket. DFM is PDF-only (no issuer XBRL), so this is its sole statements producer. | fsPdf-LLM objects | 20 |
| `scrape-guardrails.mjs` | **Shared bandwidth guardrails** the TDWL scrapers import: resource interception (abort image/font/media + trackers) + byte accounting + a hard per-run byte budget. (DFM doesn't use a browser, so it doesn't need these.) | — | — |

## Guardrails (why the proxy bill is bounded)

1. **Cadence** — `systemd` timers `marsad-{researcher,gapfill}.timer`, `OnUnitActiveSec=6h` (a throttle
   drop-in over the original 15/20 min). Financial statements are quarterly — 6 h is already generous;
   the event-driven redesign (`08 §6`) will make steady state ~free.
2. **Resource interception** — `scrape-guardrails.makeGuards().install(ctx)` blocks images/fonts/media +
   analytics/ad hosts on every context. Keeps document/script/stylesheet/xhr so the SPA renders and the
   Akamai sensor JS still clears (validated live: Aramco scrape found 17 XBRL / 21 PDF, 137 reqs blocked,
   no extra challenge). Each run logs `proxy <N>MB (blocked <k> reqs)` at DONE.
3. **Hard byte budget** — `MAX_RUN_BYTES` (MB, default 800) self-stops a run before a misconfiguration can
   burn GBs. Safety net; cadence is the real control.
4. **Incremental / skip-owned** — both skip already-`owned` storage keys / already-covered periods, so a
   steady-state pass ships ~0 rows (but still pays page-load bandwidth — the §6 redesign fixes that).
5. **Run budget** — `RUN_BUDGET_MS` + chunk cursor bound each run; a shared `flock` keeps the two from
   running concurrently.

## Config (env — all overridable, config-over-code)

`CHUNK_START/CHUNK_SIZE` (universe slice), `CONCURRENCY` (parallel sticky-IP browsers), `RUN_BUDGET_MS`,
`PDF_ARCHIVE_MAX` (researcher) / `FSPDF_MAX` (gapfill), `MAX_RUN_BYTES`, `ACQUIRE_SYMBOLS` (explicit list),
`CLAUDE_MODEL` (gapfill). Proxy + Supabase creds from `/etc/marsad/worker.env`.

## Deploy note (repo ↔ VPS)

These run on the VPS from `/home/deploy/` (the `systemd` units → `*-cron.sh` → `node *.mjs`), **not** via the
worker's CI deploy. This repo copy under `scripts/researchers/` is the canonical, reviewable version — keep
the two in sync. To deploy an edit: `scp scripts/researchers/*.mjs deploy@<vps>:/home/deploy/`. The systemd
units + cron wrappers are mirrored under `systemd/` for reference. **Follow-up (DEF-RESEARCHER-GUARDRAILS):**
point the units at `/opt/marsad/scripts/researchers/` so they track the git checkout and this manual sync goes
away.

## DFM backfill (Class-A, no browser)

`dfm-backfill.mjs` + `dfm-backfill-cron.sh` need **no** proxy/Xvfb/Chromium — just `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL` (from `worker.env`) + the `claude` CLI + `pdftotext`. The
wrapper **`unset ANTHROPIC_API_KEY`** so `claude -p` uses the $0 subscription seat (same as gapfill). Env:
`CHUNK_START/CHUNK_SIZE` (universe slice) or `ACQUIRE_SYMBOLS`, `FSPDF_MAX` (LLM extractions/run),
`EFSAH_TAKE` (list depth, default 50 ≈ 5y), `CLAUDE_MODEL`, `DFM_WINDOW_GATE=1` (steady-state filing-window
gate; off = backfill mode). Coverage-gated + resumable (skips periods already in `financial_statements`).
A ticker absent from `public.securities` is skipped + logged — see DEF-DFM-SECURITIES-RECONCILE (55→68).

## Run manually (test)

```sh
cd /home/deploy && set -a; source /etc/marsad/worker.env; set +a
# TDWL (browser):
PLAYWRIGHT_BROWSERS_PATH=/opt/marsad/.playwright \
  ACQUIRE_SYMBOLS=2222 CONCURRENCY=1 PDF_ARCHIVE_MAX=0 RUN_BUDGET_MS=150000 \
  xvfb-run -a node tadawul-researcher.mjs
# DFM (Class-A, no browser):
unset ANTHROPIC_API_KEY
ACQUIRE_SYMBOLS=EMAAR FSPDF_MAX=2 node dfm-backfill.mjs
```
