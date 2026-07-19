#!/bin/bash
# Marsad BHB financials backfill cron wrapper — the cheap-HTTP statements researcher ($0 via the Claude
# Code subscription). NO headed Chromium, NO residential proxy (BHB is direct http), so it does NOT share
# the Tadawul chrome flock — it holds its OWN lock and can run concurrently with the Tadawul researchers.
# Walks the BHB universe cursor, LLM-extracting new statement PDFs (FSPDF_MAX budget/run).
set -uo pipefail
exec 9>/home/deploy/.bhb-financials.lock
flock -n 9 || { echo "another bhb-financials run holds the lock — skipping this fire"; exit 0; }

STATE=/home/deploy/.bhb-financials-chunk
SIZE=${CHUNK_SIZE:-8}
START=$(cat "$STATE" 2>/dev/null || echo 0)
pkill -9 -f "node bhb-financials" 2>/dev/null || true

set -a; source /etc/marsad/worker.env; set +a
# worker.env carries ANTHROPIC_API_KEY for the platform's own LLM gateway (a separate concern). The
# spawned `claude -p` prefers that env var over the OAuth subscription login if present — silently billing
# pay-as-you-go credits. Unset it so `claude` falls back to the $0 subscription seat (same as gapfill-cron).
unset ANTHROPIC_API_KEY
export CHUNK_START="$START" CHUNK_SIZE="$SIZE" FSPDF_MAX="${FSPDF_MAX:-6}" CLAUDE_MODEL="${CLAUDE_MODEL:-sonnet}"
cd /home/deploy
OUT=$(timeout 800 node bhb-financials.mjs 2>&1)
echo "$OUT" | grep -E "bhb-financials —|DONE" | tail -2

# Advance by companies ACTUALLY completed; split three end states so a transient failure (0 processed)
# holds position instead of resetting to 0 (the old "any 0 -> wrap" wedged the walk — see researcher-cron.sh).
STATS=$(echo "$OUT" | grep -oE "companies [0-9]+/[0-9]+" | tail -1)
DONE_N=$(echo "$STATS" | sed -E 's#companies ([0-9]+)/([0-9]+)#\1#')
FETCH_N=$(echo "$STATS" | sed -E 's#companies ([0-9]+)/([0-9]+)#\2#')
if [ -z "$STATS" ]; then echo "$START" > "$STATE"; echo "no DONE line (crashed run) - holding cursor at $START"
elif [ "$FETCH_N" -eq 0 ]; then echo 0 > "$STATE"; echo "end of universe - wrapping cursor to 0"
elif [ "$DONE_N" -eq 0 ]; then echo "$START" > "$STATE"; echo "0 companies processed (fetch/nav failure) - holding cursor at $START"
else echo $((START + DONE_N)) > "$STATE"; fi
echo "next bhb-financials chunk start: $(cat "$STATE")"
