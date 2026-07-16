#!/bin/bash
# Marsad DFM financials BACKFILL cron wrapper — Class-A ($0 via the Claude Code subscription).
#
# Unlike the Tadawul wrappers this is browser-free: DFM is direct-fetchable (no headed Chromium, no
# Geonode proxy, no Xvfb, no OOM ceiling), so there is nothing to reap and no shared-chrome serialization
# with the Tadawul fleet. It still takes its OWN lock so two DFM fires never overlap.
#
# Modes (same script, two schedules):
#   BACKFILL  (default): no reporting-window gate — every fire walks the cursor and the PERIOD-coverage
#             gate inside dfm-backfill.mjs self-limits work (covered periods are skipped, ~0 LLM spend
#             once a name is done). Run frequently until the universe is covered.
#   STEADY    (DFM_WINDOW_GATE=1): gate to filing windows (in-window every fire, ~weekly off-season) once
#             backfill is complete — same new-PDF diff, minimal spend.
set -uo pipefail
exec 9>/home/deploy/.dfm-scrape.lock
flock -n 9 || { echo "another dfm scrape holds the lock — skipping this fire"; exit 0; }

if [ "${DFM_WINDOW_GATE:-0}" = "1" ]; then
  # UAE issuers file on calendar quarters (same quarter-ends as Saudi); tune ANNUAL_WINDOW_DAYS for the
  # UAE annual deadline if it differs. window-gate.sh exits 0 (skip) outside the window.
  export WINDOW_STATE=/home/deploy/.scrape-window-dfm
  source /home/deploy/window-gate.sh
fi

STATE=/home/deploy/.dfm-backfill-chunk
SIZE=${CHUNK_SIZE:-10}
START=$(cat "$STATE" 2>/dev/null || echo 0)

set -a; source /etc/marsad/worker.env; set +a
# worker.env carries ANTHROPIC_API_KEY for the platform's own LLM gateway. `claude -p` prefers that env
# var over the OAuth subscription login if present, silently billing pay-as-you-go instead of the $0
# subscription seat. Unset it so the spawned `claude` CLI falls back to the subscription auth.
unset ANTHROPIC_API_KEY
export CHUNK_START="$START" CHUNK_SIZE="$SIZE" FSPDF_MAX="${FSPDF_MAX:-6}" CLAUDE_MODEL="${CLAUDE_MODEL:-sonnet}"
cd /home/deploy
OUT=$(timeout 800 node dfm-backfill.mjs 2>&1)
echo "$OUT" | grep -E "dfm-backfill —|DONE" | tail -2

NUM=$(echo "$OUT" | grep -oE "companies [0-9]+/[0-9]+" | tail -1 | sed -E 's#companies ([0-9]+)/.*#\1#')
if [ -z "$NUM" ] || [ "$NUM" -eq 0 ]; then echo 0 > "$STATE"; else echo $((START + NUM)) > "$STATE"; fi
echo "next dfm-backfill chunk start: $(cat "$STATE")"
