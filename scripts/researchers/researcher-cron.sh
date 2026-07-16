#!/bin/bash
# Marsad financials researcher — cron wrapper. Runs one chunk of the TDWL universe through the XBRL
# researcher (incremental; skips already-owned filings), advancing a persisted cursor and wrapping at the
# end. Root (needs /etc/marsad/worker.env + xvfb). Backfill = repeated firings walk the whole universe;
# steady state = each pass ships ~0 new rows until a fresh filing appears.
set -uo pipefail
# Shared lock with the gap-fill cron — both drive headful chrome; never run concurrently.
exec 9>/home/deploy/.tadawul-scrape.lock
flock -n 9 || { echo "another tadawul scrape holds the lock — skipping this fire"; exit 0; }

STATE=/home/deploy/.researcher-chunk
SIZE=${CHUNK_SIZE:-16}
START=$(cat "$STATE" 2>/dev/null || echo 0)

# Reap any leaked headful chrome / xvfb from a prior aborted run (keep the worker's chrome-headless).
pkill -9 -f "user-data-dir=/tmp/playwright" 2>/dev/null || true
pkill -9 -f "node tadawul-researcher" 2>/dev/null || true
rm -rf /tmp/playwright_chromiumdev_profile-* /tmp/.X*-lock 2>/dev/null || true

set -a; source /etc/marsad/worker.env; set +a
# CONCURRENCY parallel browsers, each on its own Geonode sticky IP (throughput via more IPs, not a higher
# per-IP rate). RUN_BUDGET_MS < the 800s SIGTERM so the run finishes + prints DONE (cursor stays correct).
export CHUNK_START="$START" CHUNK_SIZE="$SIZE" CONCURRENCY="${CONCURRENCY:-2}" RUN_BUDGET_MS="${RUN_BUDGET_MS:-680000}" PDF_ARCHIVE_MAX="${PDF_ARCHIVE_MAX:-20}"
cd /home/deploy
OUT=$(timeout 800 xvfb-run -a node tadawul-researcher.mjs 2>&1)
echo "$OUT" | grep -E "researcher —|DONE|rejected" | tail -3

# Advance by companies ACTUALLY completed (not SIZE) so a mid-chunk timeout retries the rest instead of
# skipping them. 0 completed = past the end of the universe (or a dead run) → wrap to 0.
NUM=$(echo "$OUT" | grep -oE "companies [0-9]+/[0-9]+" | tail -1 | sed -E 's#companies ([0-9]+)/.*#\1#')
if [ -z "$NUM" ] || [ "$NUM" -eq 0 ]; then echo 0 > "$STATE"; else echo $((START + NUM)) > "$STATE"; fi
echo "next chunk start: $(cat "$STATE")"
