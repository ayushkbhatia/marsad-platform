-- 20260716094000_seen_items_nopdf_state — add 'nopdf' to the seen_items.detail_state machine.
--
-- The filing_detail drain (filings_detail_poll) distinguishes a benign no-attachment announcement
-- ('nopdf' — the announcement has no downloadable PDF via the venue's detail path) from a genuine
-- fetch error ('failed' — a transport/parse problem worth attention). The 0005 CHECK constraint only
-- allowed ('pending','fetched','failed'), so a 'nopdf' write threw — a latent bug that would have
-- failed the handler on the first PDF-less announcement. Both new states are terminal (the row leaves
-- the pending drain set), so neither re-fetches; the split is purely for ops legibility.

set search_path = '';

alter table ingest.seen_items drop constraint if exists seen_items_detail_state_check;
alter table ingest.seen_items add constraint seen_items_detail_state_check
  check (detail_state in ('pending','fetched','failed','nopdf'));
