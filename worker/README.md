# marsad-worker

The single resident Node process that runs on the Hetzner CX22 VPS
(06-infra-cost.md §3). It is deliberately **not** part of the Next.js build —
it has its own `package.json` and deploys via `worker-deploy.yml`, never to
Vercel (see `.vercelignore` at the repo root).

## What this skeleton does

- Connects to Postgres **as the `marsad_worker` role** (Supavisor session
  pooler in prod; 06 Revisions #1). No service-role PostgREST access — the
  service-role key env var exists only for future Storage bucket uploads.
- Runs one pgmq consumer loop per canonical queue: `q_ingest`, `q_pipeline`,
  `q_dispatch`, `q_email`, `q_maintenance` (06 §5), reading with
  `pgmq.read_with_poll(vt => 600, qty => 1)`.
- Dispatches messages to a **handler registry** keyed by the `handler` field
  of the message body. One demo handler ships: `noop`. Real pollers/agents/
  dispatch/email modules register their handlers as they are built.
- Retry policy per 06 §5: failed messages are left for vt redelivery; after
  5 delivery attempts the message is archived and an `ops.incidents` row is
  written. Successful messages are archived (the archive table is the
  processing ledger the Desk error queue reads).
- Upserts `ops.job_heartbeats` every 30s for `worker:alive` and one job class
  per queue (`worker:q_ingest`, ...). The pg_cron `heartbeat_sentinel` turns
  silence into incidents.
- Optional Healthchecks.io dead-man ping every 5 min (`HEALTHCHECK_URL`).
- Structured JSON logs on stdout (journald captures them on the VPS).
- Graceful drain on SIGTERM/SIGINT: consumers stop taking new messages,
  in-flight handlers get `SHUTDOWN_GRACE_MS` (default 30s) to finish, anything
  slower is abandoned safely — pgmq's visibility timeout redelivers it.

## Run locally

Prereqs: Node >= 22.9 (`npm run dev` uses `--env-file-if-exists`, added in
22.9), the Supabase CLI, and the repo's migrations (which create
the `ops` schema, the pgmq queues and the `marsad_worker` role).

```sh
# 1. Start the local Supabase stack from the repo root
supabase start
supabase db reset        # applies migrations + seed

# 2. Configure and run the worker
cd worker
npm i
cp env.example .env      # then set:
                         # SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
npm run dev
```

You should see JSON log lines: `database connected`, then one
`consumer started` per queue. Verify the heartbeat:

```sql
select * from ops.job_heartbeats where job_name like 'worker:%';
```

Send a test message and watch the `noop` handler pick it up:

```sql
select pgmq.send('q_maintenance', '{"handler":"noop","hello":"world"}'::jsonb);
```

> Local note: `supabase start` exposes Postgres as the `postgres` superuser;
> using it locally is fine. Production must use the `marsad_worker` role.

## Build / production

```sh
npm run build            # tsc -> dist/
npm start                # node dist/index.js (systemd runs exactly this)
```

Deployment, systemd unit and VPS provisioning live in `infra/` — see
`infra/README.md` for the owner runbook.

## Layout (target shape per 06 §3.1)

```
worker/src/
  index.ts          # boot: config, db, heartbeats, pgmq consumers
  config.ts         # env contract (mirrors env.example)
  db.ts             # postgres.js pool as marsad_worker
  consumer.ts       # pgmq read/archive/retry loop
  heartbeat.ts      # ops.job_heartbeats writer
  healthcheck.ts    # Healthchecks.io pinger
  log.ts            # structured JSON stdout logger
  handlers/         # handler registry (demo: noop)
  pollers/          # (future) venue scrapers + ingest.job_queue claimer
  agents/           # (future) newsroom pipeline consumers
  dispatch/         # (future) alert dispatch, quiet hours
  email/            # (future) SES senders
```
