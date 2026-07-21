/**
 * Learn / methodology / legal hub (20f) — static content registry.
 *
 * No `use cache`, no Supabase read: every doc here is authored content
 * checked into the repo, not a database row. `learn/page.tsx` and
 * `learn/[docSlug]/page.tsx` render this registry directly.
 *
 * Two content classes, per the build brief — do not blur them:
 *  - `status: "final"` — factual, grounded in `docs/architecture/07-lake-enrichment.md`
 *    §3.4–3.7 (Marsad Score), `docs/architecture/04-reader-app.md` §8/§5, and
 *    `docs/architecture/00-master-plan.md` (venue coverage, delayed-only posture).
 *    Ships as real copy.
 *  - `status: "draft-legal"` — Terms of Service / Privacy Policy. These are
 *    STRUCTURED SKELETONS ONLY: section headings + placeholder guidance for what
 *    each clause must cover. No binding legal language is invented here — every
 *    paragraph is bracketed as a placeholder pending owner + outside-counsel
 *    review. Do not extend these with real clauses without that review.
 */

export type LearnDocCategory = "Methodology" | "Reference" | "Legal";
export type LearnDocStatus = "final" | "draft-legal";

export interface LearnDocTerm {
  term: string;
  definition: string;
}

export interface LearnDocTable {
  columns: string[];
  rows: string[][];
}

export interface LearnDocNote {
  kind: "info" | "important" | "draft";
  text: string;
}

export interface LearnDocBlock {
  /** Rendered as a black SectionBar band. Omit for a lead-in block under the H1. */
  heading?: string;
  paragraphs?: string[];
  bullets?: string[];
  /** Numbered list — used for the draft-legal clause skeletons. */
  ordered?: string[];
  terms?: LearnDocTerm[];
  table?: LearnDocTable;
  note?: LearnDocNote;
}

export interface LearnDoc {
  slug: string;
  title: string;
  /** Short one-liner — hub card copy + meta description fallback. */
  dek: string;
  category: LearnDocCategory;
  status: LearnDocStatus;
  /** draft-legal only: the banner shown at the top of the page. */
  draftNotice?: string;
  /** Editorial "content last reviewed" date, ISO. Display-only, never used for logic. */
  updated: string;
  blocks: LearnDocBlock[];
  /** Slugs of other docs to surface as "See also" at the foot of the page. */
  related?: string[];
}

export const LEARN_CATEGORY_ORDER: LearnDocCategory[] = ["Methodology", "Reference", "Legal"];

export const LEARN_DOCS: LearnDoc[] = [
  // ── Methodology ──────────────────────────────────────────────────────────
  {
    slug: "methodology",
    title: "How the Marsad Score works",
    dek: "A single 0–100 number built from five sector-relative factors — Value, Growth, Profitability, Momentum, and Revisions.",
    category: "Methodology",
    status: "final",
    updated: "2026-07-21",
    related: ["disclaimers", "glossary", "data-sources"],
    blocks: [
      {
        paragraphs: [
          "The Marsad Score is a 0–100 composite that ranks every covered company against its GCC-wide sector peers, not against the whole market. It is computed entirely from data already in Marsad's lake — filings, prices, and dividends — with no third-party model and no per-row cost.",
          "It updates nightly, after the day's prices and any new financial statements have landed, and it is always built on delayed data — see “Delayed data, always” below.",
        ],
      },
      {
        heading: "The five factors",
        paragraphs: [
          "Each factor is itself a weighted blend of a handful of underlying ratios, all computed the same direction: higher percentile is always better within that factor.",
        ],
        table: {
          columns: ["Factor", "Weight", "What it measures"],
          rows: [
            ["Value", "25%", "How cheap the shares are relative to earnings, book value, EBITDA and dividend yield — bank-sector names use a modified mix (no EV/EBITDA)."],
            ["Growth", "20%", "Year-over-year and multi-year trends in earnings and revenue."],
            ["Profitability", "20%", "Return on equity, return on capital (or net interest margin for banks), and margins."],
            ["Momentum", "20%", "Dividend- and split-adjusted price performance over the trailing 12, 6 and 3 months, plus position in the 52-week range."],
            ["Revisions", "15%", "Direction and breadth of analyst estimate changes. Launches as “—” — see “Data completeness” below."],
          ],
        },
      },
      {
        heading: "How scores are normalized",
        paragraphs: [
          "A raw ratio is meaningless on its own — a P/E of 12 is cheap for a bank and expensive for a utility. So before anything is scored, every metric is ranked as a percentile within its own sector cohort: all companies in that sector across all six GCC venues, together. A Saudi bank and a Qatari bank compete in the same “Banks” cohort — that cross-venue comparison is the platform's core idea.",
          "Two guardrails on that ranking: outliers are winsorized at the 2nd and 98th percentile first (so one mis-scraped number can't distort a whole sector), and a cohort needs at least 8 names before its percentiles are considered reliable — thinner sectors are flagged rather than silently scored.",
        ],
      },
      {
        heading: "From factors to a single number",
        paragraphs: [
          "The five factor scores are combined into a composite using the weights above, then that composite is re-percentiled across the full covered universe — so “76” means “76th percentile of every company Marsad scores,” a comparison that holds regardless of sector. The same composite, kept within-sector, produces the “Nth percentile of the sector” figure shown alongside it.",
        ],
      },
      {
        heading: "Rating bands",
        table: {
          columns: ["Score", "Rating"],
          rows: [
            ["80–100", "Buy"],
            ["60–79", "Overweight"],
            ["40–59", "Hold"],
            ["20–39", "Underweight"],
            ["0–19", "Sell"],
          ],
        },
      },
      {
        heading: "What's free vs. Premium",
        bullets: [
          "The headline score and rating are visible to everyone, on every covered stock page.",
          "The five underlying factor grades (letter grades, A+ through D-) are a Premium feature — a free view sees the headline number, not the breakdown behind it.",
        ],
      },
      {
        heading: "Data completeness & new listings",
        bullets: [
          "A factor only computes when enough of its inputs are available; if it can't, that factor shows “—” rather than guessing, and the composite reweights across the factors that did compute.",
          "A company needs at least three of the five factors before Marsad publishes a score at all — a two-input score isn't shown as if it were a full one.",
          "A newly listed company gets its first score once it has 90 trading days of history; before that, its score card is a placeholder, not a guess.",
          "If the newest financial statements behind a score are more than 18 months old, the score carries a staleness flag rather than quietly scoring on old books.",
        ],
      },
      {
        note: {
          kind: "info",
          text: "Scores recompute nightly from the prior day's close and the latest filings on record — like every figure on Marsad, they are built on delayed, not real-time, data.",
        },
      },
      {
        note: {
          kind: "important",
          text: "The Marsad Score is a research signal, not a recommendation to buy or sell. See Disclaimers.",
        },
      },
    ],
  },

  // ── Reference ────────────────────────────────────────────────────────────
  {
    slug: "glossary",
    title: "Glossary",
    dek: "Plain-language definitions for the price ratios, corporate-action dates, and score vocabulary used across Marsad.",
    category: "Reference",
    status: "final",
    updated: "2026-07-21",
    related: ["methodology", "data-sources"],
    blocks: [
      {
        paragraphs: [
          "Short, plain definitions for terms you'll see across stock pages, calendars and the Score — not a substitute for a finance textbook, just enough to read Marsad without a second tab open.",
        ],
      },
      {
        heading: "Prices & valuation",
        terms: [
          { term: "Market cap", definition: "Share price multiplied by total shares outstanding — the market's total valuation of the company." },
          { term: "Free float", definition: "The portion of shares actually available to trade publicly, excluding stakes held by founders, governments or strategic holders." },
          { term: "P/E (price/earnings)", definition: "Share price divided by earnings per share — how many years of current earnings the market is paying for." },
          { term: "P/B (price/book)", definition: "Share price divided by book value (equity) per share." },
          { term: "EV/EBITDA", definition: "Enterprise value (market cap plus net debt) divided by EBITDA — a valuation multiple that isn't distorted by how a company is financed." },
          { term: "Earnings yield", definition: "Earnings per share divided by price — the inverse of P/E, expressed as a percentage. Used instead of P/E inside the Score because it stays well-behaved when earnings are negative." },
          { term: "52-week range", definition: "The lowest and highest closing price over the trailing year, and where the current price sits within that band." },
        ],
      },
      {
        heading: "Dividends & corporate actions",
        terms: [
          { term: "Ex-date", definition: "The first trading day a share trades without the right to the next declared dividend. Own the shares before this date to receive the payout." },
          { term: "Record date", definition: "The date a company checks its share register to determine who is entitled to a declared dividend." },
          { term: "Pay date", definition: "The date the dividend cash is actually distributed to eligible holders." },
          { term: "DPS (dividend per share)", definition: "The cash amount paid per share for a given dividend." },
          { term: "Payout ratio", definition: "Dividends paid divided by net income — the share of earnings returned to shareholders. Above 100% means the company paid out more than it earned." },
          { term: "Special dividend", definition: "A one-off dividend outside a company's regular payout cadence, typically flagged separately from ordinary dividends." },
        ],
      },
      {
        heading: "Fundamentals",
        terms: [
          { term: "TTM (trailing twelve months)", definition: "A rolling 12-month figure built from the four most recent reported quarters, used so ratios aren't distorted by a single quarter or fiscal-year timing." },
          { term: "YoY (year over year)", definition: "The percentage change versus the same period one year earlier." },
          { term: "CAGR", definition: "Compound annual growth rate — the smoothed annual growth rate over a multi-year period." },
          { term: "ROE (return on equity)", definition: "Net income divided by shareholder equity — how efficiently a company turns its equity base into profit." },
          { term: "Net margin", definition: "Net income divided by revenue." },
        ],
      },
      {
        heading: "The Marsad Score",
        terms: [
          { term: "Factor", definition: "One of the Score's five components — Value, Growth, Profitability, Momentum, or Revisions. See Methodology." },
          { term: "Sector cohort", definition: "The GCC-wide group of companies in the same sector that a name is ranked against for percentile scoring." },
          { term: "Percentile rank", definition: "A company's position, 0–100, relative to its cohort — “84th percentile” means it ranks above 84% of its peers on that metric." },
          { term: "Winsorize", definition: "Capping extreme outlier values at a fixed percentile (Marsad uses the 2nd/98th) before ranking, so one bad data point can't distort an entire cohort." },
          { term: "Rating band", definition: "The Buy/Overweight/Hold/Underweight/Sell label mapped from a company's overall score." },
        ],
      },
      {
        heading: "Market structure",
        terms: [
          { term: "Venue", definition: "One of the six exchanges Marsad covers — Tadawul, DFM, ADX, QE, MSX or BHB." },
          { term: "Ticker", definition: "The short code a company trades under on its venue (e.g. 2222 on Tadawul)." },
          { term: "ISIN", definition: "The International Securities Identification Number — a globally unique code for a listed security, independent of any one venue's ticker." },
          { term: "Halted", definition: "Trading in a security temporarily paused by the exchange, usually pending a disclosure." },
          { term: "Delayed data", definition: "Every price on Marsad is at least 15 minutes behind the live market — see Data sources & coverage." },
          { term: "Filing", definition: "A disclosure a listed company is required to publish to its exchange — earnings, board decisions, ownership changes and more." },
          { term: "Consensus estimate", definition: "An aggregated forecast (e.g. of EPS) drawn from multiple analysts covering a stock." },
        ],
      },
    ],
  },
  {
    slug: "data-sources",
    title: "Data sources & coverage",
    dek: "What Marsad covers today: six GCC exchanges, gathered directly and scrape-only, always delayed.",
    category: "Reference",
    status: "final",
    updated: "2026-07-21",
    related: ["methodology", "disclaimers"],
    blocks: [
      {
        paragraphs: [
          "Marsad is built entirely on data gathered directly from each exchange's own public disclosure and quote pages — there is no paid market-data vendor behind it, and no real-time feed. Everything is delayed, snapshot-first, and attributed back to its source.",
        ],
      },
      {
        heading: "Six venues today, a seventh coming",
        table: {
          columns: ["Exchange", "Code", "Market"],
          rows: [
            ["Tadawul", "TDWL", "Saudi Arabia"],
            ["Dubai Financial Market", "DFM", "Dubai, UAE"],
            ["Abu Dhabi Securities Exchange", "ADX", "Abu Dhabi, UAE"],
            ["Qatar Exchange", "QE", "Qatar"],
            ["Muscat Stock Exchange", "MSX", "Oman"],
            ["Bahrain Bourse", "BHB", "Bahrain"],
          ],
        },
        bullets: [
          "Boursa Kuwait is not yet covered — it appears in venue listings as “coming soon” rather than being silently omitted.",
        ],
      },
      {
        heading: "What we collect",
        bullets: [
          "Quotes, polled every few minutes during each venue's trading session, plus end-of-day closing bulletins.",
          "Company filings and disclosures, gathered as each venue publishes them.",
          "Financial statements, extracted from filings (XBRL where a venue provides it) — the basis for the ratio strip and the Marsad Score.",
          "Dividend declarations, ex-dates and payout history.",
          "Earnings calendars and index levels.",
        ],
      },
      {
        heading: "Always delayed, always labeled",
        paragraphs: [
          "Every quote on Marsad is delayed at least 15 minutes, and often more depending on a venue's polling cadence and trading hours. The DELAYED indicator in the masthead is permanent — Marsad never labels anything “live.” Each venue's own feed status (delayed, reconnecting, offline, or market closed) is shown rather than assumed.",
        ],
      },
      {
        heading: "Why scrape-only",
        paragraphs: [
          "Marsad does not currently hold a commercial data-license agreement with any exchange. All data is gathered by polite, publicly accessible scraping of each venue's own website — no tick data is stored, requests are rate-limited, and the source is attributed on every figure that came from a filing.",
        ],
      },
      {
        heading: "Coverage still filling in",
        bullets: [
          "Some data tiers — analyst estimates, disclosed ownership/holders, the IPO calendar, earnings-call transcripts — are still being built out. Where a tier has no data yet, Marsad shows an honest “Awaiting feed” state rather than a fabricated number or a fake zero.",
        ],
      },
    ],
  },

  // ── Legal ────────────────────────────────────────────────────────────────
  {
    slug: "disclaimers",
    title: "Disclaimers",
    dek: "Marsad is research and data, not investment advice. Read this before you rely on anything you see here.",
    category: "Legal",
    status: "final",
    updated: "2026-07-21",
    related: ["terms", "privacy", "methodology"],
    blocks: [
      {
        note: {
          kind: "important",
          text: "Nothing on Marsad is investment, legal, or tax advice.",
        },
      },
      {
        heading: "Not investment advice",
        paragraphs: [
          "Marsad publishes prices, filings, calculated ratios, the Marsad Score, and editorial coverage of GCC-listed companies for informational purposes. None of it is a personalized recommendation to buy, sell, or hold any security, and it does not account for your individual financial situation. Decisions you make based on Marsad are your own.",
        ],
      },
      {
        heading: "Delayed data",
        paragraphs: [
          "Every price, quote, and index level on Marsad is delayed by at least 15 minutes, and can lag further during venue disruptions or outside trading hours. Marsad is not a trading or execution venue, and nothing here should be used to time a trade to the minute.",
        ],
      },
      {
        heading: "No guarantee of accuracy",
        paragraphs: [
          "Marsad's data is gathered by scraping each exchange's own public pages, not licensed from a data vendor. Source-site changes, parsing errors, and timing gaps can and do occur. Always check the primary filing or your broker before acting on a figure you see here.",
        ],
      },
      {
        heading: "The Marsad Score is not a recommendation",
        paragraphs: [
          "The Score is an algorithmic, sector-relative, backward-looking ranking — see Methodology for exactly how it's computed. A high score describes where a company ranks against its peers today; it is not a prediction, and past performance is not indicative of future results.",
        ],
      },
      {
        heading: "Use at your own risk",
        paragraphs: [
          "You use Marsad at your own risk. This page is an informational summary, not the binding legal terms governing your use of the service — those live in the Terms of Service, which (along with the Privacy Policy) is still under owner and legal review at this stage.",
        ],
      },
      {
        heading: "Copyright & data ownership",
        paragraphs: [
          "Underlying quotes and filings originate from each exchange and the companies that file them; Marsad does not claim ownership of that source data. Marsad's own commentary, computed ratios, and the Marsad Score are its own work product.",
        ],
      },
    ],
  },
  {
    slug: "terms",
    title: "Terms of Service",
    dek: "DRAFT — a placeholder structure only. Not yet reviewed by counsel; nothing here is binding.",
    category: "Legal",
    status: "draft-legal",
    draftNotice:
      "This page is a structural draft, not a finished contract. It exists so the link from Learn isn't dead — the section headings and one-line notes below describe what each clause needs to cover, not the clause itself. Do not rely on this text, and do not treat it as Marsad's actual Terms of Service until the owner and outside counsel have reviewed and replaced every placeholder.",
    updated: "2026-07-21",
    related: ["privacy", "disclaimers"],
    blocks: [
      {
        heading: "1. Acceptance of these Terms",
        paragraphs: [
          "[Placeholder — legal review required] State how a user is bound (account creation, continued use, or explicit acceptance), the effective date, and how updates are communicated.",
        ],
      },
      {
        heading: "2. Description of the Service",
        paragraphs: [
          "[Placeholder — legal review required] Marsad is an independent research platform covering GCC-listed equities: delayed prices, filings, calculated ratios, editorial coverage, and the Marsad Score, across free and paid subscription tiers. Confirm this description against the live feature set before publishing.",
        ],
      },
      {
        heading: "3. Eligibility & Accounts",
        paragraphs: [
          "[Placeholder — legal review required] Minimum age, account-registration accuracy obligations, credential security, one-account-per-person rules if any.",
        ],
      },
      {
        heading: "4. Subscriptions, Billing, Trials & Cancellation",
        paragraphs: [
          "[Placeholder — legal review required] Plan tiers and pricing, trial terms and when a card is charged, renewal and cancellation mechanics, refund policy, and VAT/tax treatment — align with the live billing configuration before publishing.",
        ],
      },
      {
        heading: "5. Acceptable Use",
        paragraphs: [
          "[Placeholder — legal review required] Prohibited conduct: scraping or bulk-extracting Marsad's own data, reverse engineering, abuse of shared infrastructure, redistribution of gated content.",
        ],
      },
      {
        heading: "6. Content, Data & Intellectual Property",
        paragraphs: [
          "[Placeholder — legal review required] Ownership of Marsad's editorial content, computed data (ratios, the Score) and branding; the limited license granted to a subscriber to view/use it; attribution of underlying exchange data (see Data sources & coverage).",
        ],
      },
      {
        heading: "7. Disclaimers & No Investment Advice",
        paragraphs: [
          "[Placeholder — legal review required] The binding version of the Disclaimers page: no investment advice, no accuracy warranty, “as-is” service, delayed-data posture.",
        ],
      },
      {
        heading: "8. Limitation of Liability",
        paragraphs: [
          "[Placeholder — legal review required] Liability cap and excluded damages, consistent with the governing-law jurisdiction chosen in section 10.",
        ],
      },
      {
        heading: "9. Termination",
        paragraphs: [
          "[Placeholder — legal review required] Grounds for suspending or terminating an account, effect on paid subscriptions, data retention/export after termination.",
        ],
      },
      {
        heading: "10. Governing Law & Dispute Resolution",
        paragraphs: [
          "[Placeholder — owner + legal decision required] Jurisdiction of incorporation and governing law are not yet finalized. Fill in once the operating entity and its jurisdiction are confirmed.",
        ],
      },
      {
        heading: "11. Changes to these Terms",
        paragraphs: [
          "[Placeholder — legal review required] Notice mechanism for material changes and effective-date handling.",
        ],
      },
      {
        heading: "12. Contact",
        paragraphs: [
          "[Placeholder] Legal/support contact address to be added once finalized.",
        ],
      },
    ],
  },
  {
    slug: "privacy",
    title: "Privacy Policy",
    dek: "DRAFT — a placeholder structure only, pending personal-data-protection-law review across our GCC markets.",
    category: "Legal",
    status: "draft-legal",
    draftNotice:
      "This page is a structural draft, not a finished policy. It exists so the link from Learn isn't dead — the section headings and one-line notes below describe what each section needs to cover, not the finished text. Do not rely on this page, and do not treat it as Marsad's actual Privacy Policy until the owner and outside counsel have reviewed and replaced every placeholder.",
    updated: "2026-07-21",
    related: ["terms", "disclaimers"],
    blocks: [
      {
        note: {
          kind: "draft",
          text: "Marsad operates across multiple GCC markets, each with its own personal-data-protection framework (among others: Saudi Arabia's PDPL, the UAE's PDPL, Qatar's Law No. 13 of 2016, and Bahrain's PDPL). Which regime(s) apply — and how — is an open question for owner + counsel to resolve before this page ships.",
        },
      },
      {
        heading: "1. Scope & Data Controller",
        paragraphs: [
          "[Placeholder — legal review required] Name and jurisdiction of the operating entity acting as data controller; which markets/users this policy covers.",
        ],
      },
      {
        heading: "2. What We Collect",
        paragraphs: [
          "[Placeholder — legal review required] Account/contact details, subscription and billing data (handled by a payment processor), product usage and analytics, and any data submitted through support requests.",
        ],
      },
      {
        heading: "3. How We Use Your Data",
        paragraphs: [
          "[Placeholder — legal review required] Service delivery, billing, product analytics, transactional email, and (if applicable) marketing communications with an opt-out.",
        ],
      },
      {
        heading: "4. Legal Basis for Processing",
        paragraphs: [
          "[Placeholder — legal review required] Map each processing activity to a legal basis (contract performance, consent, legitimate interest) under the applicable framework(s) from the note above.",
        ],
      },
      {
        heading: "5. Cookies & Similar Technologies",
        paragraphs: [
          "[Placeholder — legal review required] Categories of cookies used (essential/session vs. analytics), and the consent mechanism if required.",
        ],
      },
      {
        heading: "6. Sharing With Processors & Third Parties",
        paragraphs: [
          "[Placeholder — legal review required] Named categories of processors (e.g. hosting, database, payments, email delivery) and the safeguards governing each.",
        ],
      },
      {
        heading: "7. International Data Transfers",
        paragraphs: [
          "[Placeholder — legal review required] Where data is hosted/processed relative to the user, and the transfer mechanism if that crosses a jurisdiction with transfer restrictions.",
        ],
      },
      {
        heading: "8. Data Retention",
        paragraphs: [
          "[Placeholder — legal review required] Retention periods for account data, billing records, and usage logs, and deletion process on account closure.",
        ],
      },
      {
        heading: "9. Your Rights",
        paragraphs: [
          "[Placeholder — legal review required] Access, correction, deletion, and objection rights as granted under the applicable framework(s), and how to exercise them.",
        ],
      },
      {
        heading: "10. Children's Privacy",
        paragraphs: [
          "[Placeholder — legal review required] Confirm the service is not directed at children and state the minimum age from the Terms of Service.",
        ],
      },
      {
        heading: "11. Security",
        paragraphs: [
          "[Placeholder — legal review required] General statement of technical/organizational safeguards, without disclosing exploitable specifics.",
        ],
      },
      {
        heading: "12. Changes to This Policy",
        paragraphs: [
          "[Placeholder — legal review required] Notice mechanism for material changes.",
        ],
      },
      {
        heading: "13. Contact / Data Protection Officer",
        paragraphs: [
          "[Placeholder] Privacy contact address to be added once finalized.",
        ],
      },
    ],
  },
];

export function listLearnDocs(): LearnDoc[] {
  return LEARN_DOCS;
}

export function listLearnDocSlugs(): string[] {
  return LEARN_DOCS.map((d) => d.slug);
}

export function getLearnDoc(slug: string): LearnDoc | undefined {
  return LEARN_DOCS.find((d) => d.slug === slug);
}

/** Docs grouped by category, in the fixed display order (Methodology → Reference → Legal). */
export function listLearnDocsByCategory(): { category: LearnDocCategory; docs: LearnDoc[] }[] {
  return LEARN_CATEGORY_ORDER.map((category) => ({
    category,
    docs: LEARN_DOCS.filter((d) => d.category === category),
  }));
}

export function getRelatedLearnDocs(doc: LearnDoc): LearnDoc[] {
  if (!doc.related?.length) return [];
  return doc.related.map((slug) => getLearnDoc(slug)).filter((d): d is LearnDoc => d != null);
}
