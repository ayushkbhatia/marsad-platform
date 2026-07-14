-- 0039_filing_project — project lake.objects (FILING.REF) → public.filings (reader table).
--
-- PROVENANCE: applied to prod live 2026-07-14 (ledger `filing_project`) but its .sql was never committed;
-- recovered verbatim from supabase_migrations.schema_migrations.statements and committed here so
-- `supabase db reset` (CI from-scratch) reproduces prod. Depends only on public.filings/venues (0006/0003)
-- and lake.objects (0004); independent of 0030–0037, so appended rather than renumbered.

set search_path = '';

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
  if v_venue is null or v_ref is null or v_title is null or v_filed is null then return null; end if;
  if not exists (select 1 from public.venues where code = v_venue) then return null; end if;

  insert into public.filings (security_id, venue_code, source_ref, form_code, filing_type,
                              title, filed_at, pdf_en_path)
  values (new.security_id, v_venue, v_ref, null,
          public.fn_classify_filing_type(v_title), v_title, v_filed,
          nullif(new.payload ->> 'pdfUrl',''))
  on conflict (venue_code, source_ref) do update set
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
