import type { Metadata } from "next";

/**
 * Two-factor enable (design 17f) — a focused sub-task lifted out of Account
 * (6k, not built), keeping the nav + a breadcrumb back. Tinted page, 520px
 * card: QR + an ALWAYS-shown base32 fallback key, a 6-digit input (three box
 * states), and a recovery-code warning shown BEFORE the user commits — that
 * warning is what prevents lockouts. Sample-seeded, static — the real flow
 * (TOTP secret, verify, recovery codes) needs the `(auth)` group +
 * `auth.mfa_factors`, not built yet (DEF-TWOFACTOR-LIVE-DATA). `noindex`.
 *
 * The digit boxes are baked to the design's mid-entry state ("419" +
 * active caret) — this is a fidelity mock, not a live form.
 */
export const metadata: Metadata = {
  title: "Two-factor authentication",
  description: "Add two-factor authentication to your Marsad account.",
  robots: { index: false, follow: false },
};

const KEY = "MRSD 4KZ9 QX2P 7WLM";
const DIGITS: { v: string; state: "filled" | "active" | "empty" }[] = [
  { v: "4", state: "filled" },
  { v: "1", state: "filled" },
  { v: "9", state: "filled" },
  { v: "", state: "active" },
  { v: "", state: "empty" },
  { v: "", state: "empty" },
];

/** Decorative QR motif — the real payload (`qrPayload`) renders here once 2FA
 *  is wired; a fabricated scannable code would be dishonest, so this is a
 *  clearly-ornamental placeholder with finder squares. */
function QrPlaceholder() {
  return (
    <div className="grid h-[132px] w-[132px] grid-cols-9 grid-rows-9 gap-[2px] border border-hairline-strong bg-paper p-2" aria-hidden>
      {Array.from({ length: 81 }).map((_, i) => {
        const r = Math.floor(i / 9);
        const c = i % 9;
        const finder = (r < 3 && c < 3) || (r < 3 && c > 5) || (r > 5 && c < 3);
        const on = finder ? (r % 2 === 0 || c % 2 === 0) : (i * 7) % 3 === 0;
        return <span key={i} className={on ? "bg-ink" : "bg-transparent"} />;
      })}
    </div>
  );
}

export default function TwoFactorPage() {
  return (
    <div className="bg-paper-tint">
      <div className="mx-auto max-w-[1440px] px-7 py-10">
        <div className="mx-auto w-full max-w-[520px]">
          <div className="flex items-center gap-2 font-mono text-[9px] tracking-[0.1em] text-ink-faint uppercase">
            {/* Account (6k) isn't built — no `(auth)` group yet — so these stay
                inert rather than linking to a 404. */}
            <span className="cursor-not-allowed" title="Account — coming soon">Account</span>
            <span>·</span>
            <span>Security</span>
            <span className="text-ink-muted">/ Two-factor</span>
          </div>

          <div className="mt-3 border border-ink bg-paper px-8 py-8">
            <h1 className="font-display text-[24px] font-bold tracking-[-0.01em] text-ink">Add two-factor authentication</h1>
            <p className="mt-2 text-[12.5px] leading-[1.55] text-ink-muted">
              Scan the code with any authenticator app, then enter the 6-digit code to confirm.{" "}
              <span className="font-semibold text-ink">Step 1 of 2.</span>
            </p>

            <div className="mt-6 flex gap-6">
              <QrPlaceholder />
              <div className="flex-1">
                <div className="font-mono text-[8.5px] tracking-[0.12em] text-ink-faint uppercase">Can&apos;t scan? Enter this key</div>
                <div className="mt-2 border border-hairline-strong bg-paper-tint px-3 py-2.5 font-mono text-[14px] font-semibold tracking-[0.14em] text-ink">
                  {KEY}
                </div>
              </div>
            </div>

            <div className="mt-7 font-mono text-[8.5px] tracking-[0.12em] text-ink-faint uppercase">Enter 6-digit code</div>
            <div className="mt-2 flex gap-2.5">
              {DIGITS.map((d, i) => (
                <div
                  key={i}
                  className={`grid h-12 w-11 place-items-center font-mono text-[20px] font-semibold text-ink ${
                    d.state === "filled"
                      ? "border border-ink"
                      : d.state === "active"
                        ? "border-2 border-ink"
                        : "border border-[#cfcabe]"
                  }`}
                >
                  {d.v || (d.state === "active" ? <span className="h-6 w-px animate-pulse bg-ink" /> : null)}
                </div>
              ))}
            </div>

            <div className="mt-7 border-l-2 border-ink bg-paper-tint px-4 py-3">
              <div className="font-mono text-[8.5px] font-semibold tracking-[0.12em] text-ink uppercase">Recovery codes</div>
              <div className="mt-1.5 text-[11.5px] leading-[1.5] text-ink-muted">
                You&apos;ll get 10 single-use backup codes on the next step. Store them somewhere safe — they&apos;re the only way in
                if you lose your device.
              </div>
            </div>

            <div className="mt-7 flex items-center gap-3">
              <span className="cursor-pointer bg-ink px-5 py-2.5 font-ui text-[12.5px] font-semibold text-paper-tint">Verify &amp; continue</span>
              <span className="cursor-not-allowed font-ui text-[12.5px] font-semibold text-ink-muted underline underline-offset-[3px]">
                Cancel
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
