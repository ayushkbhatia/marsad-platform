#!/bin/bash
# Marsad MSX statement-extract cron wrapper (Phase C2, DEF-MSX-STMT-EXTRACT) — projects the archived
# MSX report PDFs into financial_statements via claude -p ($0 seat). Incremental via the coverage
# gate + the extracted_facts.stmt_extract owned-marker — no chunk cursor needed.
set -uo pipefail
exec 9>/home/deploy/.msx-stmt-extract.lock
flock -n 9 || { echo "another msx-stmt-extract run holds the lock — skipping this fire"; exit 0; }

set -a; source /etc/marsad/worker.env; set +a
unset ANTHROPIC_API_KEY
export MSX_MAX="${MSX_MAX:-14}" CONCURRENCY="${CONCURRENCY:-2}" CLAUDE_MODEL="${CLAUDE_MODEL:-haiku}"
OUT=$(timeout 1100 node /opt/marsad/scripts/researchers/msx-stmt-extract.mjs 2>&1)
echo "$OUT" | grep -E "msx-stmt-extract —|DONE" | tail -2
