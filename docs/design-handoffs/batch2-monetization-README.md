# Handoff: Marsad — Monetization Spine (4a–4d paywalls + 6a–6l account journey)

## What this is
Sixteen static, fully-resolved HTML exports covering **the entire monetization and account
surface**: the reusable paywall in all four of its contexts, and the complete sign-up →
verify → personalize → checkout → account → sign-out journey.

Every file is self-contained (no `support.js`, no `.dc.html` sibling files) and opens
standalone in a browser. Files are cross-linked by relative filename, so the whole flow is
clickable as-is.

| File | Screen |
|---|---|
| `Paywall - Article Gate 4a.html` | 4a — mid-read gate over the article page |
| `Paywall - Score AI Gate 4b.html` | 4b — Marsad Score / AI gate over the stock page |
| `Paywall - Screener Export 4c.html` | 4c — save & export gate over the dark screener |
| `Paywall - Metered Soft Wall 4d.html` | 4d — monthly free-read meter exhausted |
| `Sign Up - 6a.html` | 6a — sign up (SSO + email, value panel) |
| `Sign In - 6b.html` | 6b — sign in |
| `Forgot Password - 6c.html` | 6c — request reset link |
| `Set New Password - 6d.html` | 6d — set new password |
| `Verify Email - 6e.html` | 6e — check your inbox |
| `Personalize - 6f.html` | 6f — first run, step 1 of 2 |
| `Youre Set - 6g.html` | 6g — first run, step 2 of 2 |
| `Checkout - 6h.html` | 6h — Stripe checkout + order summary |
| `Payment Declined - 6i.html` | 6i — decline recovery |
| `Welcome to Premium - 6j.html` | 6j — receipt + unlocks |
| `Account Settings - 6k.html` | 6k — profile, billing, preferences, security |
| `Signed Out - 6l.html` | 6l — signed out |

## Fidelity
High-fidelity, pixel-accurate to the source design (`Marsad Platform.dc.html`, screen ids
`4a`–`4d`, `6a`–`6l`). These are **design references for recreating the screens in the
target codebase**, not production code to copy verbatim. All styling is inline for easy
inspection in devtools.

---

## Four things to get right before building

**1. `PaywallModal` is ONE component with four prop sets.** 4a/4b/4c/4d are not four
designs — they are the same 560px card over four different blurred backdrops. Build it once:

```
PaywallModal {
  dark?: boolean          // false → paper card; true → ink card (for the data room)
  eyebrow: string         // mono, .2em tracking, with the diamond mark
  chip?: string           // optional right-aligned mono chip; omit → no chip rendered
  title: string           // Newsreader 26px
  sub: string             // 13px, #57534a (light) / #a8a396 (dark)
  b1, b2, b3: string      // three benefit bullets
  cta: string             // routes to checkout (6h)
  note: string            // mono footnote, bottom-left
}
```

The prop sets used in this bundle:

| Screen | eyebrow | chip | note |
|---|---|---|---|
| 4a | `PREMIUM RESEARCH` | `24 MIN READ` | `3 OF 3 FREE READS USED THIS MONTH` |
| 4b | `MARSAD SCORE · AI RATING` | `✦ AI` | `AI RATINGS UPDATED 04:00 GST DAILY` |
| 4c | `DATA ROOM · EXPORT` | `CSV + ALERTS` | `FILTERS STAY APPLIED AFTER YOU UPGRADE` |
| 4d | `FREE MONTHLY LIMIT` | `3 / 3 READ` | `FREE METER RESETS 1 AUG · SAR 0 PLAN STAYS FREE` |

Backdrop treatment is fixed: the real page rendered at `filter: blur(2.5px);
pointer-events: none`, scrim `rgba(20,18,14,.55)`. Dark variant swaps the card to `#14120e`
on a `#33302a` border, bullets to `#4fc47f`, and inverts the CTA to `#f0ede2` on ink.

**2. The auth shell drops MarsadNav.** 6a–6e and 6l are a quiet `#f6f4ee` page: wordmark
only, content vertically centred, `#fdfcf9` cards with `#dcd8cc` borders, mono © footer.
Nothing to wander off to mid-signup. Build this shell once.

**3. 6k carries the LOGGED-IN MarsadNav variant.** "Sign in" + "Go Premium" are replaced by
a `PREMIUM` chip and a 32px circular `KA` avatar. **Every signed-in screen in the product
must use this variant** — a signed-in user seeing "Sign in" is precisely the bug this state
exists to prevent. It's a `user` + `plan` prop on the nav component, not a separate nav.

**4. Stripe must be re-skinned, not dropped in.** 6h shows the Payment Element themed into
the ink/paper system: square inputs, `#cfcabe` borders, `#14120e` focus border, IBM Plex
Mono for card/expiry/CVC values. Shipping Stripe's default skin breaks the design.

---

## Regional & lifecycle specifics that must survive

- **mada** appears in the accepted-card row on 6h, and 6i's "common fixes" panel names
  mada e-commerce toggles and daily online limits — GCC-specific decline causes.
- **KSA 15% VAT** is its own line item; VAT ID is an optional field; the annual plan shows
  an effective monthly rate (`≈ SAR 102.35 / MONTH · VS SAR 119 ON MONTHLY`).
- **Trial mechanics**: "Due today SAR 0.00", explicit first-charge date, and a promise to
  email three days before. 6j restates all of it as a receipt.
- **Decline recovery (6i)** keeps the order "STILL RESERVED", shows the raw decline code for
  support, keeps the failed field in `#c0342b` with an inline timestamp, and states attempts
  remaining before a 24h hold.
- **Security stances worth preserving verbatim**: 6c never reveals whether an address exists;
  6d warns that all other sessions end and forbids password reuse; 6e's resend is a disabled
  cooldown (`Resend — 0:42`), not an always-enabled button; 6k shows 2FA `OFF` with a
  recommendation and lists revocable devices.
- **Cancel is discoverable, never accidental**: "Cancel subscription" and "Switch to monthly"
  are plain underlined links in 6k, not buttons.
- **No dead ends**: 6l offers both "sign back in" and "read the free edition"; 6j returns the
  user to the article they were reading, not a generic dashboard; 4d names the meter reset
  date and affirms the free tier stays free.

## Data note
All copy and figures are **representative sample content**. Backing structures to model:
- `session { plan: 'free'|'trial'|'premium', user?, initials?, meter: { articlesRead, limit,
  resetsOn } }` — drives the nav variant, every paywall trigger, and 4d's counter.
- `paywallContext` — which trigger fired (article / score / export / meter), mapping to the
  prop set above. The gate is one component; the *trigger* is the data.
- `plan { id, interval: 'annual'|'monthly', basePrice, vatRate, currency, effectiveMonthly,
  trialDays }` — 6h's order summary, 6j's receipt, 6k's membership card.
- `paymentMethod { brand, last4, expiry }`, `invoices[] { date, description, amount,
  status: 'paid'|'scheduled', pdfUrl }` — 6k's billing table (note the scheduled future
  charge renders muted, with no PDF link).
- `declineState { code, attemptedCard, attemptsRemaining, holdHours, timestamp }` — 6i.
- `onboarding { markets[], sectors[], currency }` — 6f's two-state tiles/chips; 6g reads it
  back as prose. Both steps are skippable.

## Suggested build order
1. **`PaywallModal`** + the session/meter state that triggers it — it's referenced by screens
   already handed off (the 1k article mask, 1f's export controls, 3c's phrase-alert limit).
2. **Auth shell** → 6a/6b, then 6c/6d/6e off it.
3. **6f/6g** onboarding (needs the preferences model that 6k also edits).
4. **6h → 6i → 6j** as one checkout state machine.
5. **6k** last — it edits everything above, and it's where the logged-in nav variant lands.

## Where this fits
Sixteen screens from a 177-screen platform. For the complete system (all reader/mobile/email
screens, the Marsad Desk admin console, extracted components, and design tokens), see the
`design_handoff_marsad_platform/` package already in this project. The transactional emails
that pair with these screens (verify, reset, trial-ending, dunning, new sign-in) are turn 21
in that package.
