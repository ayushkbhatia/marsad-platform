#!/bin/bash
# Reporting-window cadence gate for the Tadawul researchers (Option A, docs/architecture/08-worker-fleet.md §6).
#
# Saudi issuers file on statutory windows: quarterlies within ~45d of Mar 31 / Jun 30 / Sep 30, annuals
# within ~90d of Dec 31. Outside those windows ~no new financial statements arrive, so a full-universe
# browser walk finds nothing and just burns proxy bytes. This gate lets the timer (fires every 6h) proceed
# only when it is worth it:
#   * IN a reporting window  -> allow every fire (6h cadence — that is when filings actually drop).
#   * OFF-season             -> allow ~weekly (a light straggler sweep), via a per-wrapper state file.
#
# Sourced by the *-cron.sh wrappers AFTER the flock. Uses `exit 0` to SKIP a fire (exits the wrapper).
# Config-over-code: WINDOW_DAYS / ANNUAL_WINDOW_DAYS / OFFSEASON_MIN_DAYS overridable via env.
: "${WINDOW_STATE:?window-gate: set WINDOW_STATE to a per-wrapper state file path}"
WINDOW_DAYS=${WINDOW_DAYS:-45}                 # Q1/Q2/Q3 window length after quarter-end
ANNUAL_WINDOW_DAYS=${ANNUAL_WINDOW_DAYS:-90}   # annual (Dec 31) window — Saudi annuals file by ~end-March
OFFSEASON_MIN_DAYS=${OFFSEASON_MIN_DAYS:-7}     # off-season: min days between runs

now=$(date -u +%s); y=$(date -u +%Y)
in_window=0
for spec in "$y-03-31:$WINDOW_DAYS" "$y-06-30:$WINDOW_DAYS" "$y-09-30:$WINDOW_DAYS" \
            "$y-12-31:$ANNUAL_WINDOW_DAYS" "$((y-1))-12-31:$ANNUAL_WINDOW_DAYS"; do
  qe=${spec%%:*}; w=${spec##*:}
  qe_e=$(date -u -d "$qe" +%s 2>/dev/null) || continue
  d=$(( (now - qe_e) / 86400 ))
  if [ "$d" -ge 0 ] && [ "$d" -le "$w" ]; then in_window=1; break; fi
done

if [ "$in_window" -ne 1 ]; then
  last=$(cat "$WINDOW_STATE" 2>/dev/null || echo 0)
  since=$(( (now - last) / 86400 ))
  if [ "$since" -lt "$OFFSEASON_MIN_DAYS" ]; then
    echo "reporting-window gate: off-season, ${since}d since last run (<${OFFSEASON_MIN_DAYS}d) — skipping this fire"
    exit 0
  fi
  echo "reporting-window gate: off-season weekly walk (${since}d since last)"
else
  echo "reporting-window gate: in reporting window — running"
fi
echo "$now" > "$WINDOW_STATE"
