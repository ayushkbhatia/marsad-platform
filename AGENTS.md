<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Documentation discipline

Docs here are load-bearing, not decoration: `docs/BUILD-STATUS.md` is the living source of truth for what's shipped/live/next, and `docs/architecture/*` are the domain specs. Keep them in sync with the code **in the same change** — never "done in code, stale in docs".

- **When you DEFER or park work:** log it in `docs/BUILD-STATUS.md` §7 (Deferred backlog) with a **trigger** (when to pick it up) and a **home** (the doc/phase it belongs to). A deferred item with no ledger row will be lost — treat "not written down" as "dropped".
- **When you COMPLETE + integrate work:** update the docs in the same commit — mark it done in BUILD-STATUS, remove it from §7 if it was parked there, and update the relevant domain doc (e.g. `architecture/07-lake-enrichment.md`). If a validation/exit-criterion existed, tick it.
- **When you find a doc that's wrong or stale:** fix it as you pass through; don't route around it.

Rule of thumb: someone reading only the docs should never be surprised by what the code actually does.
