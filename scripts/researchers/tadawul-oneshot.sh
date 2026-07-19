#!/bin/bash
# tadawul-oneshot.sh — ONE-SHOT full first-pass over the UNCOVERED TDWL universe (financial_statements).
#
# Purpose: temporarily bypass the 6h reporting-window cadence to get first-pass coverage of every TDWL
# stock that has no financial_statements yet — WITH full 5-year PDF depth (archives all listed statement
# PDFs, not the 20/run steady-state cap). Uncovered-only, so it never re-loads the ~130 already-covered
# names. Runs the XBRL researcher; the pre-XBRL / PDF-only long tail (e.g. Nomu names that file no XBRL)
# is left for the gapfill/LLM path per the owner's "gaps later" call.
#
# RESUMABLE: the researcher skips already-owned docs, so a crash/kill mid-run is safe — re-run continues.
# LOCK: holds .tadawul-scrape.lock so the scheduled 6h researcher/gapfill fires skip while this runs.
# BANDWIDTH: ~5.5 GB total through the metered proxy (calibrated ~21 MB/company incl. full 5y PDF, conc 2). Top up.
# MEMORY:   the 3.8 GB VPS is memory-tight. CONCURRENCY=4 OOM-killed a run ~10 min in (4 headed Chromium + PDF
#            buffers). MUST launch with CONCURRENCY=2, a swapfile present (/swapfile, 4 GB), and a systemd
#            MemoryHigh cap so the one-shot's cgroup reclaims/spills to swap instead of OOM-killing the
#            co-resident marsad-worker. Do NOT raise CONCURRENCY on this box without adding RAM.
#
# Run:   systemd-run --unit=tadawul-oneshot --collect --setenv=CONCURRENCY=2 --property=MemoryHigh=2800M \
#            /bin/bash /home/deploy/tadawul-oneshot.sh
#          DO NOT use `nohup … &` — it stays in the launching ssh session's systemd scope and gets GC-killed
#          when that session closes. systemd-run runs it as a transient unit that outlives every ssh session.
# Watch: journalctl -u tadawul-oneshot -f
# Stop:  systemctl stop tadawul-oneshot   (then pkill -f 'node tadawul-researcher' to reap browsers)
#        While it runs, stop marsad-gapfill.timer + marsad-researcher.timer so no scheduled job races the
#        .tadawul-scrape.lock; re-start both timers when the one-shot completes.

set -uo pipefail
exec 9>/home/deploy/.tadawul-scrape.lock
flock -n 9 || { echo "scrape lock held by another run — abort"; exit 1; }
set -a; source /etc/marsad/worker.env; set +a
export PLAYWRIGHT_BROWSERS_PATH=/opt/marsad/.playwright
cd /home/deploy

# Reap leaked headful chrome / xvfb / X-locks (the 6h cron wrapper does this; the one-shot MUST too, else a
# stale /tmp/.X*-lock makes each chunk's `xvfb-run` collide → node exits before it navigates: 0 proxy bytes,
# 0 rows, whole one-shot finishes in seconds — observed 2026-07-19). Only the worker's headless-shell stays.
reap() { pkill -9 -f "user-data-dir=/tmp/playwright" 2>/dev/null || true; rm -rf /tmp/playwright_chromiumdev_profile-* /tmp/.X*-lock 2>/dev/null || true; }
pkill -9 -f "node tadawul-researcher" 2>/dev/null || true; reap

# 164 uncovered TDWL listed tickers as of 2026-07-19 (regenerated from DB after the proxy-outage recovery;
# skip-owned absorbs drift, so a stale entry that got covered meanwhile is just skipped).
UNCOVERED="1113,1835,2220,2284,2285,2286,2310,2320,2330,2382,3002,3003,4012,4013,4017,4130,4140,4141,4142,4143,4144,4148,4165,4180,4190,4191,4192,4193,4194,4200,4210,4262,4263,4264,4265,4270,4280,4321,4322,4323,4324,4325,4326,4327,4331,4332,4333,4334,4335,4336,4337,4338,4339,4340,4342,4344,4345,4346,4347,4348,4349,4700,4702,4703,5015,5019,5021,5022,5023,5110,5264,5267,5273,5274,5301,5306,5312,5339,5343,6013,6016,7204,7205,8020,8030,8150,8160,8170,8180,8240,8250,8260,8280,8300,9300,9400,9401,9402,9403,9404,9405,9406,9407,9408,9409,9410,9411,9412,9510,9513,9515,9516,9522,9523,9527,9532,9535,9536,9539,9540,9541,9542,9543,9544,9545,9546,9547,9548,9550,9553,9558,9559,9564,9567,9574,9577,9580,9587,9588,9592,9599,9602,9605,9608,9610,9611,9612,9614,9617,9619,9632,9633,9634,9637,9639,9640,9642,9647,9648,9649,9650,9651,9653,9655"

IFS=',' read -ra ALL <<< "$UNCOVERED"
CHUNK=${CHUNK:-20}; CONC=${CONCURRENCY:-4}
n=${#ALL[@]}; TOTAL_MB=0
echo "ONE-SHOT start $(date -u '+%Y-%m-%d %H:%M UTC') — $n uncovered TDWL names, chunk=$CHUNK conc=$CONC, full 5y PDF depth"
for ((i=0; i<n; i+=CHUNK)); do
  SLICE=$(IFS=,; echo "${ALL[*]:i:CHUNK}")
  end=$(( i+CHUNK<n ? i+CHUNK : n ))
  echo "=== $(date -u '+%H:%M') chunk $((i/CHUNK+1))/$(( (n+CHUNK-1)/CHUNK )) [names $((i+1))-$end] ==="
  reap  # clean leaked chrome + stale X-lock so this chunk's xvfb-run gets a fresh display
  # PDF_ARCHIVE_MAX high = full 5y PDF archiving; MAX_RUN_BYTES high = no per-chunk byte cap (total tracked below).
  OUT=$(ACQUIRE_SYMBOLS="$SLICE" CONCURRENCY="$CONC" PDF_ARCHIVE_MAX=500 RUN_BUDGET_MS=1500000 MAX_RUN_BYTES=20000 \
    timeout 1700 xvfb-run -a node tadawul-researcher.mjs 2>&1)
  echo "$OUT" | grep -E "researcher —|DONE|nav failed|byte budget" | tail -4
  MB=$(echo "$OUT" | grep -oE "proxy [0-9.]+MB" | tail -1 | grep -oE "[0-9.]+" || true)
  [ -n "$MB" ] && TOTAL_MB=$(awk "BEGIN{printf \"%.1f\", $TOTAL_MB + $MB}")
  echo "    cumulative proxy this one-shot: ${TOTAL_MB} MB"
done
echo "ONE-SHOT COMPLETE $(date -u '+%Y-%m-%d %H:%M UTC') — total proxy ~${TOTAL_MB} MB"
