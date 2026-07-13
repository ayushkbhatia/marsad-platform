-- 0012_ads_comms — ad inventory (seed 6 slots), campaigns/creatives; the
-- notification outbox, email templates/sends, suppression, push devices.
-- 02 §15, §16, §22 step 12.

create table ops.ad_slots (
  key            text primary key,
  placement      text not null,
  frequency_rule text,
  audience       text not null default 'free',   -- premium never sees ads
  status         text not null default 'house' check (status in ('sold','booked','house'))
);

create table ops.ad_campaigns (
  id               bigint generated always as identity primary key,
  sponsor          text not null,
  flight_start     date not null,
  flight_end       date not null,
  value_sar        numeric(14,2),
  status           text not null default 'draft' check (status in ('draft','in_review','approved','live','ended')),
  approved_by      uuid references iam.principals(id),
  conflict_tickers bigint[] not null default '{}',
  created_at       timestamptz not null default now()
);

create table ops.ad_creatives (
  id             bigint generated always as identity primary key,
  campaign_id    bigint not null references ops.ad_campaigns(id) on delete cascade,
  slot_key       text not null references ops.ad_slots(key),
  asset_path     text not null,
  headline       text,
  body           text,
  r05_checked_at timestamptz,                    -- creatives pass the banned-phrase rule too
  status         text not null default 'in_review' check (status in ('in_review','approved','rejected'))
);

-- Deferred FK from 0009 (02 §22 forward-reference rule).
alter table ops.rule_violations
  add constraint rule_violations_ad_creative_fkey
  foreign key (ad_creative_id) references ops.ad_creatives(id);

-- Agents never manage ads (05 §2.4 denylist), same DB-level backstop as billing.
create trigger no_agent_writes before insert or update or delete on ops.ad_campaigns
  for each row execute function billing.fn_no_agent_writes();
create trigger no_agent_writes before insert or update or delete on ops.ad_slots
  for each row execute function billing.fn_no_agent_writes();

insert into ops.ad_slots (key, placement, frequency_rule, audience) values
  ('front_hero',        'Front page — below module 2',   '3/reader/day', 'free'),
  ('wire_rail',         'Wire rail — every 12th item',   '3/reader/day', 'free'),
  ('article_inline',    'Article body — after block 4',  '3/reader/day', 'free'),
  ('stock_sidebar',     'Stock page — right rail',       '3/reader/day', 'free'),
  ('screener_footer',   'Screener results footer',       '3/reader/day', 'free'),
  ('newsletter_banner', 'Wire Brief email banner',       '1/send',       'free');

-- ---------------------------------------------------------------------------
-- Comms: one outbox for every channel (02 §16). Nothing sends synchronously.

create table comms.notifications (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  kind          text not null,
  title         text not null,
  body          text,
  deep_link     text,
  channel       text not null check (channel in ('push','email','whatsapp','inapp')),
  priority      text not null default 'normal' check (priority in ('critical','normal','digest')),
  status        text not null default 'queued' check
                (status in ('queued','held_quiet_hours','sent','failed','suppressed','skipped_cap')),
  scheduled_for timestamptz not null default now(),
  sent_at       timestamptz,
  read_at       timestamptz,
  alert_id      uuid references public.alerts(id),
  dedupe_key    text,
  created_at    timestamptz not null default now()
);
create index notif_queue_idx on comms.notifications (scheduled_for) where status in ('queued','held_quiet_hours');
create index notif_inbox_idx on comms.notifications (user_id, created_at desc);
create unique index notif_dedupe on comms.notifications (dedupe_key) where dedupe_key is not null;

create table comms.email_templates (
  key             text primary key,
  sender_identity text not null,
  subject_tpl     text not null,
  mjml_path       text not null,
  trigger_kind    text not null check (trigger_kind in ('scheduled','event','lifecycle'))
);

create table comms.email_sends (
  id           bigint generated always as identity primary key,
  template_key text not null references comms.email_templates(key),
  batch_date   date not null,
  recipients   int not null default 0,
  delivered    int,
  opened       int,
  bounced      int,
  status       text not null default 'assembling' check (status in ('assembling','scheduled','sending','sent')),
  created_at   timestamptz not null default now()
);

create table comms.suppression_list (
  email    text primary key,
  reason   text not null check (reason in ('bounce','complaint','manual','unsubscribed')),
  added_at timestamptz not null default now()
);

create table comms.push_devices (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  platform     text not null check (platform in ('webpush','fcm','apns')),
  token        text not null unique,
  last_seen_at timestamptz not null default now()
);

-- Reader inbox surface: view, not the outbox table (02 §19 family 5).
create view public.my_notifications as
  select id, kind, title, body, deep_link, channel, priority, status,
         scheduled_for, sent_at, read_at, created_at
  from comms.notifications
  where user_id = auth.uid() and channel in ('push','inapp');

insert into comms.email_templates (key, sender_identity, subject_tpl, mjml_path, trigger_kind) values
  ('wire_brief_am', 'brief@',    'Marsad Wire Brief — {{date}} AM',        'src/emails/wire-brief-am.mjml', 'scheduled'),
  ('wire_brief_pm', 'brief@',    'Marsad Wire Brief — {{date}} PM',        'src/emails/wire-brief-pm.mjml', 'scheduled'),
  ('price_alert',   'alerts@',   '{{ticker}} {{direction}} {{price}}',     'src/emails/price-alert.mjml',   'event'),
  ('receipt',       'billing@',  'Your Marsad receipt {{order_no}}',       'src/emails/receipt.mjml',       'event'),
  ('otp',           'security@', 'Your Marsad sign-in code',               'src/emails/otp.mjml',           'event'),
  ('dunning_1',     'billing@',  'Payment issue with your Marsad account', 'src/emails/dunning-1.mjml',     'lifecycle'),
  ('trial_t3',      'accounts@', 'Your Marsad trial ends in 3 days',       'src/emails/trial-t3.mjml',      'lifecycle'),
  ('audit_anchor',  'security@', 'Marsad audit chain anchor {{date}}',     'src/emails/audit-anchor.mjml',  'scheduled');
