#!/bin/bash
# Marsad MSX financial-report archiver cron wrapper — the cheapest researcher in the fleet.
# NO headed Chromium, NO residential proxy, NO `claude` (this lands filings only; extraction is deferred —
# DEF-MSX-STMT-EXTRACT). MSX serves everything over cold, unauthenticated HTTP, so this holds its OWN lock
# and runs concurrently with the Tadawul chrome researchers.
#
# NO window-gate here, unlike the Tadawul wrappers — deliberately. window-gate.sh grants its long
# ANNUAL_WINDOW_DAYS only to a Dec-31 year-end, which is a SAUDI assumption. MSX fiscal years vary by
# issuer (AAIC's FY ends 31 Mar), and measured over the last 5 years MSX issuers file quarterlies up to 47d
# after period-end and annuals up to 74d — with the Mar-31 annual filers landing at 63–72d. A window wide
# enough to catch those (≈85d on every quarter-end) covers ~340/365 days, i.e. it would never throttle
# anything. So the gate buys nothing here and would only risk dropping stragglers.
#
# Running every 6h unconditionally is cheap BECAUSE the skip-before-download is total: an idle run makes
# ~108 index POSTs (~5MB) and downloads nothing. That is ~21MB/day steady-state — negligible next to the
# proxy budget — and it surfaces a new filing within 6h instead of a week.
#
# INITIAL BACKFILL: the 6h timer will chew the universe a chunk at a time. To run the campaign hot instead,
# launch it detached via systemd-run (NOT nohup — nohup dies on ssh session-scope GC) with a bigger budget:
#   systemd-run --unit=msx-backfill --property=MemoryHigh=2800M \
#     /bin/bash -c 'for i in $(seq 1 9); do CHUNK_SIZE=12 ZIP_MAX=200 /home/deploy/msx-financials-cron.sh; done'
set -uo pipefail
exec 9>/home/deploy/.msx-financials.lock
flock -n 9 || { echo "another msx-financials run holds the lock — skipping this fire"; exit 0; }

STATE=/home/deploy/.msx-financials-chunk
SIZE=${CHUNK_SIZE:-12}
START=$(cat "$STATE" 2>/dev/null || echo 0)
pkill -9 -f "node msx-financials" 2>/dev/null || true

set -a; source /etc/marsad/worker.env; set +a
export CHUNK_START="$START" CHUNK_SIZE="$SIZE" ZIP_MAX="${ZIP_MAX:-40}" MSX_YEARS_BACK="${MSX_YEARS_BACK:-5}"
cd /home/deploy
OUT=$(timeout 800 node msx-financials.mjs 2>&1)
echo "$OUT" | grep -E "msx-financials —|DONE" | tail -2

# Advance the cursor by COMPANIES ACTUALLY COMPLETED (not by SIZE) so a budget/deadline stop re-enters
# where it left off. Three distinct cases — conflating them starves the tail of the universe:
#   DONE absent (killed by `timeout`/OOM before printing) -> LEAVE the cursor put and retry this chunk.
#     Resetting to 0 here would restart the universe from 'AACT' after every kill, so the companies at the
#     end of the alphabet would never be reached.
#   selected == 0 (offset ran past the end)              -> wrap to 0 for the next incremental sweep.
#   selected > 0                                          -> advance by however many completed.
LINE=$(echo "$OUT" | grep -oE "companies [0-9]+/[0-9]+" | tail -1)
DONE_N=$(echo "$LINE" | sed -nE 's#companies ([0-9]+)/([0-9]+)#\1#p')
SEL_N=$(echo "$LINE"  | sed -nE 's#companies ([0-9]+)/([0-9]+)#\2#p')
if [ -z "$LINE" ]; then
  echo "no DONE line (killed or crashed) — holding cursor at $START to retry this chunk"
elif [ "$SEL_N" -eq 0 ]; then
  echo 0 > "$STATE"   # universe exhausted -> wrap
else
  echo $((START + DONE_N)) > "$STATE"
fi
echo "next msx-financials chunk start: $(cat "$STATE" 2>/dev/null || echo 0)"
