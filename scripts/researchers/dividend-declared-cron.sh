#!/bin/bash
# Marsad DIVIDEND.DECLARED producer cron wrapper (DEF-DIVIDEND-DECLARED, BUILD-STATUS §7) — turns
# DIVIDEND filings whose facts the filing-extractor already parsed
# (extracted_facts.ai.dividend) into DIVIDEND.EXDATE lake objects (PENDING, price_sensitive) + reader
# public.dividends rows (pending_confirm). NO LLM call (the bounded cost was paid by filing-extractor);
# pure DB, no proxy/browser. A Desk human confirm promotes object→VERIFIED + dividend→live, which
# fires the classify→TPL-04 wire.
#
# Coverage-guarded + idempotent (the natural_key collapses re-runs; dividends upsert never clobbers a
# live/cancelled row), so no chunk cursor is needed — DIVIDEND_MAX bounds the batch, the coverage
# guard (a DIVIDEND.EXDATE object already carrying the filing id) skips done work.
set -uo pipefail
exec 9>/home/deploy/.dividend-declared.lock
flock -n 9 || { echo "another dividend-declared run holds the lock — skipping this fire"; exit 0; }

set -a; source /etc/marsad/worker.env; set +a
export DIVIDEND_MAX="${DIVIDEND_MAX:-50}"
OUT=$(timeout 1100 node /opt/marsad/scripts/researchers/dividend-declared.mjs 2>&1)
echo "$OUT" | grep -E "dividend-declared —|DONE|ASSESS DONE" | tail -2
