#!/bin/bash
# Marsad QE financials researcher — cron wrapper. Runs one chunk of the QE universe through the
# XBRL-native researcher (incremental; skips already-owned periods/PDFs), advancing a persisted
# cursor and wrapping at the end. Backfill = repeated firings walk the whole ~54-company universe;
# steady state = each pass ships ~0 new rows until a fresh filing appears.
#
# Unlike the Tadawul/ADX researchers this is PLAIN HTTP — no xvfb, no headful chrome, no proxy, no
# shared browser lock. It still takes its own lock so two fires can never overlap on the same cursor.
set -uo pipefail

exec 9>/home/deploy/.qe-financials.lock
flock -n 9 || { echo "another qe-financials run holds the lock — skipping this fire"; exit 0; }

# Two modes, mirroring dfm-backfill-cron.sh:
#   BACKFILL (default, QE_WINDOW_GATE=0): no gate — every fire runs, walking the cursor through the
#                                         universe until coverage is in.
#   STEADY   (QE_WINDOW_GATE=1):          gate to filing windows — every fire in-window, ~weekly
#                                         off-season. THIS is the owner's "check weekly for new PDFs".
# Flip via a systemd drop-in once the backfill has wrapped; the timer interval need not change.
if [ "${QE_WINDOW_GATE:-0}" = "1" ]; then
  # NOTE: window-gate.sh defaults are Saudi-calibrated (WINDOW_DAYS=45, ANNUAL_WINDOW_DAYS=90 —
  # its comment says "Saudi annuals file by ~end-March"). Qatar/QFMA deadlines need confirming; both
  # are env-overridable, so tune HERE rather than editing the shared gate. Tracked in
  # DEF-QE-FINANCIALS. Qatari issuers file on the same calendar quarter-ends, so the quarterly
  # window is a reasonable default in the meantime.
  export WINDOW_STATE=/home/deploy/.scrape-window-qe
  source /home/deploy/window-gate.sh
fi

STATE=/home/deploy/.qe-financials-chunk
SIZE=${CHUNK_SIZE:-16}
START=$(cat "$STATE" 2>/dev/null || echo 0)

pkill -9 -f "node qe-financials" 2>/dev/null || true

set -a; source /etc/marsad/worker.env; set +a
# ⚠ www.qe.com.qa also serves the LIVE quote board (source id 10). Concurrency stays low and requests
# are paced (QE_RPS_MS) so a backfill can never get the origin to throttle the quote feed. The timer
# is scheduled outside the 09:30–13:15 Asia/Qatar session for the same reason.
# RUN_BUDGET_MS < the 800s SIGTERM so the run self-terminates and prints DONE (cursor stays correct).
export CHUNK_START="$START" CHUNK_SIZE="$SIZE" \
       CONCURRENCY="${CONCURRENCY:-3}" \
       RUN_BUDGET_MS="${RUN_BUDGET_MS:-680000}" \
       QE_RPS_MS="${QE_RPS_MS:-1000}" \
       QE_DOC_MAX="${QE_DOC_MAX:-40}" \
       QE_MIN_YEAR="${QE_MIN_YEAR:-2020}"
cd /home/deploy
OUT=$(timeout 800 node qe-financials.mjs 2>&1)
echo "$OUT" | grep -E "qe-financials —|DONE|rejected|!!" | tail -4

# Advance by companies ACTUALLY completed (not SIZE) so a mid-chunk timeout retries the rest instead
# of skipping them. 0 completed = past the end of the universe, a dead run, or a transport abort
# (the researcher reports 0 on purpose in that case) → wrap to 0 and re-walk rather than record
# progress over periods we never fetched.
NUM=$(echo "$OUT" | grep -oE "companies [0-9]+/[0-9]+" | tail -1 | sed -E 's#companies ([0-9]+)/.*#\1#')
if [ -z "$NUM" ] || [ "$NUM" -eq 0 ]; then echo 0 > "$STATE"; else echo $((START + NUM)) > "$STATE"; fi
echo "next chunk start: $(cat "$STATE")"
