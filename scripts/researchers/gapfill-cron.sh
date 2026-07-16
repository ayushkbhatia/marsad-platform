#!/bin/bash
# Marsad financials GAP-FILL cron wrapper — the hybrid's LLM half ($0 via the Claude Code subscription).
# Serialized with the XBRL researcher on a shared flock (both use headful chrome; must not run at once).
# Walks the universe cursor, LLM-extracting fsPdf for periods XBRL didn't cover (FSPDF_MAX budget/run).
set -uo pipefail
exec 9>/home/deploy/.tadawul-scrape.lock
flock -n 9 || { echo "another tadawul scrape holds the lock — skipping this fire"; exit 0; }

# Reporting-window cadence gate (Option A) — every fire in-window, ~weekly off-season. Skips (exit 0) otherwise.
export WINDOW_STATE=/home/deploy/.scrape-window-gapfill
source /home/deploy/window-gate.sh

STATE=/home/deploy/.gapfill-chunk
SIZE=${CHUNK_SIZE:-6}
START=$(cat "$STATE" 2>/dev/null || echo 0)
pkill -9 -f "user-data-dir=/tmp/playwright" 2>/dev/null || true
pkill -9 -f "node tadawul-" 2>/dev/null || true
rm -rf /tmp/playwright_chromiumdev_profile-* /tmp/.X*-lock 2>/dev/null || true

set -a; source /etc/marsad/worker.env; set +a
export CHUNK_START="$START" CHUNK_SIZE="$SIZE" FSPDF_MAX="${FSPDF_MAX:-6}" CLAUDE_MODEL="${CLAUDE_MODEL:-sonnet}"
cd /home/deploy
OUT=$(timeout 800 xvfb-run -a node tadawul-gapfill.mjs 2>&1)
echo "$OUT" | grep -E "gapfill —|DONE" | tail -2

NUM=$(echo "$OUT" | grep -oE "companies [0-9]+/[0-9]+" | tail -1 | sed -E 's#companies ([0-9]+)/.*#\1#')
if [ -z "$NUM" ] || [ "$NUM" -eq 0 ]; then echo 0 > "$STATE"; else echo $((START + NUM)) > "$STATE"; fi
echo "next gapfill chunk start: $(cat "$STATE")"
