#!/bin/bash
# Marsad ADX financials BACKFILL cron wrapper — the document→extract half for Abu Dhabi ($0 via the Claude
# Code subscription). ADX has no XBRL, so this is the ONLY financials path for ADX (all rank 20).
#
# Unlike the TDWL researchers this needs NO metered proxy and NO xvfb: ADX loads headless from the datacenter
# VPS (docs/architecture/adx-browser-bypass.md §1). Serialized with the other ADX scrape on a dedicated
# flock. Walks the ADX universe cursor, LLM-extracting statement PDFs (ADX_PDF_MAX budget/run).
set -uo pipefail
exec 9>/home/deploy/.adx-scrape.lock
flock -n 9 || { echo "another adx scrape holds the lock — skipping this fire"; exit 0; }

# Reporting-window cadence gate — every fire in-window, ~weekly off-season. UAE issuers file quarterlies
# within ~45-60d of quarter-end and annuals within ~120d of Dec 31 (later than Saudi). Skips (exit 0) otherwise.
export WINDOW_STATE=/home/deploy/.scrape-window-adx-gapfill
export WINDOW_DAYS=${WINDOW_DAYS:-60} ANNUAL_WINDOW_DAYS=${ANNUAL_WINDOW_DAYS:-120}
source /home/deploy/window-gate.sh

STATE=/home/deploy/.adx-gapfill-chunk
SIZE=${CHUNK_SIZE:-6}
START=$(cat "$STATE" 2>/dev/null || echo 0)
pkill -9 -f "user-data-dir=/tmp/playwright" 2>/dev/null || true
pkill -9 -f "node adx-gapfill" 2>/dev/null || true
rm -rf /tmp/playwright_chromiumdev_profile-* 2>/dev/null || true

set -a; source /etc/marsad/worker.env; set +a
# worker.env carries ANTHROPIC_API_KEY for the platform's own LLM gateway. `claude -p` below prefers that
# env var over the OAuth subscription login if present, silently billing pay-as-you-go instead of the $0
# subscription seat. Unset it so the spawned `claude` CLI falls back to the subscription auth.
unset ANTHROPIC_API_KEY
export CHUNK_START="$START" CHUNK_SIZE="$SIZE" ADX_PDF_MAX="${ADX_PDF_MAX:-6}" CLAUDE_MODEL="${CLAUDE_MODEL:-haiku}"
cd /home/deploy
OUT=$(timeout 800 node adx-gapfill.mjs 2>&1)
echo "$OUT" | grep -E "adx-gapfill —|DONE" | tail -2

# Advance by companies ACTUALLY completed; split three end states so a transient failure (0 processed)
# holds position instead of resetting to 0 (the old "any 0 -> wrap" wedged the walk — see researcher-cron.sh).
STATS=$(echo "$OUT" | grep -oE "companies [0-9]+/[0-9]+" | tail -1)
DONE_N=$(echo "$STATS" | sed -E 's#companies ([0-9]+)/([0-9]+)#\1#')
FETCH_N=$(echo "$STATS" | sed -E 's#companies ([0-9]+)/([0-9]+)#\2#')
if [ -z "$STATS" ]; then echo "$START" > "$STATE"; echo "no DONE line (crashed run) - holding cursor at $START"
elif [ "$FETCH_N" -eq 0 ]; then echo 0 > "$STATE"; echo "end of universe - wrapping cursor to 0"
elif [ "$DONE_N" -eq 0 ]; then echo "$START" > "$STATE"; echo "0 companies processed (fetch/nav failure) - holding cursor at $START"
else echo $((START + DONE_N)) > "$STATE"; fi
echo "next adx-gapfill chunk start: $(cat "$STATE")"
