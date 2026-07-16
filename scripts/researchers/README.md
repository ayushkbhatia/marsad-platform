# Tadawul browser researchers

The two headed-Chromium scrapers that fetch **TDWL financial statements** (Akamai-blocks `saudiexchange.sa`
from our IPs, so they run a real browser through the Geonode residential proxy). They are the platform's
**only heavy proxy consumers** — see `docs/architecture/08-worker-fleet.md` for the fleet map + guardrails,
and `§5/§6` there for the 9 GB incident + the event-driven redesign spec.

| Script | Purpose | Persist | source_rank |
|---|---|---|---|
| `tadawul-researcher.mjs` | Free XBRL path: scrape `XBRL_DOCS/*.html`, parse deterministically → `financial_statements`; archive the source HTML + statement PDFs to the `filings` bucket | XBRL objects | 10 (wins) |
| `tadawul-gapfill.mjs` | LLM path (`claude -p`, $0 via subscription): for periods XBRL doesn't cover, download `fsPdf/*.pdf`, LLM-extract → `financial_statements` | fsPdf-LLM objects | 20 (gap-fill only; a downgrade guard never overwrites XBRL) |
| `scrape-guardrails.mjs` | **Shared bandwidth guardrails** both import: resource interception (abort image/font/media + trackers) + byte accounting + a hard per-run byte budget | — | — |

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

## Run manually (test)

```sh
cd /home/deploy && set -a; source /etc/marsad/worker.env; set +a
PLAYWRIGHT_BROWSERS_PATH=/opt/marsad/.playwright \
  ACQUIRE_SYMBOLS=2222 CONCURRENCY=1 PDF_ARCHIVE_MAX=0 RUN_BUDGET_MS=150000 \
  xvfb-run -a node tadawul-researcher.mjs
```
