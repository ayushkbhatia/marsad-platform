-- 0034_filing_project — project FILING.REF lake.objects → public.filings.
--
-- THE GAP THIS CLOSES (DEF-FILINGS-PUBLISH): filings LISTS already reach the lake as
-- FILING.REF objects (86 live, all PENDING) via the filings_poll adapters, but NOTHING
-- projected them into the serving table. public.filings was EMPTY all-time despite the
-- announcement corpus existing in lake.objects. This mirrors the QUOTE.LAST projection
-- (0031 fn_quote_project) and the OHLCV projection (0028 fn_ohlcv_daily_project).
--
-- Source object: FILING.REF, payload = { title, venue, pdfUrl, filedAt, detailUrl,
-- sourceRef, externalId } (camelCase; captured live from the ADX/DFM/MSX filings polls).
-- The list feed carries NO filing_type and NO security_id — a filing list is a venue-level
-- announcement stream, resolved to a company + classified only when the detail/full-text
-- upgrade (P1.7d F) lands. So we publish venue-scoped rows: security_id NULL, filing_type
-- keyword-classified from the title with a safe 'OTHER' fallback, form_code NULL.
--
-- Single-source publish rule (owner D-src-1): a filings list has no cross-check partner, so
-- the object is PENDING. Project PENDING+VERIFIED (like quotes/OHLCV) so a lone announcement
-- still serves; a later detail-fetch enriches the SAME (venue_code, source_ref) row.

set search_path = '';

-- Deterministic, conservative title → filing_type classifier. Unknown ⇒ 'OTHER'
-- (never a wrong type). Order matters: earliest match wins.
create or replace function public.fn_classify_filing_type(p_title text) returns text
language sql immutable set search_path = '' as $$
  select case
    when p_title is null then 'OTHER'
    when p_title ~* '(dividend|distribution to shareholders|cash payout)'        then 'DIVIDEND'
    when p_title ~* '(prospectus|offering|ipo|book ?build)'                       then 'PROSPECTUS'
    when p_title ~* '(financial statement|interim results|annual results|earnings|profit|financial result)' then 'RESULTS'
    when p_title ~* '(board|governance|general assembly|agm|egm|bylaw|by-law)'    then 'GOVERNANCE'
    when p_title ~* '(credit rating|rating action|outlook (revised|assigned))'   then 'RATING'
    when p_title ~* '(capital (increase|reduction)|rights issue|capex|capacity|expansion|acquisition|merger)' then 'CAPEX'
    when p_title ~* '(contract|award|agreement|mou|signing)'                      then 'CONTRACT'
    else 'OTHER'
  end;
$$;

create or replace function lake.fn_filing_project() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_venue   text := coalesce(new.venue_code, new.payload ->> 'venue');
  v_ref     text := coalesce(new.payload ->> 'sourceRef', new.payload ->> 'externalId', new.natural_key);
  v_title   text := new.payload ->> 'title';
  v_filed   timestamptz := nullif(new.payload ->> 'filedAt','')::timestamptz;
begin
  if new.object_type <> 'FILING.REF' then return null; end if;
  if new.state not in ('PENDING','VERIFIED') then return null; end if;
  -- NOT-NULL columns on public.filings; skip a malformed object rather than fail the tx.
  if v_venue is null or v_ref is null or v_title is null or v_filed is null then return null; end if;
  -- venue_code is a FK to public.venues(code); ignore an unknown venue string.
  if not exists (select 1 from public.venues where code = v_venue) then return null; end if;

  insert into public.filings (security_id, venue_code, source_ref, form_code, filing_type,
                              title, filed_at, pdf_en_path)
  values (new.security_id, v_venue, v_ref, null,
          public.fn_classify_filing_type(v_title), v_title, v_filed,
          nullif(new.payload ->> 'pdfUrl',''))
  on conflict (venue_code, source_ref) do update set
    -- Refresh presentational fields; NEVER clobber a security_id or full_text the
    -- detail-fetch upgrade may have already set (coalesce keeps the richer value).
    title       = excluded.title,
    filed_at    = excluded.filed_at,
    filing_type = case when public.filings.filing_type = 'OTHER'
                       then excluded.filing_type else public.filings.filing_type end,
    pdf_en_path = coalesce(public.filings.pdf_en_path, excluded.pdf_en_path),
    security_id = coalesce(public.filings.security_id, excluded.security_id);

  return null;
end $$;

drop trigger if exists objects_filing_project_ins on lake.objects;
create trigger objects_filing_project_ins after insert on lake.objects
  for each row when (new.object_type = 'FILING.REF')
  execute function lake.fn_filing_project();

drop trigger if exists objects_filing_project_upd on lake.objects;
create trigger objects_filing_project_upd after update on lake.objects
  for each row when (new.object_type = 'FILING.REF')
  execute function lake.fn_filing_project();

-- One-time backfill of the FILING.REF objects that already exist (created before this
-- trigger). Idempotent via the (venue_code, source_ref) upsert. superseded_by is null ⇒
-- only the live revision of each announcement projects.
insert into public.filings (security_id, venue_code, source_ref, form_code, filing_type,
                            title, filed_at, pdf_en_path)
select o.security_id,
       coalesce(o.venue_code, o.payload ->> 'venue'),
       coalesce(o.payload ->> 'sourceRef', o.payload ->> 'externalId', o.natural_key),
       null,
       public.fn_classify_filing_type(o.payload ->> 'title'),
       o.payload ->> 'title',
       (o.payload ->> 'filedAt')::timestamptz,
       nullif(o.payload ->> 'pdfUrl','')
from lake.objects o
where o.object_type = 'FILING.REF'
  and o.state in ('PENDING','VERIFIED')
  and o.superseded_by is null
  and coalesce(o.venue_code, o.payload ->> 'venue') in (select code from public.venues)
  and coalesce(o.payload ->> 'sourceRef', o.payload ->> 'externalId', o.natural_key) is not null
  and (o.payload ->> 'title') is not null
  and nullif(o.payload ->> 'filedAt','') is not null
on conflict (venue_code, source_ref) do nothing;
