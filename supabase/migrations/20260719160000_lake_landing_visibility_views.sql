-- Data-lake + storage landing visibility.
-- Read-only monitoring views over the three raw layers (snapshots -> staging_rows
-- -> objects) plus the Storage buckets, so ops can see "what just landed" at a
-- glance from Supabase Studio or a future admin route.
-- These are plain (owner-privileged) views: callers do not need per-table RLS
-- grants, but the views themselves must only ever be exposed to trusted
-- server-side / admin readers (service role or an admin-gated route).

-- ---------------------------------------------------------------------------
-- 1) Per-layer x venue throughput, with 1h / 24h / 7d windows + freshness age.
--    One row per (layer, venue). Layers ordered fetch -> extract -> canonical.
-- ---------------------------------------------------------------------------
create or replace view lake.v_landing_recent as
with snap as (
  select 'snapshots'::text                                        as layer,
         venue_code,
         count(*) filter (where fetched_at > now() - interval '1 hour')   as n_1h,
         count(*) filter (where fetched_at > now() - interval '24 hours') as n_24h,
         count(*) filter (where fetched_at > now() - interval '7 days')   as n_7d,
         max(fetched_at)                                          as latest
  from lake.snapshots
  group by venue_code
),
stg as (
  select 'staging_rows'::text,
         venue_code,
         count(*) filter (where ingested_at > now() - interval '1 hour'),
         count(*) filter (where ingested_at > now() - interval '24 hours'),
         count(*) filter (where ingested_at > now() - interval '7 days'),
         max(ingested_at)
  from lake.staging_rows
  group by venue_code
),
obj as (
  select 'objects'::text,
         venue_code,
         count(*) filter (where created_at > now() - interval '1 hour'),
         count(*) filter (where created_at > now() - interval '24 hours'),
         count(*) filter (where created_at > now() - interval '7 days'),
         max(created_at)
  from lake.objects
  group by venue_code
)
select u.layer,
       u.venue_code,
       u.n_1h,
       u.n_24h,
       u.n_7d,
       u.latest,
       now() - u.latest as age
from (select * from snap union all select * from stg union all select * from obj) u
order by array_position(array['snapshots','staging_rows','objects'], u.layer),
         u.n_24h desc,
         u.venue_code;

comment on view lake.v_landing_recent is
  'Raw-datapoint throughput per pipeline layer x venue (1h/24h/7d) + freshness age. Admin/ops only.';

-- ---------------------------------------------------------------------------
-- 2) Storage bucket rollup: file counts, total bytes, recent inflow, freshness.
-- ---------------------------------------------------------------------------
create or replace view lake.v_landing_storage as
select b.name                                                             as bucket,
       count(*)                                                           as files,
       sum((o.metadata->>'size')::bigint)                                 as bytes,
       pg_size_pretty(sum((o.metadata->>'size')::bigint))                 as size_pretty,
       count(*) filter (where o.created_at > now() - interval '1 hour')   as files_1h,
       count(*) filter (where o.created_at > now() - interval '24 hours') as files_24h,
       max(o.created_at)                                                  as latest,
       now() - max(o.created_at)                                          as age
from storage.objects o
join storage.buckets b on b.id = o.bucket_id
group by b.name
order by files desc;

comment on view lake.v_landing_storage is
  'Per-bucket raw-file landing: count, size, 1h/24h inflow, freshness age. Admin/ops only.';

-- ---------------------------------------------------------------------------
-- 3) Canonical object mix: which object_types are landing, by venue.
--    Only types seen in the last 7 days, so dormant types drop out.
-- ---------------------------------------------------------------------------
create or replace view lake.v_landing_types as
select object_type,
       venue_code,
       count(*) filter (where created_at > now() - interval '24 hours') as n_24h,
       count(*) filter (where created_at > now() - interval '7 days')   as n_7d,
       max(created_at)                                                  as latest
from lake.objects
group by object_type, venue_code
having count(*) filter (where created_at > now() - interval '7 days') > 0
order by n_24h desc, n_7d desc;

comment on view lake.v_landing_types is
  'Canonical datapoint mix (object_type x venue) landing in last 7d. Admin/ops only.';

-- ---------------------------------------------------------------------------
-- 4) Pipeline freshness / gap flags: one row per venue that has ever produced
--    an object, with the newest timestamp at each layer and health flags:
--      - object_stale:  no new canonical object in 24h
--      - no_raw_trail:  a FETCHED object landed in 24h with NO lineage anchor at
--                       all -- neither a lake.snapshots blob NOR a parse_run.
--                       COMPUTED.* objects (ratios, scores) are excluded: they
--                       are derived, not fetched, so they legitimately have no
--                       raw source. Objects whose raw copy lives in the 'filings'
--                       bucket still carry a parse_run, so they do NOT trip this
--                       (that lineage is the parse_run + public.filings.pdf_storage_key,
--                       not lake.snapshots). `untracked_fetched_24h` exposes the count.
--      - stalled_extract: snapshots landing but staging not keeping up (24h)
-- ---------------------------------------------------------------------------
create or replace view lake.v_landing_gaps as
with v as (
  select distinct venue_code
  from lake.objects
  where venue_code is not null
),
m as (
  select v.venue_code,
         (select max(fetched_at)  from lake.snapshots   s where s.venue_code = v.venue_code) as snapshot_latest,
         (select max(ingested_at) from lake.staging_rows g where g.venue_code = v.venue_code) as staging_latest,
         (select max(created_at)  from lake.objects     o where o.venue_code = v.venue_code) as object_latest,
         -- fetched (non-computed) objects landed in 24h that carry no parse_run lineage
         (select count(*) from lake.objects o
           where o.venue_code = v.venue_code
             and o.created_at > now() - interval '24 hours'
             and o.object_type not like 'COMPUTED.%'
             and o.parse_run_id is null) as untracked_fetched_24h
  from v
)
select venue_code,
       snapshot_latest,
       staging_latest,
       object_latest,
       untracked_fetched_24h,
       (object_latest   is null or object_latest   < now() - interval '24 hours') as object_stale,
       -- real lineage gap: a fetched object with no parse_run AND no snapshot blob for the venue
       (untracked_fetched_24h > 0
         and (snapshot_latest is null or snapshot_latest < now() - interval '24 hours')) as no_raw_trail,
       (snapshot_latest >= now() - interval '24 hours'
         and (staging_latest is null or staging_latest < now() - interval '24 hours')) as stalled_extract
from m
order by venue_code;

comment on view lake.v_landing_gaps is
  'Per-venue pipeline freshness at each layer + stale/no-raw-trail/stalled-extract flags. no_raw_trail = a FETCHED (non-COMPUTED) object with neither a snapshot nor a parse_run. Admin/ops only.';
