# Contributing to Marsad

This repo is a single Next.js app (`src/`) with a sibling worker package
(`worker/`) and the Supabase schema (`supabase/`). Architecture docs live in
`docs/architecture/` — `02-data-lake.md` is the single source of truth for
table and column names; `06-infra-cost.md` owns placement, cost, and CI/CD
policy.

## Local dev quickstart

Prerequisites: Node 22+, Docker (for the Supabase local stack), the
[Supabase CLI](https://supabase.com/docs/guides/cli), and
[Ollama](https://ollama.com) for the LLM layer.

```bash
# 1. Full local Supabase stack: Postgres + pgmq + pg_cron, Auth, Storage, Realtime
supabase start

# 2. Apply every migration from scratch + load supabase/seed.sql
#    (the SUN 12 JUL 2026 design fixture — every screen has data on first boot)
supabase db reset

# 3. Web app — copy .env.example to .env.local first, point it at the local stack
npm ci
npm run dev

# 4. Worker (separate terminal) — same local stack
cd worker
npm ci
npm run dev
```

### Local LLM (Ollama)

The LLM gateway is provider-agnostic and speaks the OpenAI-compatible wire
format; locally it points at Ollama so the whole pipeline runs offline at $0:

```bash
ollama pull llama3.2
# in .env.local / worker env:
# LLM_PROVIDER=ollama
# OLLAMA_BASE_URL=http://localhost:11434/v1   # optional — this is the default
```

Ollama needs no API key. The full provider contract (per-provider keys,
`LLM_ROLE_*` model maps) is documented in `.env.example`.

Swapping to OpenRouter or Anthropic is an env-var change only — never import a
provider SDK.

## Migration discipline (enforced by CI)

Per `docs/architecture/06-infra-cost.md` §10.2 — these rules keep a
solo-operator database honest:

1. **Migration files only.** Every schema change is a file in
   `supabase/migrations/`, created by hand as
   `supabase/migrations/NNNN_<snake_case>.sql` using the next numeric prefix in
   the 02-data-lake.md §22 sequence (do **not** use `supabase migration new`,
   which generates timestamp prefixes that break the documented ordering), and
   merged through a PR. **The Supabase dashboard SQL editor is never used
   for DDL on prod.** (The Supabase MCP `apply_migration` tool is acceptable
   during development because it also records a migration — but the file must
   land in the repo in the same session.)

2. **Never `supabase db push` from a laptop to prod.** The target state is that
   CI/CD is the only thing that applies DDL to prod (a `deploy.yml` running
   `supabase db push` on push to `main`, per 06 §10.1). **Interim note:** that
   workflow is not yet implemented — until it lands, the owner applies
   committed-and-merged migrations to prod manually (`supabase link` +
   `supabase db push` from `main`, never from a feature branch). Drift is
   detectable with `supabase db diff --linked`.

3. **Naming convention.** Numeric prefix + snake_case topic, applied in
   lexicographic order (`0001_extensions.sql`, `0002_iam.sql`, …, `0014_rls.sql`
   — see 02-data-lake.md §22 for the authoritative sequence). Never renumber,
   rename, or edit a migration that has merged to `main`; write a new one.

4. **RLS ships in the same PR as the table.** A new table without an RLS policy
   fails review by convention — and CI asserts it mechanically
   (`scripts/assert-rls.sql`).

5. **Expand → migrate → contract.** Vercel deploys and DB pushes are not
   strictly ordered, so: new columns/tables land in one PR, code that uses them
   in the next, drops in a third. Boring and safe beats clever and ordered.

6. **Seeds never touch prod.** `supabase/seed.sql` is local/CI only.

### How CI gates migrations

On any PR (or push to `main`) touching `supabase/**` or
`scripts/assert-rls.sql`, the `db` job in `.github/workflows/ci.yml`:

1. starts a throwaway local Postgres (`supabase db start`),
2. applies **every** migration from scratch + seed (`supabase db reset`) —
   catching broken or reordered migrations before they meet prod,
3. runs `scripts/assert-rls.sql` via `psql -v ON_ERROR_STOP=1` — any table
   without RLS raises and fails the build.

The db job is path-filtered (06 Revisions #11) so routine app PRs don't burn
the 2,000 free Actions minutes on a Supabase stack boot.

## Branch & PR conventions

- `main` is protected and always deployable. Vercel auto-deploys every push to
  `main` via its Git integration (there is deliberately **no** web deploy
  workflow); the worker deploys via `.github/workflows/worker-deploy.yml`.
- Branch names: `feat/<slug>`, `fix/<slug>`, `db/<slug>` (migration-only PRs),
  `chore/<slug>`.
- Keep PRs small and single-purpose; migration PRs especially (see
  expand→migrate→contract above).
- All CI jobs must be green before merge. No force-pushes to `main`.
- Commit messages: imperative mood, subject ≤ 72 chars; reference the
  architecture doc section when implementing specified behavior.
- Secrets never enter the repo. `.env*` is gitignored; document every new
  variable in `.env.example` with a dummy value.

## CI/CD map

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | every PR + push to `main` | web: `tsc`, lint, `next build` (dummy env). worker: `tsc`. db: migrations-from-scratch + RLS assertions (path-filtered). |
| `worker-deploy.yml` | manual dispatch, or push to `main` touching `worker/**` / shared libs | SSH to the VPS, checkout the exact SHA, build, `systemctl restart marsad-worker`. Skips gracefully until `VPS_HOST` / `VPS_SSH_KEY` secrets exist. |
| `restore-drill.yml` | monthly cron + manual | pulls the latest prod backup via the Supabase CLI, restores into a scratch DB, asserts sentinel row counts (`scripts/sanity-counts.sql`), opens an issue on failure. Skips gracefully until Supabase secrets exist. |

Rollback for the worker: re-run `worker-deploy.yml` on the previous commit.
Rollback for the web app: redeploy the previous deployment in Vercel.
