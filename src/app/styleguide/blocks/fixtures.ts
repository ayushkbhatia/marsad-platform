import type { BlockNode } from "@/components/blocks";

/*
 * Specimen fixtures for /styleguide/blocks.
 *
 * The content is lifted verbatim from
 * `docs/design/artifacts/artifact-library-61-blocks.html` so the rendered page
 * can be diffed against the card it claims to implement. Representative sample
 * content from the platform's own scenarios (Aramco gas mix, OQBI subscription,
 * stc dividend) — not live data, and never presented as such.
 *
 * Two deliberate departures from the cards, both to satisfy a constraint the
 * card itself states but its specimen does not meet:
 *   - BLK-RANKROW shows 5 rows (the card draws 3, but its rule is "5–10 ROWS").
 *     The first three are the card's, verbatim.
 * and one to exercise the honest empty state:
 *   - BLK-BEATMISS's third row leaves `consensus` unbound, so the em-dash path
 *     is visible in the screenshot rather than only in a test.
 */

export interface Specimen {
  node: BlockNode;
  /** Card header — from ops.story_blocks.display_name. */
  title: string;
  /** Card header, right — allowed_piece_types. */
  pieceTypes: string;
  /** Card footer — the binding rule, verbatim. */
  bindingRule: string;
  /**
   * In-card annotation from the specimen. This is CARD CHROME, not part of the
   * block: an article would not print "NO AXES, NO LABELS" under a sparkline.
   * Where the annotation is genuinely the block's own footnote it is passed
   * through the payload instead (see BLK-FINTABLE et al).
   */
  annotation?: string;
}

/* ── G · Provenance & trust ──────────────────────────────────────────────── */

export const FAMILY_G: Specimen[] = [
  {
    title: "Lake object stamp",
    pieceTypes: "EVERY EXHIBIT",
    bindingRule: "MANDATORY UNDER EVERY CHART AND TABLE · NAMES OBJECT, AGENT AND SOURCE CLASS",
    annotation: "GREEN DIAMOND = VERIFIED · INK = DESK COMPUTATION · AMBER = PENDING",
    node: {
      _key: "g-prov-1",
      code: "BLK-PROV",
      boundObjectId: "FILING.SEGMENT.REVENUE:2222",
      payload: {
        objectType: "FILING.SEGMENT.REVENUE",
        entity: "2222",
        coverage: "29 QUARTERS",
        agent: "DATA-TDWL",
        verifiedAt: "09:04",
        sourceClass: "FILED STATEMENTS, NOT VENDOR FEED",
        status: "verified",
      },
    },
  },
  {
    title: "How this was built",
    pieceTypes: "RAIL · FOOTER",
    bindingRule: "AGENT CHIPS CARRY ◆, HUMANS DON'T · THE HUMAN IS ALWAYS LAST IN THE CHAIN",
    node: {
      _key: "g-agents-1",
      code: "BLK-AGENTS",
      payload: {
        narrative:
          "Data agents parsed 29 quarters of filings into the lake. A writer agent drafted from verified objects only; the desk edited, rules-checked and published under a human byline.",
        chain: [
          { name: "DATA-TDWL", isAgent: true },
          { name: "WRITER-2", isAgent: true },
          { name: "EDITOR-1", isAgent: true },
          { name: "L. AL-RASHID", isAgent: false },
        ],
      },
    },
  },
  {
    title: "Desk-estimate marker",
    pieceTypes: "ANY FORECAST",
    bindingRule: 'THREE SIGNALS AT ONCE: "E" SUFFIX, INK HEADER, BOLD VALUE · NEVER COLOUR ALONE',
    node: {
      _key: "g-estimate-1",
      code: "BLK-ESTIMATE",
      boundObjectId: "ESTIMATE.OBS:oqbi-ebitda-fy26",
      payload: {
        // Bare labels — the renderer owns the E suffix.
        actual: { label: "FY25", value: "328" },
        estimate: { label: "FY26", value: "344" },
        note: "Where a number is a desk computation rather than a company disclosure, the block says so — in the header, the values and the footnote.",
      },
    },
  },
  {
    title: "Held from writers",
    pieceTypes: "RARE · DESK",
    bindingRule: "PUBLISHING A GAP BEATS PUBLISHING A GUESS · SHOWS BOTH, PICKS NEITHER",
    node: {
      _key: "g-conflict-1",
      code: "BLK-CONFLICT",
      payload: {
        figure: "Q2 free cash flow",
        period: null,
        sources: [
          { label: "Vendor feed", value: "SAR 50.1B" },
          { label: "Filing (primary)", value: "SAR 50.4B", isPrimary: true },
        ],
        resolution: "Primary wins unless overridden.",
      },
    },
  },
  {
    title: "Rule applied",
    pieceTypes: "RISK FRAMING",
    bindingRule: "WHEN A RULE VISIBLY SHAPED THE COPY · CITES THE ID FROM THE PUBLISHING RULESET",
    annotation: "NAMING THE RULE IS THE POINT — THE READER LEARNS THE HOUSE STANDARD BY SEEING IT ENFORCED",
    node: {
      _key: "g-rule-1",
      code: "BLK-RULE",
      payload: {
        ruleId: "R-06",
        requirement:
          "stretched payout metrics are framed as risk, never as a recommendation.",
        automatedCheck: "The screener flags any payout above 100% automatically.",
      },
    },
  },
];

/** BLK-FRESH has exactly four states; the card draws all four stacked. */
export const FRESH_STATES: BlockNode[] = [
  { _key: "g-fresh-live", code: "BLK-FRESH", payload: { state: "live", timestamp: "14:32 GST" } },
  { _key: "g-fresh-delayed", code: "BLK-FRESH", payload: { state: "delayed", delayMinutes: 15, venue: "MSX" } },
  { _key: "g-fresh-closed", code: "BLK-FRESH", payload: { state: "closed", lastClose: "THU CLOSE" } },
  { _key: "g-fresh-offline", code: "BLK-FRESH", payload: { state: "offline", retryCount: 4 } },
];

/** BLK-PROV's three statuses — verified / desk computation / pending. */
export const PROV_STATES: BlockNode[] = [
  FAMILY_G[0].node,
  {
    _key: "g-prov-desk",
    code: "BLK-PROV",
    payload: {
      objectType: "ESTIMATE.OBS",
      entity: "2222",
      coverage: "FY26E",
      agent: "MARSAD DESK",
      verifiedAt: "09:11",
      sourceClass: "DESK MODEL, NOT A COMPANY DISCLOSURE",
      status: "desk",
    },
  },
  {
    _key: "g-prov-pending",
    code: "BLK-PROV",
    payload: {
      objectType: "FILING.CASHFLOW",
      entity: "1120",
      coverage: null,
      agent: "DATA-TDWL",
      verifiedAt: null,
      sourceClass: "FILED STATEMENTS, AWAITING CROSS-CHECK",
      status: "pending",
    },
  },
];

/* ── A · Inline ──────────────────────────────────────────────────────────── */

export const FAMILY_A: Specimen[] = [
  {
    title: "Inline instrument chip",
    pieceTypes: "ALL",
    bindingRule: "FIRST MENTION OF ANY LISTED NAME · HOVER → QUOTE CARD · BINDS MARKET.QUOTE LIVE",
    node: {
      _key: "a-ticker-1",
      code: "BLK-TICKER",
      boundObjectId: "MARKET.QUOTE:2222",
      payload: {
        hostText: "Gas is now a ninth of the top line at {0}, and Phase 3 came early.",
        tickers: [
          {
            ticker: "2222",
            changePct: "−0.6%",
            direction: "down",
            quote: { name: "Saudi Aramco", last: "27.15", change: "−0.16 (−0.6%)", venue: "TDWL · DELAYED 15 MIN" },
          },
        ],
      },
    },
  },
  {
    title: "Sentence delta",
    pieceTypes: "ALL",
    bindingRule: "ANY CHANGE THE READER SHOULD FEEL · MONO LIFTS IT OUT OF THE SERIF",
    annotation: "ARROW IS SEMANTIC, NOT LITERAL — A FALLING COST OF FUNDS IS GREEN",
    node: {
      _key: "a-delta-1",
      code: "BLK-DELTA",
      payload: {
        hostText: "CASA share rose {0} q/q while cost of funds fell {1}.",
        deltas: [
          // Arrow = the literal movement. Polarity = the reading. They can disagree.
          { magnitude: "110 bp", arrow: "up", polarity: "good" },
          { magnitude: "7 bp", arrow: "down", polarity: "good" },
        ],
      },
    },
  },
  {
    title: "Citation chip",
    pieceTypes: "AI · NOTES",
    bindingRule: "MANDATORY ON EVERY AI FACTUAL CLAIM (R-03) · BINDS LAKE.OBJECT.ID",
    node: {
      _key: "a-cite-1",
      code: "BLK-CITE",
      boundObjectId: "LAKE.OBJECT:filing-2222-fy25",
      payload: {
        hostText: "Unit cost came in 18% below Phase 1 {0} and the dividend covers to $58 Brent {1}.",
        citations: [
          { objectId: "FILING.ANNUAL:2222:FY25", label: "FY25 annual report, p.47", kind: "filing" },
          { objectId: "DESK.MODEL:2222:div-stress", label: "Desk model — dividend stress test", kind: "desk" },
        ],
      },
    },
  },
  {
    title: "Defined term",
    pieceTypes: "EXPLAINERS",
    bindingRule: "FIRST USE ONLY · DOTTED RULE, NEVER LINK BLUE · BINDS GLOSSARY.TERM",
    node: {
      _key: "a-term-1",
      code: "BLK-TERM",
      boundObjectId: "GLOSSARY.TERM:t-plus-2",
      payload: {
        hostText: "Because settlement is {0}, the {1} falls after the ex-date.",
        terms: [
          {
            term: "T+2",
            glossaryKey: "t-plus-2",
            label: "T+2 SETTLEMENT",
            definition: "A trade legally completes two business days after execution.",
          },
          // No definition supplied → dotted rule, no card. As the card draws it.
          { term: "record date", glossaryKey: "record-date" },
        ],
      },
    },
  },
  {
    title: "Inline sparkline",
    pieceTypes: "ALL",
    bindingRule: "WHEN DIRECTION MATTERS AND MAGNITUDE DOESN'T · MAX 30 POINTS",
    annotation: "NO AXES, NO LABELS, NO TOOLTIP. IF IT NEEDS A NUMBER IT IS NOT A SPARKLINE",
    node: {
      _key: "a-spark-1",
      code: "BLK-SPARK",
      payload: {
        hostText: "The series has been one-way since March {0} and shows no sign of turning.",
        // The card's rendered polyline, read back as a series (y inverted).
        series: [4, 6, 5, 11, 10, 15, 17],
      },
    },
  },
  {
    title: "Margin note",
    pieceTypes: "DEEP DIVES",
    bindingRule: "CONTEXT A READER MAY SKIP · NEVER LOAD-BEARING · AUTHORED, NOT BOUND",
    node: {
      _key: "a-margin-1",
      code: "BLK-MARGIN",
      payload: {
        hostText:
          "A 60% secondary component means most proceeds go to the parent rather than the balance sheet.",
        label: "NOTE",
        body: "Standard for GCC privatisation floats since 2019.",
      },
    },
  },
];

/* ── C · Tabular ─────────────────────────────────────────────────────────── */

export const FAMILY_C: Specimen[] = [
  {
    title: "Four-up stat strip",
    pieceTypes: "ALL",
    bindingRule: "3–5 CELLS MAX · ONE FACT EACH · NEVER A PLACE TO DUMP LEFTOVER NUMBERS",
    node: {
      _key: "c-statstrip-1",
      code: "BLK-STATSTRIP",
      payload: {
        cells: [
          { label: "GROSS CAPEX", value: "SAR 46bn" },
          { label: "CAPACITY", value: "2.0 bcf/d" },
          // −18% vs Phase 1 is the good news: semantic direction, so green.
          { label: "VS PHASE 1", value: "−18%", direction: "up" },
          { label: "FIRST GAS", value: "2028" },
        ],
      },
    },
  },
  {
    title: "Facts grid",
    pieceTypes: "IPO · PROFILE",
    bindingRule: "4 OR 8 CELLS · MECHANICS AND CONSEQUENCES MIXED DELIBERATELY",
    node: {
      _key: "c-keystats-1",
      code: "BLK-KEYSTATS",
      payload: {
        cells: [
          { label: "PRICE RANGE", value: "0.106–0.111" },
          { label: "RAISE", value: "≈ $660M" },
          { label: "MIN LOT", value: "OMR 11.10" },
          { label: "REFUNDS BY", value: "16 JUL" },
        ],
        footnote: "MIN LOT AND REFUND DATE ARE GCC-RETAIL ESSENTIALS — NEVER DROP THEM FOR SPACE",
      },
    },
  },
  {
    title: "Financials with estimate column",
    pieceTypes: "NOTE · DEEP DIVE",
    bindingRule: "MAX 8 ROWS INLINE · LONGER TABLES GO TO THE XLSX · BINDS FILING.FINANCIALS",
    node: {
      _key: "c-fintable-1",
      code: "BLK-FINTABLE",
      boundObjectId: "FILING.FINANCIALS:oqbi",
      payload: {
        unit: "OMR M",
        // Bare labels + an is_estimate flag. FY26E, the ink header and the bold
        // values are all produced by the renderer.
        periods: [
          { label: "FY23" },
          { label: "FY24" },
          { label: "FY25" },
          { label: "FY26", isEstimate: true },
        ],
        rows: [
          { label: "Revenue", values: ["742", "781", "804", "831"], emphasis: true },
          { label: "EBITDA", values: ["296", "312", "328", "344"] },
          { label: "Margin", values: ["39.9%", "40.0%", "40.8%", "41.4%"] },
        ],
        footnote: "FY26E COLUMN HEADER IS INK, VALUES ARE BOLD — A DESK ESTIMATE MUST NEVER READ AS AN ACTUAL",
      },
    },
  },
  {
    title: "Three paths",
    pieceTypes: "NOTE · FEATURE",
    bindingRule: "EXACTLY THREE · BASE ROW TINTED · EVERY PATH NEEDS AN OBSERVABLE TRIGGER",
    node: {
      _key: "c-scenario-1",
      code: "BLK-SCENARIO",
      payload: {
        title: "THREE PATHS TO 2028",
        rows: [
          {
            name: "Gas re-rate lands",
            eps: "2.24",
            returnPct: "+31%",
            returnDirection: "up",
            trigger: "Segment split at H1",
          },
          {
            name: "Base — our case",
            eps: "2.02",
            returnPct: "+20%",
            returnDirection: "up",
            trigger: "Phase 2 on schedule",
            isBase: true,
          },
          {
            name: "Crude drags",
            eps: "1.14",
            returnPct: "−13%",
            returnDirection: "down",
            trigger: "Base dividend cut",
          },
        ],
      },
    },
  },
  {
    title: "League table",
    pieceTypes: "RANKED LIST",
    bindingRule: "5–10 ROWS · RANK NUMERALS IN NEWSREADER, VALUES IN MONO",
    node: {
      _key: "c-rankrow-1",
      code: "BLK-RANKROW",
      payload: {
        rows: [
          { rank: 1, name: "Najm Insurance", venue: "QE", value: "8.8%", qualifier: "PAYOUT 118%", qualifierFlagged: true },
          { rank: 2, name: "Muscat Telecom", venue: "MSX", value: "6.1%", qualifier: "PAYOUT 74%" },
          { rank: 3, name: "stc", venue: "TDWL", value: "5.4%", qualifier: "PAYOUT 81%" },
          // Rows 4–5 added to meet the card's own 5-row minimum.
          { rank: 4, name: "Ahli Bank", venue: "MSX", value: "5.0%", qualifier: "PAYOUT 62%" },
          { rank: 5, name: "Aldrees", venue: "TDWL", value: "4.6%", qualifier: "PAYOUT 55%" },
        ],
        footnote: "THE RANKED METRIC ALWAYS CARRIES A QUALIFYING COLUMN — A YIELD TABLE WITHOUT PAYOUT IS A TRAP",
      },
    },
  },
  {
    title: "Actual vs consensus",
    pieceTypes: "EARNINGS",
    bindingRule: "BINDS FILING.EPS + CONSENSUS.EPS · REACTION IS T+0 CLOSE",
    node: {
      _key: "c-beatmiss-1",
      code: "BLK-BEATMISS",
      boundObjectId: "FILING.EPS:q2",
      payload: {
        rows: [
          {
            name: "SNB",
            ticker: "1180",
            actual: "0.79",
            consensus: "0.76",
            surprise: "+4.2%",
            surpriseDirection: "up",
            reaction: "+2.1%",
            reactionDirection: "up",
          },
          {
            name: "SABIC",
            ticker: "2010",
            actual: "0.38",
            consensus: "0.42",
            surprise: "−9.5%",
            surpriseDirection: "down",
            reaction: "−2.1%",
            reactionDirection: "down",
          },
          {
            // No consensus coverage → the gap is printed, never filled.
            name: "Bina",
            ticker: "BINA",
            actual: "0.11",
            consensus: null,
            surprise: null,
            surpriseDirection: "flat",
            reaction: "+0.4%",
            reactionDirection: "up",
          },
        ],
        footnote: "SURPRISE AND PRICE REACTION SIT SIDE BY SIDE — THEY DISAGREE MORE OFTEN THAN READERS EXPECT",
      },
    },
  },
  {
    title: "Dividend row",
    pieceTypes: "DIVIDENDS",
    bindingRule: "BINDS DIVIDEND.EXDATE · ONE ROW PER DECLARATION, NOT PER PAYMENT",
    node: {
      _key: "c-exdate-1",
      code: "BLK-EXDATE",
      boundObjectId: "DIVIDEND.EXDATE:7010",
      payload: {
        rows: [
          { ticker: "7010", type: "INTERIM", dps: "0.55", exDate: "13 JUL", yieldPct: "5.4%", payDate: "30 JUL" },
          { ticker: "NAJM", type: "SPECIAL", dps: "0.90", exDate: "14 JUL", yieldPct: "8.8%", payDate: "2 AUG" },
        ],
        footnote: "SPECIAL TYPE CHIP INVERTS TO INK · EX-DATE IS THE BOLD COLUMN, NOT PAY DATE",
      },
    },
  },
  {
    title: "Transposed comparison",
    pieceTypes: "2–4 NAMES",
    bindingRule: "METRICS AS ROWS, NAMES AS COLUMNS · MAX 4 NAMES, 8 METRICS",
    node: {
      _key: "c-compare-1",
      code: "BLK-COMPARE",
      payload: {
        names: [
          { ticker: "1120", name: "Al Rajhi" },
          { ticker: "QNBK", name: "QNB" },
        ],
        metrics: [
          { label: "MKT CAP (USD)", values: ["104.8B", "45.4B"], bestIndex: 0 },
          { label: "DIV YIELD", values: ["4.1%", "5.7%"], bestIndex: 1 },
        ],
        addSlot: true,
        footnote:
          "PRICES STAY LOCAL, MARKET CAP IS USD-NORMALISED · BEST-IN-ROW IS BOLD · EMPTY SLOT KEEPS ITS DASHED COLUMN SO THE GRID NEVER REFLOWS",
      },
    },
  },
];

/* ── B · Statement ───────────────────────────────────────────────────────── */

export const FAMILY_B: Specimen[] = [
  {
    title: "Argument in three lines",
    pieceTypes: "FEATURES · DEEP DIVES · NOTES",
    bindingRule: "EXACTLY THREE LINES — NOT TWO, NOT FOUR · EACH INDEPENDENTLY CHECKABLE",
    annotation: "THE THREE CLAIMS ARE WHAT THE FIT STAGE VERIFIES AGAINST THE LAKE",
    node: {
      _key: "b-thesis-1",
      code: "BLK-THESIS",
      payload: {
        claims: [
          "Gas now carries the growth: its share of revenue rose 180bp year on year.",
          "The dividend is covered by operating cash flow at the current Brent strip.",
          "Phase 3 capex lands before the tariff reset, not after it.",
        ],
      },
    },
  },
  {
    title: "Pull quote",
    pieceTypes: "FEATURES · DEEP DIVES",
    bindingRule: "A HUMAN VOICE, NEVER A RESTATED STATISTIC · ONE PER 1,500 WORDS",
    node: {
      _key: "b-pullquote-1",
      code: "BLK-PULLQUOTE",
      payload: {
        quote: "The reconciliation fails, which tells you the interim figures are cumulative.",
        attribution: "MARSAD DESK",
      },
    },
  },
  {
    title: "The number that matters",
    pieceTypes: "ALL",
    bindingRule: "ONE PER PIECE · THE FIGURE THE HEADLINE RESTS ON · ONE LAKE FIELD, NOT AN AGGREGATE",
    node: {
      _key: "b-bignum-1",
      code: "BLK-BIGNUM",
      payload: {
        value: "QAR 4.43bn",
        caption: "QNB net profit for the quarter ended 30 June 2026.",
        contextLine: "QAR 4.22bn a year earlier · +5.0%",
      },
      boundObjectId: "00000000-0000-4000-a000-0000000000b1",
    },
  },
  {
    title: "Rating card",
    pieceTypes: "NOTES",
    bindingRule: "ONLY ON PIECES WITH A FORMAL CALL, NEVER ON WIRES · MUST NAME THE PRIOR RATING",
    node: {
      _key: "b-verdict-1",
      code: "BLK-VERDICT",
      payload: {
        ticker: "2222",
        companyName: "Saudi Aramco",
        rating: "Neutral",
        priorRating: "Overweight",
        targetPrice: "SAR 29.50",
        upsidePct: "+4.1%",
        changedInThisNote: true,
      },
    },
  },
  {
    title: "Marsad Take · gated",
    pieceTypes: "FEATURES · NOTES",
    bindingRule: "THE HEADLINE STAYS READABLE · THE JUDGEMENT DOES NOT",
    annotation: "THE BLUR IS PRESENTATION — RLS WITHHOLDS THE ROW, SO THE COPY IS NEVER SENT",
    node: {
      _key: "b-take-1",
      code: "BLK-TAKE",
      payload: {
        headline: "Fair value sits below the current price on any Brent strip we can defend.",
        body: "Trim into strength; the gas mix does not yet offset the tariff reset.",
        entitlement: "locked",
      },
    },
  },
  {
    title: "What would change this view",
    pieceTypes: "NOTES · DEEP DIVES",
    bindingRule: "REQUIRED ON ANY PIECE WITH A VIEW · OBSERVABLE EVENTS OR THRESHOLDS, NEVER SENTIMENT",
    node: {
      _key: "b-falsify-1",
      code: "BLK-FALSIFY",
      payload: {
        falsifiers: [
          "Gas revenue share fails to exceed 12% by the Q4 filing.",
          "Operating cash flow falls below the declared dividend for two consecutive quarters.",
          "Phase 3 first gas slips beyond the tariff reset date.",
        ],
      },
    },
  },
];

/* ── H · Gates ───────────────────────────────────────────────────────────── */

export const FAMILY_H: Specimen[] = [
  {
    title: "Premium cut",
    pieceTypes: "METERED PIECES",
    bindingRule: "AFTER A COMPLETE THOUGHT · AFTER AT LEAST ONE DATA BLOCK",
    annotation: "THE READER SEES THE WORK BEFORE THE WALL — THE FIT STAGE RE-VERIFIES BOTH CLAIMS",
    node: {
      _key: "h-cut-1",
      code: "BLK-CUT",
      payload: {
        teaser:
          "The margin question is settled by the impairment line rather than the top line, and that is where the rest of this note goes.",
        afterBlockIndex: 6,
        dataBlocksBefore: 3,
      },
    },
  },
  {
    title: "In-article paywall band",
    pieceTypes: "METERED PIECES",
    bindingRule: "NAMES WHAT IS BEHIND THE WALL · NEVER A GENERIC 'SUBSCRIBE TO READ MORE'",
    node: {
      _key: "h-paywall-1",
      code: "BLK-PAYWALL",
      payload: {
        behindTheWall:
          "The full cost bridge, the 12-quarter margin series, and the desk's target with its falsifiers.",
        ctaLabel: "Start 14-day trial",
        reassurance: "cancel anytime",
      },
    },
  },
];
