#!/bin/bash
# adx-oneshot.sh — ONE-SHOT full first-pass over the whole ADX universe (financial-statement PDFs).
#
# Purpose: temporarily bypass the 6h reporting-window cadence to get first-pass coverage of every listed
# ADX stock — WITH depth capped to the last ~5 fiscal years (ADX_MIN_YEAR=Y-4, ADX_PDF_MAX high), not the 6/run
# steady-state cap. The symbol list is enumerated from the DB at runtime (LIST_SYMBOLS mode) so it never
# goes stale. Resumable: each PDF is extract-once (exPara owned marker), so a crash/kill mid-run is safe.
#
# LOCK: holds .adx-scrape.lock so the scheduled 6h adx-gapfill fires skip while this runs.
# NO PROXY / NO XVFB: ADX loads headless from the datacenter VPS (docs/architecture/adx-browser-bypass.md §1),
#   so there is no metered-proxy bandwidth to budget (contrast tadawul-oneshot ~5.5 GB). Only the statement
#   PDFs (~1-3 MB each) transit — direct, unmetered.
# MEMORY: one headless Chromium + PDF/text buffers + a `claude -p` subprocess. Lighter than the TDWL browser,
#   but still launch under a systemd MemoryHigh cap on the 3.8 GB box so it spills to swap, never OOM-kills
#   the co-resident marsad-worker.
#
# Run:   systemd-run --unit=adx-oneshot --collect --property=MemoryHigh=2800M \
#            /bin/bash /home/deploy/adx-oneshot.sh
#          DO NOT use `nohup … &` — it stays in the launching ssh session's scope and gets GC-killed when
#          that session closes. systemd-run runs it as a transient unit that outlives every ssh session.
# Watch: journalctl -u adx-oneshot -f
# Stop:  systemctl stop adx-oneshot   (then pkill -f 'node adx-gapfill' to reap the browser)
#        While it runs, stop marsad-adx-gapfill.timer so no scheduled job races the .adx-scrape.lock;
#        re-start it when the one-shot completes.

set -uo pipefail
exec 9>/home/deploy/.adx-scrape.lock
flock -n 9 || { echo "scrape lock held by another run — abort"; exit 1; }
set -a; source /etc/marsad/worker.env; set +a
unset ANTHROPIC_API_KEY                     # force the $0 subscription seat (see gapfill-cron.sh)
export PLAYWRIGHT_BROWSERS_PATH=/opt/marsad/.playwright
# Depth cap: keep only statements published in the last ~5 fiscal years (Y-4). Overridable; set
# ADX_MIN_YEAR=0 for full history. Caps LLM calls per company sharply (deep filers have 8-10y of quarterlies).
export ADX_MIN_YEAR="${ADX_MIN_YEAR:-$(( $(date -u +%Y) - 4 ))}"
cd /home/deploy

# Enumerate all listed ADX tickers from the DB (never a hardcoded list — ~93 names, drifts with listings).
SYMS=$(LIST_SYMBOLS=1 node adx-gapfill.mjs)
IFS=',' read -ra ALL <<< "$SYMS"
CHUNK=${CHUNK:-15}                          # companies per node run (extract-once owned-marker checkpoints per PDF)
n=${#ALL[@]}
[ "$n" -eq 0 ] && { echo "no ADX symbols enumerated — abort"; exit 1; }
echo "ADX ONE-SHOT start $(date -u '+%Y-%m-%d %H:%M UTC') — $n listed ADX names, chunk=$CHUNK, statements ≥ ${ADX_MIN_YEAR}"
for ((i=0; i<n; i+=CHUNK)); do
  SLICE=$(IFS=,; echo "${ALL[*]:i:CHUNK}")
  end=$(( i+CHUNK<n ? i+CHUNK : n ))
  echo "=== $(date -u '+%H:%M') chunk $((i/CHUNK+1))/$(( (n+CHUNK-1)/CHUNK )) [names $((i+1))-$end] ==="
  # ADX_PDF_MAX high = full-history depth per company (no per-run steady-state cap).
  OUT=$(ACQUIRE_SYMBOLS="$SLICE" ADX_PDF_MAX=500 node adx-gapfill.mjs 2>&1)
  echo "$OUT" | grep -E "adx-gapfill —|DONE|efid|extract:" | tail -6
done
echo "ADX ONE-SHOT COMPLETE $(date -u '+%Y-%m-%d %H:%M UTC')"
