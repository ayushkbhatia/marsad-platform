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

NUM=$(echo "$OUT" | grep -oE "companies [0-9]+/[0-9]+" | tail -1 | sed -E 's#companies ([0-9]+)/.*#\1#')
if [ -z "$NUM" ] || [ "$NUM" -eq 0 ]; then echo 0 > "$STATE"; else echo $((START + NUM)) > "$STATE"; fi
echo "next bhb-financials chunk start: $(cat "$STATE")"
