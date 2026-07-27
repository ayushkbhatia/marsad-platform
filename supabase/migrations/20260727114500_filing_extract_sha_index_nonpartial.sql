-- PE.0 follow-up — restore a NON-partial unique index on ops.filing_extract_queue.content_sha256.
--
-- 20260727113000 replaced the original `UNIQUE (content_sha256)` constraint with a PARTIAL unique
-- index (`where content_sha256 is not null`), on the assumption that the column becoming nullable
-- required it. That assumption was wrong twice over:
--
--   1. Postgres treats NULLs as DISTINCT in a unique index by default, so a plain
--      `unique (content_sha256)` already permits unlimited NULL rows — which is exactly what the
--      9,251 hash-less TDWL/QE rows need. The partial predicate bought nothing.
--
--   2. It broke a live producer. `ON CONFLICT (col)` cannot infer a PARTIAL index without
--      restating its predicate, so worker/src/handlers/filings-detail-poll.ts:244 —
--      `insert into ops.filing_extract_queue … on conflict (content_sha256) do nothing` — began
--      failing with:
--        42P10: there is no unique or exclusion constraint matching the ON CONFLICT specification
--      i.e. the filing_detail chain for MSX/ADX/DFM would have started erroring on every new PDF.
--      Caught by probing the exact statement shape before commit; never reached a live run.
--
-- Restoring the non-partial index makes that statement resolve again. The handler is ALSO being
-- moved to an untargeted `on conflict do nothing` in the same change, so it is robust against the
-- pdf_storage_key index too — but this migration means the DB is correct even against the old
-- deployed worker, which matters because the VPS runs from its own checkout and lags the repo.

drop index if exists ops.filing_extract_queue_sha_uni;

create unique index if not exists filing_extract_queue_sha_uni
  on ops.filing_extract_queue (content_sha256);
