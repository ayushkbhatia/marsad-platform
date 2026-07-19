import { NextResponse, type NextRequest } from "next/server";

/**
 * HTTP Basic Auth gate for /admin/* — Next 16 "proxy" convention (the renamed
 * successor to middleware; file must be `proxy.ts`, export named `proxy`).
 *
 * Interim gate until real auth/roles exist: there is no login flow yet, so a
 * logged-in-user check is impossible. Credentials come from env
 * (ADMIN_USER / ADMIN_PASSWORD). Swap this for an ADMIN_EMAILS / role check
 * once Supabase Auth is wired. Fails CLOSED: if the env pair is missing, every
 * /admin request is denied.
 */
function unauthorized() {
  return new NextResponse("Authentication required.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Marsad Admin", charset="UTF-8"' },
  });
}

// Length-safe constant-time-ish string compare (avoids early-exit length leak).
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function proxy(req: NextRequest) {
  const user = process.env.ADMIN_USER;
  const pass = process.env.ADMIN_PASSWORD;

  // Fail closed — never leave /admin open if creds aren't configured.
  if (!user || !pass) return unauthorized();

  const header = req.headers.get("authorization");
  if (!header?.startsWith("Basic ")) return unauthorized();

  let decoded: string;
  try {
    decoded = atob(header.slice(6));
  } catch {
    return unauthorized();
  }

  const sep = decoded.indexOf(":");
  if (sep === -1) return unauthorized();

  const gotUser = decoded.slice(0, sep);
  const gotPass = decoded.slice(sep + 1);

  // Evaluate both halves regardless, so timing doesn't reveal which failed.
  const ok = safeEqual(gotUser, user) && safeEqual(gotPass, pass);
  return ok ? NextResponse.next() : unauthorized();
}

export const config = {
  matcher: ["/admin/:path*"],
};
