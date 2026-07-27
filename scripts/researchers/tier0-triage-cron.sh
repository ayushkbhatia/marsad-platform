#!/bin/bash
# Marsad Tier-0 triage cron wrapper (PE.1) — drains ops.filing_extract_queue's never-triaged PDFs:
# storage GET → sha256 → LiteParse (OCR OFF) → public.filings.full_text/pdf_pages/pdf_sha256, then
# routes each row to text_ready (Tier 2 semantic) or needs_ocr (Tier 1 model).
#
# NO LLM, NO OCR, $0 — so unlike filing-extractor-cron.sh this does NOT need the Claude seat and can
# run a much larger batch per fire. Queue-claimed with SKIP LOCKED, so no chunk cursor: the queue IS
# the cursor. Bandwidth is the real budget — TIER0_MAX x ~1.5MB/doc of Supabase Storage egress.
set -uo pipefail
exec 9>/home/deploy/.tier0-triage.lock
flock -n 9 || { echo "another tier0-triage run holds the lock — skipping this fire"; exit 0; }

set -a; source /etc/marsad/worker.env; set +a
# Belt-and-braces: this lane must never make an LLM call. If a future edit introduces one, it will
# fail loudly rather than quietly bill the platform key.
unset ANTHROPIC_API_KEY
export TIER0_MAX="${TIER0_MAX:-400}" CONCURRENCY="${CONCURRENCY:-3}" RUN_BUDGET_MS="${RUN_BUDGET_MS:-1000000}"
OUT=$(timeout 1100 node /opt/marsad/scripts/researchers/tier0-triage.mjs 2>&1)
echo "$OUT" | grep -E "tier0-triage —|DONE" | tail -2
