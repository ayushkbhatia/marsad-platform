# Deploy — DFM financials backfill (Class-A, no browser)

VPS: `deploy@91.99.99.85` ([[marsad-vps]]). Scripts run from `/home/deploy/`; units in
`/etc/systemd/system/`. Class-A → **no proxy, no Xvfb, no OOM ceiling, no Tadawul-lock contention** — so
none of the `systemd-run`/`MemoryHigh`/timer-stop dance the Tadawul one-shot needs applies here.

Prereqs already met: `feeds.dfm.ae` PDF host pinned (`adapters/dfm/filings.ts` v3), DFM securities
reconciled 55→72 (migration `20260716141000`, applied live). `claude` CLI + `pdftotext` are already on
the box (the Tadawul gapfill uses both).

## 1. Copy scripts + units

```sh
cd <repo>/scripts/researchers
scp dfm-backfill.mjs dfm-backfill-cron.sh deploy@91.99.99.85:/home/deploy/
scp systemd/marsad-dfm-backfill.service systemd/marsad-dfm-backfill.timer deploy@91.99.99.85:/tmp/
ssh deploy@91.99.99.85 'sudo mv /tmp/marsad-dfm-backfill.{service,timer} /etc/systemd/system/ && sudo systemctl daemon-reload'
```

## 2. Smoke-test ONE name first (proves eFsah → PDF → pdftotext → claude → DB, end-to-end)

Run the wrapper's inner script by hand as `deploy` (same user/context the gapfill's `claude`
subscription auth resolves under). `FSPDF_MAX=2` bounds it to 2 LLM calls.

```sh
ssh deploy@91.99.99.85
cd /home/deploy && set -a; source /etc/marsad/worker.env; set +a
unset ANTHROPIC_API_KEY          # $0 subscription seat, not pay-as-you-go
ACQUIRE_SYMBOLS=EMAAR FSPDF_MAX=2 node dfm-backfill.mjs
```

Expect a `DONE … | companies 1/1 | new PDFs 2 | rows >0` line. If `rows 0` with `extract: claude …`,
the seat auth isn't resolving in this shell — fix that (same as gapfill) before enabling the timer.
Verify it landed:

```sql
-- via Supabase: rows for EMAAR
select fiscal_period, statement_type, count(*) from public.financial_statements fs
  join public.securities s on s.id=fs.security_id
 where s.venue_code='DFM' and s.ticker='EMAAR' group by 1,2 order by 1 desc;
```

## 3. Enable the timer (backfill cadence — every 30 min until covered)

```sh
ssh deploy@91.99.99.85 'sudo systemctl enable --now marsad-dfm-backfill.timer'
```

The wrapper walks the DFM `status='listed'` cursor in `CHUNK_SIZE=10` slices (`.dfm-backfill-chunk`);
`FSPDF_MAX=6`/run bounds LLM spend; the period-coverage gate skips already-covered periods, so passes get
cheaper as coverage fills. ~68 equities × ~7–20 filings each — it grinds down over many fires.

## 4. Watch progress

```sh
# per-run log
ssh deploy@91.99.99.85 'sudo journalctl -u marsad-dfm-backfill -f'
# coverage climbing (via Supabase)
```
```sql
select count(distinct s.ticker) as names_with_statements,
       count(*) as statement_rows
from public.financial_statements fs
join public.securities s on s.id=fs.security_id
where s.venue_code='DFM';
```

## 5. Transition to steady-state (once coverage plateaus)

Slow the cadence to 6h and gate to filing windows — the same new-PDF diff at minimal spend:

```sh
ssh deploy@91.99.99.85 'sudo systemctl edit marsad-dfm-backfill.timer'   # OnUnitActiveSec= / =6h
ssh deploy@91.99.99.85 'sudo systemctl edit marsad-dfm-backfill.service' # [Service] Environment=DFM_WINDOW_GATE=1
ssh deploy@91.99.99.85 'sudo systemctl daemon-reload && sudo systemctl restart marsad-dfm-backfill.timer'
```

## Rollback

```sh
ssh deploy@91.99.99.85 'sudo systemctl disable --now marsad-dfm-backfill.timer'
```

Idempotent + resumable: re-enabling continues from the cursor; nothing is re-extracted (coverage gate) or
re-charged. No data cleanup needed.
