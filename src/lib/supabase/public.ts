import { createClient } from "@supabase/supabase-js";

/**
 * Cookieless anon-key Supabase client for PUBLIC, cacheable reads.
 *
 * This is a plain `createClient(url, anonKey)` with NO `cookies()` binding — the
 * deliberate counterpart to `server.ts`'s cookie-bound `createServerClient`.
 * The cookie-bound client calls `cookies()`, a request-time API that is
 * unavailable inside a `use cache` scope; touching it there silently opts every
 * "cached" read out to per-visitor dynamic rendering and runs one Supabase query
 * per visitor — the single biggest cost bug documented in 04-reader-app.md §3.1.
 *
 * Use this client for:
 *   - every `use cache` reader in `src/lib/data/*.ts`
 *   - every `/api/pulse/*` route handler (CDN-cacheable, shared across users)
 *
 * It reads ONLY tables/views that carry a permissive anon `SELECT` RLS policy
 * (or the `public.v_scores_public` headline wrapper). RLS is the enforcement
 * boundary — this key is the public anon key and is safe to run server-side in
 * shared, cached scope.
 *
 * The cookie-bound `createClient()` in `server.ts` remains the tool for
 * personalized, dynamic, per-visitor reads only.
 */
export function createAnonClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_URL is not set");
  if (!anonKey) throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY is not set");

  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
