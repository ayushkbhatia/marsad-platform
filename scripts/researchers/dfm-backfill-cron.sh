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
SIZE=${CHUNK_SIZE:-12}
START=$(cat "$STATE" 2>/dev/null || echo 0)

set -a; source /etc/marsad/worker.env; set +a
# worker.env carries ANTHROPIC_API_KEY for the platform's own LLM gateway. `claude -p` prefers that env
# var over the OAuth subscription login if present, silently billing pay-as-you-go instead of the $0
# subscription seat. Unset it so the spawned `claude` CLI falls back to the subscription auth.
unset ANTHROPIC_API_KEY
# Parallel first-pass: CONCURRENCY claude extractions at once, FSPDF_MAX global budget/run, RUN_BUDGET_MS
# self-stop (~16.7 min) well inside the `timeout` below so the DONE line always prints (no cursor reset).
export CHUNK_START="$START" CHUNK_SIZE="$SIZE" \
       FSPDF_MAX="${FSPDF_MAX:-48}" CONCURRENCY="${CONCURRENCY:-3}" RUN_BUDGET_MS="${RUN_BUDGET_MS:-1000000}" \
       CLAUDE_MODEL="${CLAUDE_MODEL:-sonnet}"
cd /home/deploy
OUT=$(timeout 1300 node dfm-backfill.mjs 2>&1)
echo "$OUT" | grep -E "dfm-backfill —|DONE" | tail -2

# Advance by companies ACTUALLY completed; split three end states so a transient failure (0 processed)
# holds position instead of resetting to 0 (the old "any 0 -> wrap" wedged the walk — see researcher-cron.sh).
STATS=$(echo "$OUT" | grep -oE "companies [0-9]+/[0-9]+" | tail -1)
DONE_N=$(echo "$STATS" | sed -E 's#companies ([0-9]+)/([0-9]+)#\1#')
FETCH_N=$(echo "$STATS" | sed -E 's#companies ([0-9]+)/([0-9]+)#\2#')
if [ -z "$STATS" ]; then echo "$START" > "$STATE"; echo "no DONE line (crashed run) - holding cursor at $START"
elif [ "$FETCH_N" -eq 0 ]; then echo 0 > "$STATE"; echo "end of universe - wrapping cursor to 0"
elif [ "$DONE_N" -eq 0 ]; then echo "$START" > "$STATE"; echo "0 companies processed (fetch/nav failure) - holding cursor at $START"
else echo $((START + DONE_N)) > "$STATE"; fi
echo "next dfm-backfill chunk start: $(cat "$STATE")"
