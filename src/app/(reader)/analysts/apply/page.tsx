import type { Metadata } from "next";
import Link from "next/link";

/**
 * Apply to publish (20d) — static form shell. Per the task brief: do NOT wire
 * submission (no auth/backend endpoint exists yet — there is no
 * `coverage_applications` table or route handler). The form renders fully
 * styled and disabled, with an explanation instead of a fake success state.
 */

export const metadata: Metadata = {
  title: "Publish research on Marsad",
  description: "Apply to join the Marsad Coverage Desk — public, permanent track records and revenue share on reader subscriptions.",
};

const FOCUS_AREAS = ["Banks", "Energy", "Real estate", "Telecom", "Utilities", "Macro"];

export default function AnalystApplyPage() {
  return (
    <div className="mx-auto max-w-[720px] px-5 py-12 sm:px-8">
      <div className="border border-hairline bg-paper px-8 py-9 sm:px-10">
        <span className="font-ui text-[10px] font-bold tracking-[0.2em] text-ink-muted uppercase">
          Marsad Coverage Desk
        </span>
        <h1 className="mt-2.5 font-display text-heading font-bold leading-[1.1] tracking-[-0.015em] text-ink">
          Publish research on Marsad
        </h1>
        <p className="mt-2 font-ui text-[13px] leading-[1.6] text-ink-muted">
          Every call you publish is timestamped and scored in public — track records can&rsquo;t be
          edited retroactively. Tell us what you&rsquo;d cover and the desk lead will be in touch.
        </p>

        <div className="mt-5 grid grid-cols-1 gap-4 border-t border-b border-hairline py-3.5 sm:grid-cols-3">
          <div>
            <div className="font-mono text-[8px] tracking-[0.1em] text-ink-faint uppercase">Track record</div>
            <div className="mt-1 font-ui text-[11.5px] leading-[1.5] text-ink-mid">Public &amp; permanent</div>
          </div>
          <div>
            <div className="font-mono text-[8px] tracking-[0.1em] text-ink-faint uppercase">Revenue share</div>
            <div className="mt-1 font-ui text-[11.5px] leading-[1.5] text-ink-mid">On reader subscriptions</div>
          </div>
          <div>
            <div className="font-mono text-[8px] tracking-[0.1em] text-ink-faint uppercase">Tools</div>
            <div className="mt-1 font-ui text-[11.5px] leading-[1.5] text-ink-mid">Full workbench access</div>
          </div>
        </div>

        <form className="mt-5 flex flex-col gap-4">
          <fieldset disabled className="contents">
            <div>
              <span className="mb-1.5 block font-mono text-[8px] tracking-[0.1em] text-ink-faint uppercase">
                Coverage focus
              </span>
              <div className="flex flex-wrap gap-1.5">
                {FOCUS_AREAS.map((area) => (
                  <span
                    key={area}
                    className="border border-hairline-strong px-3 py-[6px] font-ui text-[11px] text-ink-muted"
                  >
                    {area}
                  </span>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1.5 block font-mono text-[8px] tracking-[0.1em] text-ink-faint uppercase">
                  Full name
                </span>
                <input
                  type="text"
                  placeholder="Your full name"
                  className="w-full border border-hairline-strong bg-paper px-3 py-2.5 font-ui text-[12.5px] text-ink placeholder:text-ink-faint"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block font-mono text-[8px] tracking-[0.1em] text-ink-faint uppercase">
                  Credentials
                </span>
                <input
                  type="text"
                  placeholder="CFA, FRM, prior firm…"
                  className="w-full border border-hairline-strong bg-paper px-3 py-2.5 font-ui text-[12.5px] text-ink placeholder:text-ink-faint"
                />
              </label>
            </div>

            <label className="block">
              <span className="mb-1.5 block font-mono text-[8px] tracking-[0.1em] text-ink-faint uppercase">
                A sample thesis (300 words)
              </span>
              <textarea
                rows={4}
                placeholder="Pick one GCC name and make the call you'd stake a record on…"
                className="w-full border border-ink bg-paper px-3 py-2.5 font-ui text-[12px] leading-[1.6] text-ink placeholder:text-ink-faint"
              />
            </label>
          </fieldset>

          <button
            type="button"
            disabled
            className="mt-1 block w-full cursor-not-allowed bg-ink px-0 py-3 text-center font-ui text-[12px] font-bold tracking-[0.06em] text-paper-tint uppercase opacity-60"
          >
            Submit application
          </button>
          <p className="text-center font-ui text-[11px] text-ink-faint">
            Applications aren&rsquo;t open yet — the intake form and desk-lead review workflow are
            still being built. In the meantime, reach the desk directly.
          </p>
        </form>
      </div>

      <div className="mt-5 text-center">
        <Link
          href="/analysts"
          className="font-mono text-[10px] tracking-[0.06em] text-ink-muted hover:text-ink hover:underline underline-offset-2"
        >
          ← Back to the Coverage Desk
        </Link>
      </div>
    </div>
  );
}
