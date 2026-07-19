import { createClient } from "@supabase/supabase-js";

/**
 * Server-ONLY Supabase client using the service-role key.
 *
 * Bypasses RLS — never import this into a Client Component or ship the key to
 * the browser. It exists so admin/ops server routes can read the
 * `public.v_lake_landing_*` wrapper views (service_role-only grants; see
 * migration 20260719170000). Access to /admin is gated separately in
 * middleware.ts (HTTP Basic Auth) until real auth/roles land.
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error("SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL is not set");
  if (!serviceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");

  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
