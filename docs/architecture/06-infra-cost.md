# 06 — Infrastructure, Jobs, Cost & Developer Experience

> Domain architecture document for the Marsad platform. Companion to `docs/design-analysis.md`.
> Locked constraints honored throughout: scrape-only delayed market data, all 6 venues day one,
> cheapest-possible run cost, provider-agnostic LLM layer, English only.
> Date: 2026-07-13. Owner: single human operator; no employees.

---

## 1. Summary of the topology

Marsad runs on exactly **four paid pieces of infrastructure** and a set of free tiers:

1. **Vercel** — the Next.js 16 app (reader web + mobile web, Marsad Desk, Workbench), all
   HTTP request/response work including Stripe webhooks and server-side entitlement
   enforcement.
2. **Supabase** (project `yjsncnpbjuueaoeejrqj`, ap-south-1, **Pro plan $25/mo — verified
   live; the brief's "$10/mo" maps to no real Supabase SKU**) — Postgres as the single
   source of truth (data lake, CMS, billing mirror, audit), Auth, Storage, pgvector (adopted
   at the AI phase), **pg_cron as the only business-job scheduler**, and **pgmq as the only
   message queue** (the ingestion fetch scheduler additionally uses its own cadence table
   `ingest.job_queue` — see Revisions). Supabase Realtime is reduced post-review to the Desk
   `agent-run-log` broadcast only; reader surfaces poll (04 §4).
3. **One Hetzner VPS (~$5/mo)** — a single long-running Node worker (`marsad-worker`) that
   does everything that cannot or should not run in a serverless request: venue scrapers
   (including headless Chromium), PDF/filing parsing, the LLM agent pipeline (data agents,
   writer agents, publishing agent), alert dispatch, email sending, and nightly backups.
4. **GitHub** — repo, Actions for CI/CD and a weekly restore drill. Actions cron is *not*
   used for production jobs (see §4.1).

Everything else is $0: Sentry free tier, UptimeRobot, Healthchecks.io, Cloudflare (DNS +
R2 free tier for backups), and optionally the owner's Mac running Ollama over Tailscale as
LLM Scenario C.

The load-bearing decision is: **the database is the coordination plane**. pg_cron decides
*when*, pgmq holds *what*, the VPS worker is dumb muscle that executes, and every job writes
a heartbeat row that the Desk feed-health board and dashboard (screens 24a/33a) read
directly. There is no Redis, no Kafka, no second database, and no scheduler that lives
outside Postgres.

---

## 2. Component placement map

| Component | Runs on | Module / location | Notes |
|---|---|---|---|
| Reader web + mobile web (all 135 reader screens) | Vercel | `src/app/(reader)/**` | ISR for articles/explainers; dynamic for quotes/screener. |
| Marsad Desk (20 admin screens) | Vercel | `src/app/desk/**` | Desktop-only; role-gated via Supabase Auth + RBAC middleware. |
| Marsad Workbench (1n/1o/20e) | Vercel | `src/app/workbench/**` | |
| API route handlers (entitlement-gated data APIs, Stripe webhook, health) | Vercel | `src/app/api/**` | Server-side gating lives here — article cut position, screener row truncation, meters are enforced in these handlers, never in the client (honors open question #12). |
| Supabase browser/server clients | Vercel | `src/lib/supabase/client.ts`, `src/lib/supabase/server.ts` | Already present. Add `src/lib/supabase/admin.ts` (service-role, server-only). |
| LLM gateway | shared | `src/lib/llm/gateway.ts` (+ re-used by worker via a shared package path) | See §9. |
| Postgres — all domain schemas | Supabase | schemas: `public` (domain entities), `ops` (jobs/heartbeats/feeds), `pgmq` (queues), `audit` | One database. Lake objects, citations, rules, content, subscribers, meters, audit — everything from design-analysis §3. |
| Auth (readers, staff, agent principals) | Supabase Auth + `public.principals` | | Humans authenticate via Supabase Auth; the 12 agent service accounts are rows in `public.principals` with hashed scoped API keys the worker presents. Both map to one `principals` table so RBAC and the append-only `audit.log` are identical for humans and agents (design requirement). |
| Storage | Supabase Storage | buckets: `filings-pdf`, `raw-snapshots`, `concall-audio`, `social-cards`, `invoices`, `exports` | Raw HTML snapshots for lake lineage live here (pointer in `public.lake_objects.lineage`), not in Postgres rows. |
| pgvector | Supabase | `public.doc_chunks` (embedding column) | AI grounding corpus (filings, transcripts, annual reports). |
| pg_cron | Supabase | `supabase/migrations/*_cron.sql` | The only business scheduler. Enqueues into pgmq; never does heavy work inline. |
| pgmq | Supabase | queues: `q_ingest`, `q_pipeline`, `q_dispatch`, `q_email`, `q_maintenance` | See §5. |
| Realtime | Supabase Realtime | channels: `feed_status`, `wire`, `desk_runlog`, `approval_queue` | Replaces any custom WS/SSE server. Free within plan limits; the reader's "live wire" and Desk run log subscribe here. |
| Scrapers (quotes, filings, indices, ownership, IPO pages, dividends) | **VPS** | `worker/src/pollers/*.ts` | Playwright + Chromium installed; most venue pages are fetch+cheerio, Chromium reserved for JS-rendered pages. |
| Agent workers (DATA-*, WRITER-*, EDITOR-*) | **VPS** | `worker/src/agents/*.ts` | Consume `q_pipeline`; every step writes `audit.log` under its agent principal. |
| Rules engine service (R-01..R-10) | Supabase (SQL/plpgsql core) + worker/Vercel callers | `public.publishing_rules`, `public.fn_run_rules(piece_id)` | Rules are data + one function; called at submit (Vercel, human content) and in the pipeline (worker, agent content). Same code path for both — a service, not inline validation. |
| Alert evaluation + dispatch (push/email; WhatsApp deferred) | VPS | `worker/src/dispatch/*.ts` | Quiet-hours 22:00–07:00 GST gate lives in the dispatcher, with halt-alert bypass. |
| Email sending (Wire Brief, alerts, auth, dunning) | VPS → Amazon SES | `worker/src/email/*.ts` | See §7 email cost line. Auth emails (OTP, reset) also via SES through Supabase Auth SMTP settings, so one sender infrastructure. |
| Stripe | SaaS | webhook → `src/app/api/stripe/webhook/route.ts` | Billing state mirrored into `public.subscriptions`; dunning *schedule* is ours (pg_cron), retries executed via Stripe API from the worker. |
| Backups | VPS crontab → Cloudflare R2 | `worker/ops/backup.sh` | See §8. |
| DNS / domain | Cloudflare (registrar at cost) | | |
| CI/CD | GitHub Actions | `.github/workflows/*.yml` | See §10. |
| Monitoring | Sentry free, UptimeRobot, Healthchecks.io, `ops.*` tables + Desk boards | | See §6. |
| Ollama (LLM Scenario C) | Owner's Mac | reachable from VPS via Tailscale ($0) | Optional; see §9. |

**Deliberately not used day one** (each is a cost or complexity cut, called out per the
brief): Supabase Edge Functions (a third runtime with a 400s cap and no headless browser —
everything they could do, Vercel routes or the VPS already do), Redis/BullMQ (see §5),
Vercel Cron (Hobby allows 2 daily crons — useless for this job inventory), a staging
environment (see §11), Elasticsearch/Typesense (Postgres FTS + trigram serves the 812-name
universe fine at launch; revisit if p95 search > 300ms), and any log-aggregation SaaS
(journald on the VPS + Vercel/Supabase built-in logs).

---

## 3. The scraper/worker placement decision (the concrete call)

Three candidates were weighed for "where do scrapers and agent workers run":

**GitHub Actions cron — rejected as the primary runner.**
Free 2,000 min/mo on private repos sounds attractive, but the numbers fail immediately:
quote polling alone at one 2-minute job per venue per 5 minutes across ~5 session hours ×
6 venues × ~22 trading days ≈ 15,000+ job-minutes/month — 7× the free quota before filings
polling or the LLM pipeline. Add the well-known problems: 5-minute *minimum* granularity
with no guarantee (scheduled jobs are routinely delayed 3–15 min under load, which
destroys the T+9-minute filings parse SLA), cold starts per run (Playwright install or a
cached ~1 GB image each time), no persistent state for the freshness state machine, and no
way to hold a warm Chromium. Actions keeps two roles only: CI/CD, and a weekly
backup-restore drill (§8).

**Supabase Edge Functions — rejected for scraping/agents.**
Hard limits are disqualifying: 400s max wall time (a concall transcription or 88-page
prospectus parse exceeds it), no headless browser (Deno isolate), and CPU-time caps that an
LLM-orchestration loop with retries will hit. They also add a third runtime to secure and
deploy. Nothing in the system *needs* them: webhooks land on Vercel, jobs land on the VPS.
DEFAULTED — owner may override for one niche later (e.g. an image-resize hook), but the
architecture assumes zero edge functions.

**A small VPS — selected.**
One **Hetzner CX22** (2 vCPU, 4 GB RAM, 40 GB NVMe, ~€4.35/mo ≈ **$5/mo** with IPv4;
Contabo is the fallback vendor at a similar price with worse network reputation). Rationale:

- Quote/filings polling needs *minute-level, reliable* scheduling during Sun–Thu venue
  hours. A resident process with `node-cron` loops is the only thing on this budget that
  delivers it.
- Playwright/Chromium needs a persistent filesystem and warm browser. 4 GB RAM comfortably
  holds one Chromium + the Node worker (~1.5 GB peak).
- The LLM pipeline is long-running and stateful-ish (retries, confidence kickbacks,
  citation verification) — a resident consumer with visibility timeouts against pgmq is
  the natural shape.
- Static egress IP: venue sites see one polite, identifiable client with per-venue rate
  limits, retry/backoff, and a rotating-UA courtesy layer in `worker/src/pollers/http.ts`.
- The box is **stateless by design**: everything durable is in Supabase/R2. If Hetzner
  eats the VM, `worker-deploy.yml` rebuilds it from a cloud-init file in ~10 minutes with
  zero data loss.

So the answer to "likely hybrid" is: **yes, but a minimal hybrid** — pg_cron (schedules) +
pgmq (queue) on Supabase, one VPS (execution), GitHub Actions (CI + drills only).

### 3.1 Worker layout in the repo

The repo stays a single Next.js project with a sibling worker package (no pnpm-workspace
ceremony until it hurts):

```
worker/
  package.json            # its own deps: playwright, pg, node-cron, zod
  tsconfig.json           # paths alias into ../src/lib/shared + ../src/lib/llm
  src/index.ts            # boot: load market_hours, start pollers, start pgmq consumers
  src/pollers/            # quotes-{tdwl,dfm,adx,qe,msx,bhb}.ts, filings.ts, indices.ts, ...
  src/agents/             # data-agents.ts, writer.ts, editor.ts, pipeline.ts
  src/dispatch/           # alerts.ts, quiet-hours.ts, push.ts
  src/email/              # ses.ts, wire-brief.ts, dunning.ts, templates/
  src/ops/                # heartbeat.ts, healthchecks.ts
  ops/
    backup.sh             # nightly pg_dump → R2
    marsad-worker.service # systemd unit (Restart=always)
    cloud-init.yml        # full VM rebuild recipe
```

Shared TypeScript (entity types generated from the DB, the LLM gateway, freshness state
machine) lives under `src/lib/shared/` and `src/lib/llm/` and is imported by both the Next
app and the worker via tsconfig path aliases — one definition of `LakeObject`,
`FreshnessState`, etc.

---

## 4. Job scheduler inventory

Conventions: GST = UTC+4 (no DST anywhere in the GCC). pg_cron runs in UTC. Cron
day-of-week: `0` = Sunday, so the Sun–Thu trading week is `0-4`. Every job on completion
writes `ops.job_heartbeats` and pings its Healthchecks.io check.

### 4.1 pg_cron entries (business schedule — enqueue into pgmq, worker executes)

| # | Job (pg_cron name) | Cron (UTC) | Local | Queue → handler | Source in design-analysis |
|---|---|---|---|---|---|
| 1 | `drain_scheduled_tasks` | `* * * * *` | every minute | moves due rows from `ops.scheduled_tasks` → their queue | all "event-scheduled" jobs (§5): IPO milestone comms, concall reminders, scheduled article publishes, front-page takeovers, first-Score-at-90-trading-days, books-close reminders |
| 2 | `score_batch` | `0 0 * * *` | 04:00 GST daily | `q_maintenance` → `worker/agents/score.ts` | 04:00 GST Marsad Score recompute, 812 names, emits score-change event log |
| 3 | `wire_brief_am` | `0 2 * * *` | 06:00 GST daily | `q_email` → assemble; send step scheduled 07:30 GST (03:30 UTC) | **DEFAULTED** — design conflict (open Q5): assemble at 06:00 GST (admin 33c), deliver 07:30 GST (reader promise). Owner may override. |
| 4 | `wire_brief_pm` | `30 12 * * 0-4` | 16:30 GST Sun–Thu | `q_email` | PM edition, trading days only; holds slot for pending piece |
| 5 | `dunning_batch` | `0 8 * * *` | 12:00 GST daily | `q_maintenance` → Stripe retry per schedule +2d/+5d/+7d-pause | 12:00 dunning retry batch, SYSTEM actor, recovered-MRR audit rows |
| 6 | `trial_t3_emails` | `0 1 * * *` | 05:00 GST daily | `q_email` | T-3 trial-ending email with usage recap |
| 7 | `meter_reset` | `5 0 1 * *` | 04:05 GST on the 1st | `q_maintenance` | monthly free-meter resets, premium credit 1-month rollover. **DEFAULTED**: reset moment = 04:05 GST on the 1st. |
| 8 | `select_rebalance` | `30 0 1 * *` | 04:30 GST on the 1st | `q_maintenance` | MARSAD SELECT monthly rebalance (after that day's score batch) |
| 9 | `dividend_verify` | `0 18 * * *` | 22:00 GST nightly | `q_ingest` | dividend verification vs registrar; yield recompute; >100% payout cut-risk flags |
| 10 | `ownership_refresh` | `30 18 * * *` | 22:30 GST nightly | `q_ingest` | ownership/FOL refresh, holder entity linkage |
| 11 | `estimates_agg` | `0 19 * * *` | 23:00 GST nightly | `q_maintenance` | estimate-revision aggregation 30/90d + breadth (feeds Revisions factor) |
| 12 | `saved_screen_reruns` | `0 13 * * 0-4` | 17:00 GST trading days | `q_maintenance` | saved-screen re-runs with membership diffing → screen-match alerts; catalog match counts |
| 13 | `frontpage_autoflow` | `2 2 * * *` | 06:02 GST daily | `q_maintenance` | AM auto-flow refresh (SYSTEM actor in page history, per 25c) |
| 14 | `analytics_rollup` | `15 * * * *` | hourly | `q_maintenance` | rollups behind 26a/26b |
| 15 | `exdate_reminders` | `30 1 * * *` | 05:30 GST daily | scan dividends where ex-date = today+2 → `q_dispatch` | "reminders exactly 2 days before ex-date" |
| 16 | `rating_review_flags` | `45 1 * * *` | 05:45 GST daily | `q_maintenance` | ratings ≥90d → REVIEW DUE flags (1n) |
| 17 | `datapoint_staleness` | `0 20 * * *` | 00:00 GST nightly | `q_maintenance` | series stale >30d flags; filing-cadence AWAITING flags |
| 18 | `evergreen_review` | `0 1 1 1,4,7,10 *` | quarterly | `q_maintenance` | evergreen content quarterly desk review tasks (TPL-06) |
| 19 | `pdpl_purge` | `30 20 * * *` | 00:30 GST nightly | `q_maintenance` | deletion requests past 30-day grace → irreversible purge, invoices retained (ZATCA 10y) |
| 20 | `retention_sweeps` | `0 21 * * 6` | Sat weekly | `q_maintenance` | analytics-event downsampling >90d; pgmq archive pruning; Storage temp-exports cleanup. Audit log: no-op sweep (7-year retention, append-only). |
| 21 | `heartbeat_sentinel` | `*/10 * * * *` | every 10 min | plpgsql only: flags any `ops.job_heartbeats` row past `2× expected_interval` → inserts `ops.incidents` row | powers the Desk needs-attention queue (24a) |

### 4.2 VPS-resident loops (in-process `node-cron` / timers — too chatty for pg_cron)

All are venue-hours-aware: on boot and daily at 03:00 GST the worker loads
`public.market_hours` (incl. Ramadan reduced sessions and Hijri-confirm holiday rows) and
computes today's per-venue session windows.

| Loop | Frequency | Notes |
|---|---|---|
| Venue fetch execution (quotes, indices, filings, sweeps) | **cadence is owned by 01-ingestion.md §4.2** — quotes every 10 min in-session, filings list every 5 min 04:00–19:00 UTC / 30 min overnight, detail event-driven, EOD close sweeps | The worker claims due jobs from `ingest.job_queue` (written by the pg_cron `ingest-tick`); this table's earlier 60 s/2 min figures are superseded — 01's request-budget etiquette math is the binding contract. Halts/auction states are parse outputs written to `public.security_status`. |
| `movers_breadth_agg` | every 10 min during any open session (post-scrape) | cross-venue movers, adv/dec/unch; refreshes the heatmap/movers MVs. |
| pgmq consumers × 5 queues | continuous (`read_with_poll` 1 s; relaxes to 30 s outside 06:00–19:00 GST) | Concurrency: `q_ingest` 4, `q_pipeline` 2 (LLM-bound, **vt 600 s, qty 1**), `q_dispatch` 8, `q_email` 4, `q_maintenance` 2. Kill-switch flags re-checked between messages. |

(The former `feed_watchdog` VPS loop is deleted post-review: the freshness state machine's
single writer is the pg_cron sweep `ingest.sweep_feed_status()` — it must keep marking venues
OFFLINE precisely when this VPS is dead, so it cannot live here. See 01 §8 / 05 Revisions.)

### 4.3 VPS crontab (OS level, not business logic)

| Entry | Schedule | Purpose |
|---|---|---|
| `backup.sh` | `30 23 * * *` UTC | `pg_dump` → age-encrypt → R2; ping Healthchecks (§8) |
| `snapshot_sync` | `0 22 * * 5` UTC weekly | `rclone sync` of Storage buckets `raw-snapshots`, `filings-pdf` → R2 |
| unattended-upgrades | daily | OS patching; systemd `Restart=always` covers the worker |

### 4.4 GitHub Actions cron (non-production only)

| Workflow | Schedule | Purpose |
|---|---|---|
| `restore-drill.yml` | weekly, Sat | pulls the latest R2 dump, restores into a disposable Postgres service container, runs row-count sanity assertions, pings a Healthchecks check. This is the only scheduled Actions job. |

---

## 5. Queue choice: pgmq (not BullMQ + Redis)

**Decision: pgmq on Supabase.** Cost and correctness both point the same way.

- **Cost.** BullMQ needs Redis. Options were: Upstash free tier (10k commands/day — a
  60s-poll worker burns that before breakfast), Upstash paid (~$10+/mo), or Redis on the
  VPS ($0 but now the "stateless, rebuild-in-10-minutes" VPS holds irreplaceable queue
  state, which defeats its design). pgmq is $0 forever inside the existing Supabase plan.
- **Transactionality — the actual winner.** The newsroom's core invariant is
  "lake object write and its downstream job are atomic." With pgmq,
  `INSERT INTO lake_objects … ; SELECT pgmq.send('q_pipeline', …)` commits or rolls back
  as one transaction. With Redis you get the classic dual-write problem and need an outbox
  table anyway — at which point the outbox *is* the queue and Redis is decoration.
- **Auditability.** `pgmq.archive()` keeps consumed messages in an archive table — a free
  processing ledger that fits the platform's append-only audit culture and the Desk error
  queue (27a RETRY / MUTE 1H / RE-RUN actions are simple queries/re-sends against pgmq
  tables).
- **What BullMQ would have bought** — rate limiting, repeatable jobs, a dashboard — is
  respectively: a 20-line token bucket in the dispatcher (needed anyway for the 4-push/day
  and quiet-hours rules), pg_cron, and the Desk itself.
- **Throughput reality check.** Day-one volume is a few thousand messages/day; pgmq on a
  shared Supabase instance handles hundreds/sec. The scaling trigger is nowhere in sight.

Queues and their semantics:

| Queue | Producers | Consumers | Visibility timeout | Content |
|---|---|---|---|---|
| `q_ingest` | filings pollers, pg_cron nightly jobs | worker parse handlers | 120s | parse filing, verify dividend, refresh ownership, prospectus → objects |
| `q_pipeline` | lake triggers (VERIFIED object with newsworthiness flag), Desk actions | agent pipeline | 600s (LLM steps are slow) | draft → edit → rules → approval-queue insert; TPL-01 auto-publish path |
| `q_dispatch` | alert evaluator, halt detector, fan-out triggers | push/notification dispatcher | 60s | one message per (user, alert) with quota + quiet-hours gate at consume time |
| `q_email` | Wire Brief jobs, dunning, auth flows, alert email channel | SES sender | 120s | rendered-template refs, batched sends |
| `q_maintenance` | pg_cron | misc handlers | 300s | score batch shards, rollups, resets, purges |

Retry policy: pgmq redelivery after visibility timeout; handler increments a `read_ct`
check — after 5 attempts the message is archived and an `ops.incidents` row is written
(surfaces in the Desk error queue with RETRY/MUTE/→HUMAN actions).

---

## 6. Monitoring on $0

Primary observability is **the product itself** — the Desk feed-health board (24a) and
market-data ops screen (33a) are designed as ops consoles, so the ops tables are
first-class schema, not an afterthought:

- `ops.job_heartbeats(job_name pk, expected_interval_s, last_run_at, last_ok_at, last_error, consecutive_failures)` — every job upserts on completion. The `heartbeat_sentinel` pg_cron job turns silence into `ops.incidents` rows.
- `ops.job_runs(id, job_name, started_at, finished_at, ok, detail jsonb)` — append log, 30-day retention, powers the 30-day ops stats on 33a.
- `ops.feed_status(venue, state, last_sync_at, latency_ms, retry_count, detail)` — the 6-state freshness machine's home; broadcast on the `feed_status` Realtime channel to every badge on every surface.
- `ops.incidents(id, severity, source, message, created_at, resolved_at, auto_expire)` — feeds the Desk needs-attention queue and incident banner composer.

External, all free tiers:

| Tool | Free tier | What it watches |
|---|---|---|
| **Sentry** (free) | 5k errors/mo, 1 user | Next.js app (`@sentry/nextjs`) + worker (`@sentry/node`). Sample rates tuned low; tracing off to stay under quota. |
| **Healthchecks.io** (free, 20 checks) | cron dead-man switches | one check per critical job: score_batch, wire_brief_am/pm, dunning, meter_reset, backup, restore-drill, filings_poll (rolled up as one "any venue succeeded in 15 min" ping), worker-alive (pinged every 5 min by the worker). Missed ping → email to owner. |
| **UptimeRobot** (free, 50 monitors, 5-min) | HTTP uptime | `https://marsad.com`, `https://marsad.com/api/health` (checks DB + pgmq depth + freshest heartbeat, returns 503 if degraded), Supabase project URL. |
| Vercel / Supabase built-in logs | included | request logs, Postgres logs, slow queries via `pg_stat_statements`. |
| journald on VPS | included | worker stdout; `RuntimeMaxSec` none, log rotation via journald defaults. |

Alert routing: everything terminates in the owner's email plus the Desk needs-attention
queue. No PagerDuty; the SLA culture of this product (3:00 approval SLA, T+9 parse) is
enforced by the Desk UI the owner already lives in.

**Deferred:** log aggregation SaaS, APM/tracing, status page (UptimeRobot's free public
status page can be enabled in one click when wanted).

---

## 7. Total monthly cost table

### 7.1 LLM usage model (basis for the three scenarios)

Day-one volume estimate (812 listings, ~60 filings/day across 6 venues, ~25 published
pieces/day, near-zero reader-AI traffic at launch, budget 50 answers/day):

- Extraction/classification (filings, dividends, IPO facts): ~25M input / 2M output tok/mo
- Writer + editor pipeline passes: ~15M in / 2M out
- Reader AI answers + thesis regenerations: ~5M in / 1M out
- **Total ≈ 45M input / 5M output tokens/month.** Embeddings extra but negligible (~$1 on
  any provider; $0 local).

| Scenario | Routing | Est. cost/mo |
|---|---|---|
| **A — Anthropic API** | Haiku 4.5 ($1/$5 per Mtok) for extraction; Sonnet 4.6 ($3/$15) for writer/editor/answers | List price ≈ $140 (extraction $35 + writing $105). With prompt caching on the stable rules/system prompts (reads ≈ 0.1×) and the Batch API (50% off) for non-urgent batches (score commentary, backfills): realistic **$75–100** |
| **B — OpenRouter open-source** (Hermes-class / Llama-70B / Qwen, $0.1–0.9 per Mtok) | one model class for everything | **$10–20** |
| **C — Ollama / LM Studio on owner's Mac** (via Tailscale) | local models; OpenRouter as automatic fallback when the Mac is unreachable | **$0–5** (fallback spillover) |

**DEFAULTED: Scenario B is the launch default** (cheapest-possible is locked; quality of
open-weights models is sufficient for extraction and TPL-01 wires, and every piece above a
wire passes the human approval gate anyway). The gateway (§9) makes A/B/C an env-file
change. Quality trigger to revisit: rules-check failure rate > 15% or owner send-back rate
> 30% on agent drafts → move the writer/editor roles (only) to Scenario A models.

### 7.2 The table

**This table is the platform-wide single source of truth for cost** (per-domain tables in
01/02/04/05 defer to it).

| Line item | Build phase (now) | At paid launch | Scaling trigger → next step |
|---|---|---|---|
| Supabase Pro (existing plan — verified; sunk) | **$25.00** | $25.00 | DB > 8 GB → disk $0.125/GB/mo (audit+analytics make ~$1–3/mo of this a year-2 certainty, budgeted); PITR add-on ~$100 only if RPO < 24h is ever justified |
| Vercel | **$0** (Hobby, pre-commercial build only) | **$20** (Pro, 1 seat) | Hobby ToS prohibits commercial use — flip to Pro at public/paid launch. Bandwidth > 1TB → review. |
| Hetzner CX22 VPS — **requires explicit owner sign-off** (the one deviation from "existing Supabase + Vercel"; every alternative is costlier or breaks the filings SLA, §3) | **$5.00** | $5.00 | CPU-bound on scrape+LLM concurrency → CX32 (~$8) or second worker box (~$5); queue depth alarms are the signal |
| Amazon SES (all email, day one) | **~$1.00** | ~$3–5 | $0.10 per 1,000 sends. At the fixture's 42k daily Wire Brief recipients: ~$127/mo — grows linearly with subscribers and is self-funding |
| LLM — Scenario B default | **~$15.00** | ~$15–25 | quality trigger (§7.1) → hybrid ≈ $25–40 (03 §11) → all-Anthropic ≈ $75–100; reader AI is credit-metered, so revenue-covered |
| Anti-bot/proxy reserve | **$0** | $0 | First sustained venue IP block → residential proxy for that venue only (~$5–15); until then deliberately unspent (01 §7 mitigations first) |
| Domain (.com at Cloudflare cost) | **~$0.90** | ~$0.90 | — |
| Cloudflare R2 (backups) | **$0** (≤10 GB free) | $0 | >10 GB → $0.015/GB-mo (still ~$1) |
| Sentry / UptimeRobot / Healthchecks / GitHub | **$0** | $0 | Sentry > 5k errors/mo → fix the errors first; CI minutes: cap `supabase start` runs to migration-touching PRs to stay inside 2,000 free min |
| Stripe | $0 fixed | $0 fixed | per-transaction 2.9%+ only — cost of revenue, not infra |
| Tailscale (Scenario C link) | $0 | $0 | — |
| **Total fixed** | **≈ $47/mo** | **≈ $70–80/mo** | Hybrid-LLM launch ≈ $80–95; all-Anthropic ≈ $130–150/mo |

For context against the design fixture's MRR (SAR 1.94M): even the maximal scenario is
noise. The honest cheapest-possible numbers are **≈ $47/mo during build** and **≈ $70–80/mo
at paid launch** — the previous $32/$54–66 figures relied on a Supabase tier that does not
exist and on Hobby Vercel for a commercial product.

---

## 8. Backup / DR

**Reality on the current plan:** the $10 Supabase plan does not include PITR (that is a
paid Pro add-on, ~$100/mo for 7 days) and managed daily backups are a Pro feature. So we
own our backups from day one:

- **Nightly logical backup** (`worker/ops/backup.sh`, 23:30 UTC): `pg_dump -Fc` of the
  full database over the direct connection string, encrypted with `age` (key held in the
  VPS env file and the owner's password manager), uploaded to Cloudflare R2 bucket
  `marsad-backups`. Retention: 30 dailies + 12 month-end dumps. Estimated size at launch
  < 1 GB compressed; free tier covers it.
- **4-hourly critical-schema dump** of `audit`, `public.subscriptions`,
  `public.invoices`, `public.lake_objects` (schema-scoped `pg_dump`) — cheap insurance
  that tightens effective RPO for the compliance-sensitive tables (ZATCA 10-year invoices,
  7-year audit) to 4 hours while the full-DB RPO stays 24h.
- **Storage buckets**: weekly `rclone sync` of `raw-snapshots` and `filings-pdf` to R2.
  These are the lake's lineage evidence; everything else in Storage is re-derivable.
- **Restore drill**: the weekly GitHub Actions `restore-drill.yml` (§4.4) restores the
  latest dump into a scratch Postgres container and asserts row counts on 6 sentinel
  tables. A backup that is never restored is a rumor.
- **VPS DR**: nothing to back up — `cloud-init.yml` + the deploy workflow recreate it.
- **Accepted risk, stated plainly:** RPO 24h for non-critical data / 4h for money+audit
  tables; RTO ~1–2h (new Supabase project or support-restored instance + `pg_restore` +
  repoint env vars). Trigger to buy down the risk: > 500 paying subscribers or the first
  time a restore is actually needed in anger → Supabase Pro ($25) for managed daily
  backups; PITR only if the business case ever survives its $100/mo price.

---

## 9. LLM gateway (provider-agnostic — locked requirement)

One module, `src/lib/llm/gateway.ts`, shared by the Next app (reader AI, on-demand
summaries) and the worker (agent pipeline). It speaks the **OpenAI-compatible
chat-completions wire format** over plain `fetch` — no provider SDK anywhere in the
codebase — because that is the one interface all three targets expose:

- **Anthropic** via its OpenAI-compatibility endpoint (`https://api.anthropic.com/v1/`),
- **OpenRouter** natively (`https://openrouter.ai/api/v1`),
- **Ollama / LM Studio** natively (`http://<tailscale-ip>:11434/v1`).

Env contract (identical on Vercel and the VPS):

```
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_API_KEY=sk-or-...
# role-based model routing — swap providers/models with zero code change
LLM_MODEL_EXTRACT=meta-llama/llama-3.3-70b-instruct
LLM_MODEL_WRITE=nousresearch/hermes-4-405b
LLM_MODEL_EDIT=nousresearch/hermes-4-405b
LLM_MODEL_ANSWER=meta-llama/llama-3.3-70b-instruct
LLM_MODEL_EMBED=text-embedding-...        # or local
# optional per-role overrides for split routing (e.g. extraction local, writing hosted)
LLM_EXTRACT_BASE_URL=
LLM_EXTRACT_API_KEY=
LLM_FALLBACK_BASE_URL=                     # Scenario C: OpenRouter fallback when Ollama is down
LLM_FALLBACK_API_KEY=
```

Gateway responsibilities (and nothing more): role → (base_url, key, model) resolution,
timeout/retry with jitter, 429/5xx backoff, token accounting into `ops.llm_usage`
(cost line on the Desk dashboard), fallback cascade, and a strict-JSON helper for
extraction roles. **DEFAULTED:** because the interface is locked to OpenAI-compat,
Anthropic-native features (prompt caching control, Batch API) are not reachable through
the gateway; if Scenario A becomes permanent, add a second transport behind the same
`complete(role, messages, opts)` signature — callers never change.

Local dev points `LLM_BASE_URL=http://localhost:11434/v1` (Ollama) out of the box.

---

## 10. CI/CD and migration discipline

### 10.1 Workflows

- **`ci.yml`** — on every PR and push to `main`:
  1. `npm ci` (app + worker), `tsc --noEmit` on both tsconfigs, `eslint`.
  2. Unit tests via `vitest` (to be added as the test runner; none exists yet).
  3. **Migration validation**: `supabase start` (CLI spins the local stack in the runner)
     → `supabase db reset` applies every file in `supabase/migrations/` from scratch →
     seed loads → a handful of `psql` assertions (RLS enabled on all public tables,
     `fn_run_rules` exists, cron jobs registered). This catches broken/reordered
     migrations before they ever meet prod.
  4. `supabase gen types typescript --local` and fail if the committed
     `src/lib/database.types.ts` is stale.
- **`deploy.yml`** — on push to `main` only: runs `supabase link --project-ref
  yjsncnpbjuueaoeejrqj` + `supabase db push` (applies pending *committed* migration files
  to prod) using `SUPABASE_ACCESS_TOKEN` / `SUPABASE_DB_PASSWORD` from GitHub Environment
  secrets. Vercel deploys the same commit automatically via its Git integration; since the
  two are not strictly ordered, **all migrations follow expand→migrate→contract**: new
  columns/tables land in one PR, code that uses them in the next, drops in a third. Boring
  and safe beats clever and ordered.
- **`worker-deploy.yml`** — on push to `main` touching `worker/**` or `src/lib/shared/**`:
  builds the worker (`tsc`), rsyncs `worker/dist` + `package.json` over SSH (deploy key in
  GitHub secrets), `npm ci --omit=dev`, `systemctl restart marsad-worker`, then curls the
  worker's local health endpoint. Rollback = re-run the workflow on the previous commit.
- **`restore-drill.yml`** — §8.

### 10.2 Migration discipline: migration-files-only (recommended and enforced)

- Every schema change is a file created with `supabase migration new <name>` and merged
  through a PR. **The Supabase dashboard SQL editor is never used for DDL on prod** — the
  one rule that keeps a solo-operator database honest. (The Supabase MCP
  `apply_migration` tool is acceptable during development because it also writes a
  migration record, but the file must land in the repo in the same session.)
- `supabase db push` in CI is the *only* thing that applies DDL to prod, so prod schema ==
  `main` by construction; drift is detectable with `supabase db diff --linked` (run in the
  weekly drill, warns if non-empty).
- Seeds live in `supabase/seed.sql` (see §11) and never run against prod.
- RLS is part of the migration for every table it touches — a table without an RLS policy
  in the same file fails review by convention (and the CI assertion above).

---

## 11. Environments & local dev

**Two environments: prod and local. No staging day one.**

Staging is deliberately deferred: there is one developer (the owner + agents), migrations
are validated from scratch in CI on every PR, expand/contract removes ordering risk, and
Vercel gives free **preview deployments** per PR for UI review. Preview deployments run
with **anon-key-only** env vars (no service-role key in previews), so anything they touch
in prod Postgres goes through RLS exactly like a real reader — previews can browse, not
mutate admin state. Triggers that would justify standing up staging (a second Supabase
free-tier project + a Vercel env, ~$0 but real maintenance): a second regular contributor,
the first migration incident that CI didn't catch, or the first external integration
(WhatsApp BSP, registrar API) that needs sandbox testing against fake data.

**Local dev loop:**

```
supabase start                 # full local stack: Postgres+pgmq+pg_cron, Auth, Storage, Realtime
supabase db reset              # applies all migrations + supabase/seed.sql
npm run dev                    # Next.js against local Supabase (env in .env.local)
cd worker && npm run dev       # worker against the same local stack, Ollama for LLM
```

`supabase/seed.sql` ships the **design-fixture moment** (SUN 12 JUL 2026 09:41 GST) so
every screen has real-looking data on first boot: 6 venues + market hours (incl. a Ramadan
1448 reduced-session row and one Hijri-confirm holiday), ~40 tickers across venues
(2222, 1120, 7010, QNBK, FAB, …), the stc 7010 DPS 0.50→0.55 lake object chain
(PENDING→VERIFIED→cited wire), one MSX DELAYED feed incident, ruleset V9 (R-01..R-10),
TPL-01..08 + the 14 BLK registry rows, 12 agent principals + 6 human roles, a handful of
subscribers in each subscription state (TRIALING, PAYING, PAST_DUE), and pgmq queues
created. Local LLM defaults to Ollama (`llama3.2` for everything) so the pipeline runs
end-to-end offline.

---

## 12. Secrets management

Principle: **each runtime gets exactly the secrets it needs, from its platform's native
store; GitHub Environments is the canonical distribution point for anything CI deploys.**
No secrets manager SaaS; no secrets in the repo, ever (`.env*` gitignored; a committed
`.env.example` documents every variable).

| Store | Holds | Used by |
|---|---|---|
| **GitHub Environment `production`** (secrets) | `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, VPS SSH deploy key, R2 credentials (for drill), Sentry DSNs | CI/CD workflows only |
| **Vercel project env vars** | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (server-only), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `LLM_*` | Next.js runtime (Preview scope gets anon key only — §11) |
| **VPS `/etc/marsad/worker.env`** (root:root, 0600, `EnvironmentFile=` in the systemd unit) | `SUPABASE_DB_URL` (direct Postgres), `SUPABASE_SERVICE_ROLE_KEY`, `LLM_*`, `AWS_SES_*`, R2 credentials, `AGE_BACKUP_KEY`, Healthchecks ping URLs | worker + backup scripts. Written once by hand at provision time; updated via `worker-deploy.yml` from GitHub secrets when rotated. |
| **Supabase Vault** | the few secrets SQL itself needs (currently: none planned; reserved for pg_net-style callouts) | Postgres |
| **`public.principals`** | *hashes* of the 12 agent scoped keys (the design's key-rotation and kill-switch model, 31a) | worker presents the plaintext from its env; DB verifies |

Rotation policy: quarterly for provider keys; agent keys per the rotation dates surfaced
on the Desk team roster (31a); immediately on any suspicion, with the break-glass
freeze-all flipping `principals.active=false` — the worker checks the flag before every
agent action, so a DB-side kill switch stops output even if VPS keys are stale.

---

## 13. Deliberately deferred (explicit, per the cheapest-possible mandate)

1. **Staging environment** — triggers in §11.
2. **Supabase Pro / PITR** — triggers in §8; owning backups is fine at this scale.
3. **Redis/BullMQ** — pgmq wins outright at this scale (§5); revisit only if queue
   latency ever matters at sub-second granularity.
4. **Supabase Edge Functions** — zero uses identified; keeping the runtime count at two.
5. **WhatsApp alert channel** (premium promise in the designs) — needs WhatsApp Business
   API/BSP contract, template approval and opt-in flows (open question #14). Designed-for
   in the dispatcher (`channel='whatsapp'` enum exists), not built.
6. **Boursa Kuwait (7th venue)** — open question #6; pollers are venue-config rows, so
   adding BK is config + one scraper module, not architecture.
7. **Dedicated search engine** — Postgres FTS + `pg_trgm` behind
   `src/app/api/search/route.ts`; trigger: p95 > 300ms or fuzzy-Arabic requirements
   (post-English-only era).
8. **Concall audio transcription pipeline** — Whisper on the VPS is feasible but slow on
   2 vCPU; day one, transcripts are ingested where venues/companies publish them; the
   T+40-min transcript SLA is **not committed** until this is built (flagged to owner).
9. **CDN/image pipeline beyond Vercel defaults**, multi-region reads, log aggregation,
   status page, APM — all $0-relevant only at scale that doesn't exist yet.

---

## 14. Open questions from design-analysis resolved with defaults in this document

| # | Question (design-analysis §7) | Default taken here |
|---|---|---|
| 5 | Wire Brief 07:30 vs 06:00/16:30 | Assemble 06:00 GST, send 07:30 GST; PM 16:30 GST trading days only. **DEFAULTED** |
| 6 | 6 vs 7 venues | 6 venues wired; BK is a config row away. **DEFAULTED** |
| 11 | realtime licensing matrix | Moot under scrape-only: every venue is DELAYED-class; freshness states still operate for halts/auction/stale. |
| 12 | server-side gating for blurred premium content | Confirmed: all gating in Vercel route handlers / RSC; gated text never ships to free clients. |
| — | meter reset moment | 04:05 GST on the 1st. **DEFAULTED** |
| — | LLM provider at launch | Scenario B (OpenRouter open-source), quality-triggered upgrade path. **DEFAULTED** |

---

## Revisions (post-review)

This document remains the **placement and cost authority** platform-wide. Fixes and
reconciliations:

1. **Worker credentials tightened** (§12, aligning with 01/05): the VPS connects to Postgres
   as a dedicated **`marsad_worker` role** (Supavisor session pooler, IPv4 — GCC exchange
   sites and the pooler path make the €0.50 IPv4 add-on necessary; direct-connection IPv6
   noted as the fallback) with **no grants on `billing.*` or IAM key/config tables**. The
   `SUPABASE_SERVICE_ROLE_KEY` in the worker env is used **only for Storage bucket uploads**
   (raw-snapshots, filings-pdf) — a documented least-privilege exception. `SUPABASE_DB_URL`
   in §12 becomes the `marsad_worker` connection string.
2. **Queue canon**: pgmq queues are exactly `q_ingest, q_pipeline, q_dispatch, q_email,
   q_maintenance` (03's stage names ride inside `q_pipeline` messages). One sanctioned
   non-pgmq queue exists: **`ingest.job_queue`** (01 §3.4) — a cadence-driven *fetch
   scheduler* table (priority, run_after, skip-when-closed) that pgmq's message semantics
   don't express; everything event-shaped stays pgmq. `q_pipeline` consumers must be
   **idempotent per (pipeline_item, stage)** — stage re-check before acting, archive before
   error-handling — since vt-based redelivery can occur mid-run (03 Revisions #2 defines the
   retry ownership split).
3. **Freshness single-ownership**: `ops.feed_status` in §2/§6 is renamed to the canonical
   **`public.venue_feed_status`** (02 §7, world-readable, + `closed` state); its single
   writer is the pg_cron sweep `ingest.sweep_feed_status()` (01 §8). The VPS `feed_watchdog`
   loop is deleted (§4.2) — a dead VPS must still turn badges OFFLINE. Realtime channels
   reduce to the Desk `agent-run-log` broadcast; the reader's wire/feed-status fan-out is
   polling (04 §4), which also removes Realtime message/connection overage risk from the
   scaling table.
4. **Edge Functions stay at zero** — confirmed against 03's revised runtime; the Supabase
   custom-claims hook ships as a **plain Postgres function**, not an Edge Function (05
   Revisions). `supabase/functions/` stays empty in v1.
5. **Backup gap closed** (§8): the 4-hourly critical-schema dump is now an explicit VPS
   crontab entry (`0 */4 * * *`, `pg_dump --schema=... audit billing`) with its own
   Healthchecks check — previously described but scheduled nowhere.
6. **Email reality** (§7/§4.1): SES is the platform's only sender **from day one**
   (including Supabase Auth SMTP; 04's Resend line is dropped). Owner toil with lead time,
   stated: SES sandbox-exit request, DKIM/SPF/DMARC on `mail.marsad.com`, and gradual warm-up
   before any 42k-recipient send — start in week 1, it takes days and blocks the Wire Brief
   at scale otherwise. Wire Brief schedule canon: **AM assemble 06:45 GST, send 07:30 GST
   daily; PM assemble 16:10, send 16:30 GST trading days (PM enabled in a later phase)** —
   §4.1 rows 3–4 read accordingly; 03 and 04 defer to this.
7. **LLM gateway spec is 03 §1** (provider registry + `LLM_ROLE_*` map + fallback chains +
   `ops.llm_runs` accounting); §9's env sketch is the abbreviated form of the same contract.
   Two caveats promoted from review: **embeddings never route through Anthropic** (no
   embeddings endpoint) — the embedder role resolves to in-process ONNX on the VPS ($0) or
   OpenRouter, regardless of scenario; and Anthropic's OpenAI-compat endpoint is a
   compatibility layer (max_tokens required, response_format ignored, no prompt
   caching/Batch) — acceptable for the swap guarantee, with a native transport behind the
   same `chatComplete` signature as the documented upgrade if Scenario A becomes permanent.
   pgvector/`doc_chunks` provisioning moves from day one to the AI phase (04 §7.2 wins:
   FTS-first).
8. **Retention completeness** (§4.1 job 20): added — intraday quote downsampling
   (`quotes_intraday` 3-month partitions per 02 §20; debut-day 1-min bars kept), analytics
   raw partitions pruned at **13 months per 02 §20** (the "90 days" here was wrong),
   `cron.job_run_details` purged > 7 days, `ops.llm_runs` > 12 months.
9. **Scraper self-test budgeted as a job** (§4.1 addition): a daily `scraper_selftest`
   asserting golden values per venue (row counts, known-ticker presence, numeric sanity) —
   converts silent parse drift into a Desk incident with zero marginal cost; pollers remain
   config-driven selectors (01 §4.4) to shrink mean-time-to-fix. Scraper breakage on six
   redesign-prone portals is the platform's largest accepted ongoing toil; monitoring makes
   it visible, the owner fixes it — stated plainly.
10. **Preview deployments** (§11): previews now point at the **local/seed stack via a second
    free Supabase project** (anon key of the preview project), not prod — previews could
    previously create real auth users/analytics rows and trigger real email through auth
    flows. The staging-trigger list gains "previews touching prod" retroactively satisfied.
11. **CI minutes**: `supabase start` migration validation runs only on PRs touching
    `supabase/migrations/**` (path filter) to keep an agent-heavy workflow inside the 2,000
    free minutes.
12. **Job-inventory dedup**: §4.1 is the only cron inventory. 05's table contributes
    `sweep_approval_sla`, `audit_anchor_daily`, `key_rotation_nudge` (and `frontpage_autoflow`
    already listed); 02 §21's rows map 1:1 onto §4.1 with "edge fn" mechanisms replaced by
    "pgmq → worker handler". Analytics rollup is hourly (job 14); 05's daily variant is
    dropped.
13. **Cost honesty** (§7.2): Supabase Pro $25 (verified live), VPS flagged for explicit owner
    sign-off, anti-bot reserve line added, totals restated (**$47 build / $70–80 launch**).
    The LLM launch default remains **Scenario B all-open-weights** (cheapest-possible lock);
    03's hybrid posture is the first quality-triggered upgrade, not the baseline.

*End of 06-infra-cost.md.*
