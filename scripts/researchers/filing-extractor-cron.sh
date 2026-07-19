#!/bin/bash
# Marsad filing-facts extractor cron wrapper (Phase C1, DEF-FILING-FACTS) — drains
# ops.filing_extract_queue: PDF → full_text (+OCR) → claude -p ($0 seat) → ai_summary /
# extracted_facts.ai / is_market_moving on public.filings. Queue-claimed with SKIP LOCKED,
# so no chunk cursor needed — the queue IS the cursor.
set -uo pipefail
exec 9>/home/deploy/.filing-extractor.lock
flock -n 9 || { echo "another filing-extractor run holds the lock — skipping this fire"; exit 0; }

set -a; source /etc/marsad/worker.env; set +a
# claude -p must bill the $0 subscription seat, not the platform API key (same as every LLM researcher).
unset ANTHROPIC_API_KEY
export EXTRACT_MAX="${EXTRACT_MAX:-12}" CONCURRENCY="${CONCURRENCY:-2}" CLAUDE_MODEL="${CLAUDE_MODEL:-haiku}"
OUT=$(timeout 1100 node /opt/marsad/scripts/researchers/filing-extractor.mjs 2>&1)
echo "$OUT" | grep -E "filing-extractor —|DONE" | tail -2
