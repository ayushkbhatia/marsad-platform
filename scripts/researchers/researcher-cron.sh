#!/bin/bash
# Marsad financials researcher — cron wrapper. Runs one chunk of the TDWL universe through the XBRL
# researcher (incremental; skips already-owned filings), advancing a persisted cursor and wrapping at the
# end. Root (needs /etc/marsad/worker.env + xvfb). Backfill = repeated firings walk the whole universe;
# steady state = each pass ships ~0 new rows until a fresh filing appears.
set -uo pipefail
# Shared lock with the gap-fill cron — both drive headful chrome; never run concurrently.
exec 9>/home/deploy/.tadawul-scrape.lock
flock -n 9 || { echo "another tadawul scrape holds the lock — skipping this fire"; exit 0; }

# Reporting-window cadence gate (Option A) — every fire in-window, ~weekly off-season. Skips (exit 0) otherwise.
export WINDOW_STATE=/home/deploy/.scrape-window-researcher
source /home/deploy/window-gate.sh

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

# Advance the cursor by companies ACTUALLY completed so a mid-chunk timeout retries the rest.
# Parse BOTH counts from "companies <done>/<fetched>" and split three end states. The old code treated
# ANY "0 completed" as end-of-universe and wrapped to 0 — so a transient browser/proxy failure (0
# processed) silently reset the cursor and wedged the whole walk at offset 0 (observed 2026-07-18 when
# the Geonode proxy went down: every run 0/16 → cursor pinned at 0, never reaching the uncovered tail).
#   fetched == 0           -> past end of universe       -> wrap to 0 (rescan from top next fire)
#   fetched > 0, done == 0 -> run failed (proxy/nav down) -> HOLD cursor, retry same offset
#   done > 0               -> real progress              -> advance by done
STATS=$(echo "$OUT" | grep -oE "companies [0-9]+/[0-9]+" | tail -1)
DONE_N=$(echo "$STATS" | sed -E 's#companies ([0-9]+)/([0-9]+)#\1#')
FETCH_N=$(echo "$STATS" | sed -E 's#companies ([0-9]+)/([0-9]+)#\2#')
if [ -z "$STATS" ]; then
  echo "$START" > "$STATE"; echo "no DONE line (crashed run) - holding cursor at $START"
elif [ "$FETCH_N" -eq 0 ]; then
  echo 0 > "$STATE"; echo "end of universe - wrapping cursor to 0"
elif [ "$DONE_N" -eq 0 ]; then
  echo "$START" > "$STATE"; echo "0 companies processed (proxy/nav failure) - holding cursor at $START"
else
  echo $((START + DONE_N)) > "$STATE"
fi
echo "next chunk start: $(cat "$STATE")"
