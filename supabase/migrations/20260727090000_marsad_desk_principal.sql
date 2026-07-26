-- The "Marsad Desk" house byline principal.
--
-- WHY A HOUSE BYLINE AND NOT NAMED ANALYSTS (owner decision, 2026-07-27):
-- bridge P3 seeds real `content_items` so the reader runs the production query
-- path instead of TypeScript samples. Those pieces need an author, because
-- `content_items.author_id` is NOT NULL and FKs to `iam.principals`.
--
-- We deliberately do NOT seed fictional named analysts. The 1i/1j designs are
-- built around individuals with win rates, follower counts and price targets on
-- REAL listed companies — publishing invented people making invented investment
-- calls, on a public site, is materially different from placeholder UI copy.
-- The coverage desk therefore ships an honest "launching" empty state until real
-- analysts are onboarded, and everything seeded here is attributed to the
-- institution. See DEF-ANALYSTS-LIVE-DATA.
--
-- `kind = 'system'` rather than 'human' precisely because this is not a person.
-- No `public.analysts` row is created for it, so it never appears on the
-- coverage-desk leaderboard.

insert into iam.principals (id, kind, handle, display_name, is_active)
values (
  '00000000-0000-4000-a000-00000000d35c',
  'system',
  'MARSAD-DESK',
  'Marsad Desk',
  true
)
on conflict (id) do update
  set handle       = excluded.handle,
      display_name = excluded.display_name,
      is_active    = excluded.is_active;
