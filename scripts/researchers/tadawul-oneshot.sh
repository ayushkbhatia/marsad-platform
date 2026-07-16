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
# BANDWIDTH: ~8-10 GB total through the metered proxy (calibrated ~17 MB/company data + PDFs). Top up first.
#
# Run:   nohup bash /home/deploy/tadawul-oneshot.sh > /home/deploy/oneshot.log 2>&1 &
# Watch: tail -f /home/deploy/oneshot.log
# Stop:  pkill -f tadawul-oneshot; pkill -f 'node tadawul-researcher'

set -uo pipefail
exec 9>/home/deploy/.tadawul-scrape.lock
flock -n 9 || { echo "scrape lock held by another run — abort"; exit 1; }
set -a; source /etc/marsad/worker.env; set +a
export PLAYWRIGHT_BROWSERS_PATH=/opt/marsad/.playwright
cd /home/deploy

# 258 uncovered TDWL listed tickers as of 2026-07-16 (skip-owned absorbs any drift since).
UNCOVERED="1113,1214,1301,1830,1831,1832,1833,1835,2030,2040,2080,2081,2082,2083,2084,2090,2220,2281,2282,2283,2284,2285,2286,2310,2320,2330,2340,2382,3002,3003,3004,3005,3020,3030,3040,3050,4005,4006,4007,4008,4012,4013,4014,4015,4016,4017,4018,4019,4020,4130,4140,4141,4142,4143,4144,4148,4165,4180,4190,4191,4192,4193,4194,4200,4210,4220,4261,4262,4263,4264,4265,4270,4280,4290,4291,4292,4300,4310,4320,4321,4322,4323,4324,4325,4326,4327,4331,4332,4333,4334,4335,4336,4337,4338,4339,4340,4342,4344,4345,4346,4347,4348,4349,4700,4702,4703,5015,5019,5021,5022,5023,5110,5264,5267,5273,5274,5301,5306,5312,5339,5343,6001,6002,6013,6016,7010,7020,7030,7040,7200,7201,7202,7203,7204,7205,8010,8020,8030,8040,8050,8150,8160,8170,8180,8190,8200,8210,8230,8240,8250,8260,8280,8300,8310,8311,8313,9300,9400,9401,9402,9403,9404,9405,9406,9407,9408,9409,9410,9411,9412,9510,9513,9514,9515,9516,9517,9521,9522,9523,9524,9527,9530,9532,9535,9536,9539,9540,9541,9542,9543,9544,9545,9546,9547,9548,9550,9552,9553,9555,9557,9558,9559,9560,9564,9567,9569,9570,9572,9574,9575,9577,9578,9580,9583,9587,9588,9590,9591,9592,9594,9595,9596,9599,9600,9601,9602,9603,9604,9605,9607,9608,9610,9611,9612,9614,9615,9617,9618,9619,9621,9626,9627,9630,9631,9632,9633,9634,9637,9639,9640,9642,9647,9648,9649,9650,9651,9653,9655"

IFS=',' read -ra ALL <<< "$UNCOVERED"
CHUNK=${CHUNK:-20}; CONC=${CONCURRENCY:-4}
n=${#ALL[@]}; TOTAL_MB=0
echo "ONE-SHOT start $(date -u '+%Y-%m-%d %H:%M UTC') — $n uncovered TDWL names, chunk=$CHUNK conc=$CONC, full 5y PDF depth"
for ((i=0; i<n; i+=CHUNK)); do
  SLICE=$(IFS=,; echo "${ALL[*]:i:CHUNK}")
  end=$(( i+CHUNK<n ? i+CHUNK : n ))
  echo "=== $(date -u '+%H:%M') chunk $((i/CHUNK+1))/$(( (n+CHUNK-1)/CHUNK )) [names $((i+1))-$end] ==="
  # PDF_ARCHIVE_MAX high = full 5y PDF archiving; MAX_RUN_BYTES high = no per-chunk byte cap (total tracked below).
  OUT=$(ACQUIRE_SYMBOLS="$SLICE" CONCURRENCY="$CONC" PDF_ARCHIVE_MAX=500 RUN_BUDGET_MS=1500000 MAX_RUN_BYTES=20000 \
    timeout 1700 xvfb-run -a node tadawul-researcher.mjs 2>&1)
  echo "$OUT" | grep -E "researcher —|DONE|nav failed|byte budget" | tail -4
  MB=$(echo "$OUT" | grep -oE "proxy [0-9.]+MB" | tail -1 | grep -oE "[0-9.]+" || true)
  [ -n "$MB" ] && TOTAL_MB=$(awk "BEGIN{printf \"%.1f\", $TOTAL_MB + $MB}")
  echo "    cumulative proxy this one-shot: ${TOTAL_MB} MB"
done
echo "ONE-SHOT COMPLETE $(date -u '+%Y-%m-%d %H:%M UTC') — total proxy ~${TOTAL_MB} MB"
