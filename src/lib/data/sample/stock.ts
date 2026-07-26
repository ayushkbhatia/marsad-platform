/**
 * Stock workspace (design 3a–3d, Saudi Aramco / 2222) — SAMPLE / PLACEHOLDER.
 *
 * Same seam contract as the other `sample/*` modules. One shape per company,
 * reused across every ticker: `SAMPLE_STOCK` is the fully-resolved 2222
 * workspace the design bakes end-to-end, and for the fidelity pass every
 * `/stocks/[venue]/[ticker]` renders it (the workspace is a template, not a
 * one-off). Real per-ticker data re-wires by mapping onto these view-model
 * types and swapping `SAMPLE_STOCK` (DEF-STOCK-LIVE-DATA); the existing
 * `stock-overview.ts`/`stocks.ts`/`stock-events.ts` + wave-1 stock components
 * are the adapter basis.
 *
 * Financial figures are kept as pre-formatted strings (they carry thousands
 * separators / units straight from the design). No `server-only`: pure data.
 */
import type { StockWorkspace } from "@/lib/contracts/stock";

// ── Shared header ────────────────────────────────────────────────────────────

// ── Sample: Saudi Aramco (2222) ──────────────────────────────────────────────
const Q8 = ["Sep '24", "Dec '24", "Mar '25", "Jun '25", "Sep '25", "Dec '25", "Mar '26", "Jun '26E"];
const FY10 = ["FY17", "FY18", "FY19", "FY20", "FY21", "FY22", "FY23", "FY24", "FY25", "TTM"];
const OWN8 = ["Sep '24", "Dec '24", "Mar '25", "Jun '25", "Sep '25", "Dec '25", "Mar '26", "Jun '26"];

export const SAMPLE_STOCK: StockWorkspace = {
  header: {
    breadcrumb: ["Today", "Tadawul", "Energy · Integrated Oil & Gas"],
    ids: "ISIN SA14TG012N13 · SEDOL BKSC9Q0 · LAST UPDATED 14:32 GST",
    name: "Saudi Aramco",
    nameAr: "أرامكو السعودية",
    ticker: "2222",
    venueLabel: "TADAWUL · SAR",
    score: { value: 76, label: "BUY" },
    links: ["aramco.com ↗", "Tadawul listing ↗"],
    price: "27.15",
    currency: "SAR",
    change: { value: "−0.17 (−0.62%)", up: false },
  },

  overview: {
    keyRatios: [
      { label: "MARKET CAP", value: "SAR 6.48T" },
      { label: "PRICE", value: "27.15" },
      { label: "52W HIGH / LOW", value: "29.85 / 24.10" },
      { label: "P/E (TTM)", value: "15.8×" },
      { label: "BOOK VALUE", value: "SAR 5.49" },
      { label: "DIV YIELD", value: "4.7%" },
      { label: "ROCE", value: "24.1%" },
      { label: "ROE", value: "18.2%" },
      { label: "NET DEBT / EBITDA", value: "0.28×" },
    ],
    chartTabs: ["PRICE", "P/E", "SALES & MARGIN", "EV/EBITDA", "P/B"],
    chart: {
      areaPoints:
        "0.0,226.0 34.8,210.9 69.6,185.8 104.3,165.7 139.1,175.8 173.9,140.6 208.7,110.5 243.5,85.3 278.3,65.3 313.0,35.1 347.8,10.0 382.6,25.1 417.4,50.2 452.2,70.3 487.0,90.4 521.7,80.3 556.5,105.4 591.3,120.5 626.1,135.6 660.9,115.5 695.7,100.4 730.4,110.5 765.2,115.5 800.0,123.0 800,236 0,236",
      linePoints:
        "0.0,226.0 34.8,210.9 69.6,185.8 104.3,165.7 139.1,175.8 173.9,140.6 208.7,110.5 243.5,85.3 278.3,65.3 313.0,35.1 347.8,10.0 382.6,25.1 417.4,50.2 452.2,70.3 487.0,90.4 521.7,80.3 556.5,105.4 591.3,120.5 626.1,135.6 660.9,115.5 695.7,100.4 730.4,110.5 765.2,115.5 800.0,123.0",
      note: "1Y · SAR · SET PRICE ALERT +",
    },
    aboutHtml:
      "Saudi Aramco is the world's largest integrated oil and gas company, producing roughly one in every nine barrels of global crude supply from reserves concentrated in the Eastern Province[1]. The state holds 81.5% directly with a further 16% via PIF and Sanabil, leaving a free float of ~2.6%[2].",
    keyPoints: [
      "Three segments — Upstream, Downstream, Corporate — with gas rising to 11.4% of revenue",
      "Jafurah Phase 3 sanctioned Jul '26; 2.0 bcf/d additional processing by 2028",
      "Base dividend SAR 0.34/quarter defended across the cycle; performance-linked layer suspended",
      "Annual report filed 28 Mar '26 — concall transcript under Filings →",
    ],
    deskView: {
      quote: "Gas optionality is not in the price. Jafurah Phase 3 underwrites the dividend at $60 Brent.",
      byline: "Noor Al-Suwaidi · Overweight · PT SAR 31.00",
    },
    pros: [
      "Effectively debt-free: net debt/EBITDA 0.28×",
      "8-year average ROE of 22.4%",
      "Base dividend held through a $40 trough",
      "Gas revenue share compounding (+180 bp y/y)",
    ],
    cons: [
      "Trades at 4.9× book — premium to every supermajor",
      "Free float 2.6% caps index weight & liquidity",
      "Earnings still 88% crude-linked at current mix",
    ],
    prosConsNote: "PROS & CONS ARE MACHINE-GENERATED FROM FILINGS · EXERCISE CAUTION AND DO YOUR OWN ANALYSIS",
    peers: [
      { ticker: "2222", company: "Saudi Aramco", price: "SAR 27.15", pe: "15.8×", pb: "4.9×", yield: "4.7%", roe: "18.2%", evEbitda: "9.1×", mktCap: "$1.73T", ytd: "−2.4%", score: 76, self: true },
      { ticker: "ADNOCGAS", company: "ADNOC Gas", price: "AED 3.44", pe: "12.4×", pb: "3.1×", yield: "5.1%", roe: "26.4%", evEbitda: "7.8×", mktCap: "$72.2B", ytd: "+8.2%", score: 78 },
      { ticker: "OQGN", company: "OQ Gas Networks", price: "OMR 0.151", pe: "10.1×", pb: "2.2×", yield: "6.2%", roe: "21.8%", evEbitda: "8.4×", mktCap: "$3.4B", ytd: "+3.4%", score: 72 },
      { ticker: "2380", company: "Petro Rabigh", price: "SAR 7.82", pe: "—", pb: "1.4×", yield: "—", roe: "−4.1%", evEbitda: "11.2×", mktCap: "$18.3B", ytd: "−6.1%", score: 44 },
      { ticker: "BOROUGE", company: "Borouge", price: "AED 2.41", pe: "14.6×", pb: "2.9×", yield: "6.6%", roe: "20.2%", evEbitda: "8.9×", mktCap: "$19.6B", ytd: "+0.8%", score: 64 },
      { ticker: "IQCD", company: "Industries Qatar", price: "QAR 12.85", pe: "12.9×", pb: "1.9×", yield: "5.4%", roe: "15.1%", evEbitda: "9.8×", mktCap: "$21.4B", ytd: "−2.8%", score: 55 },
    ],
    peersMedian: "MEDIAN (EX-2222): P/E 12.7× · P/B 2.2× · YIELD 5.4% · ROE 20.2% · EV/EBITDA 8.9×",
  },

  financials: {
    quarterlyPeriods: Q8,
    quarterlyRows: [
      { label: "Revenue", strong: true, pdf: true, values: ["449,802", "441,680", "435,116", "428,240", "446,910", "452,384", "438,072", "444,500"] },
      { label: "Operating expenses", values: ["217,204", "216,872", "212,410", "210,566", "219,480", "221,940", "215,208", "218,100"] },
      { label: "Operating profit", strong: true, values: ["232,598", "224,808", "222,706", "217,674", "227,430", "230,444", "222,864", "226,400"] },
      { label: "OPM %", values: ["51.7%", "50.9%", "51.2%", "50.8%", "50.9%", "50.9%", "50.9%", "50.9%"] },
      { label: "Other income", values: ["4,210", "3,884", "4,466", "4,102", "3,948", "4,318", "4,530", "4,200"] },
      { label: "Finance cost", values: ["3,412", "3,506", "3,388", "3,470", "3,522", "3,610", "3,494", "3,550"] },
      { label: "Depreciation", values: ["42,180", "42,904", "43,266", "43,912", "44,388", "45,102", "45,610", "45,900"] },
      { label: "Profit before zakat & tax", values: ["191,216", "182,282", "180,518", "174,394", "183,468", "186,050", "178,290", "181,150"] },
      { label: "Zakat & tax %", values: ["47.2%", "47.5%", "47.1%", "47.3%", "47.4%", "47.2%", "47.3%", "47.3%"] },
      { label: "Net profit", strong: true, values: ["100,962", "95,698", "95,494", "91,926", "96,504", "98,234", "93,975", "95,450"] },
      { label: "EPS (SAR)", values: ["0.42", "0.40", "0.39", "0.38", "0.40", "0.41", "0.39", "0.39"] },
    ],
    quarterlyNote:
      "JUN '26E = MARSAD DESK ESTIMATE · CLICK A ROW FOR LINE-ITEM BREAK-UP · Q PDF LINKS TO THE ORIGINAL TADAWUL FILING",
    annualPeriods: FY10,
    annualRows: [
      { label: "Revenue", strong: true, values: ["988,462", "1,346,911", "1,236,810", "771,444", "1,346,838", "2,266,432", "1,858,441", "1,798,204", "1,772,146", "1,786,478"] },
      { label: "Operating profit", strong: true, values: ["520,304", "798,102", "702,440", "340,118", "694,222", "1,244,610", "968,412", "918,270", "904,412", "909,844"] },
      { label: "OPM %", values: ["52.6%", "59.3%", "56.8%", "44.1%", "51.5%", "54.9%", "52.1%", "51.1%", "51.0%", "50.9%"] },
      { label: "Net profit", strong: true, values: ["284,614", "416,196", "330,816", "183,764", "412,401", "604,010", "454,762", "404,581", "398,442", "402,140"] },
      { label: "EPS (SAR)", values: ["1.19", "1.74", "1.38", "0.77", "1.72", "2.52", "1.88", "1.67", "1.65", "1.66"] },
      { label: "DPS (SAR)", values: ["—", "—", "1.17", "1.17", "1.17", "1.23", "1.52", "1.36", "1.30", "1.30"] },
      { label: "Payout %", values: ["—", "—", "85%", "152%", "68%", "49%", "81%", "81%", "79%", "78%"] },
    ],
    cagr: [
      { title: "Compounded revenue growth", rows: [{ label: "8Y", value: "+7.7%" }, { label: "5Y", value: "+2.9%" }, { label: "3Y", value: "−7.6%" }, { label: "TTM", value: "+0.8%" }] },
      { title: "Compounded profit growth", rows: [{ label: "8Y", value: "+4.4%" }, { label: "5Y", value: "+16.9%" }, { label: "3Y", value: "−12.7%" }, { label: "TTM", value: "+0.9%" }] },
      { title: "Stock price CAGR", rows: [{ label: "5Y", value: "+3.1%" }, { label: "3Y", value: "−4.2%" }, { label: "1Y", value: "−6.8%" }, { label: "YTD", value: "−2.4%" }] },
      { title: "Return on equity", rows: [{ label: "8Y", value: "22.4%" }, { label: "5Y", value: "21.8%" }, { label: "3Y", value: "19.6%" }, { label: "Last", value: "18.2%" }] },
    ],
    balanceSheet: {
      rows: [
        { label: "Total assets", value: "1,802,388" },
        { label: "Shareholder equity", value: "1,318,226" },
        { label: "Gross debt", value: "196,388" },
        { label: "Net debt / EBITDA", value: "0.28×" },
      ],
      note: "AS OF FY25 · FULL 10-YEAR TABLE IN THE XLSX EXPORT",
    },
    cashFlow: {
      rows: [
        { label: "Cash from operations", value: "468,180" },
        { label: "Capex", value: "−174,610" },
        { label: "Free cash flow", value: "293,570" },
        { label: "Dividends paid", value: "−310,180" },
      ],
      note: "TTM · DIVIDENDS PAID INCLUDES PERFORMANCE-LINKED COMPONENT",
    },
  },

  filings: {
    announcements: [
      { date: "5 JUL 26", regId: "TADAWUL · CG-1", tag: "DIVIDEND", title: "Board resolution — Q2 2026 interim dividend of SAR 0.34 per share", summary: "Ex-date 8 July, record 9 July, payable 4 August. Base dividend unchanged; performance-linked component suspended for the quarter." },
      { date: "4 JUL 26", regId: "TADAWUL · M-2", tag: "CAPEX", title: "Jafurah Phase 3 development sanctioned — SAR 46bn gross capex", summary: "Adds 2.0 bcf/d processing capacity by 2028. Financing mix: operating cash flow plus existing sukuk programme headroom." },
      { date: "28 JUN 26", regId: "TADAWUL · FS-4", tag: "RESULTS", title: "Notice of H1 2026 results publication date", summary: "Interim consolidated financial statements to be published Tuesday 4 August 2026, pre-market, followed by a webcast at 16:00 AST." },
      { date: "19 JUN 26", regId: "TADAWUL · CG-7", tag: "RATING", title: "Credit rating affirmed at A+ / A1, outlook stable", summary: "Agencies cite gas diversification and balance-sheet headroom; note dividend flexibility as a rating support." },
      { date: "11 JUN 26", regId: "TADAWUL · RPT-1", tag: "RPT", title: "Related-party framework agreement with SABIC renewed", summary: "Feedstock supply and offtake arrangements renewed on arm's-length terms for three years from January 2027." },
    ],
    earningsCalls: [
      { quarter: "Q1 2026 results call", date: "12 MAY 26", aiSummary: 'Gas mix reaches 11.4% of revenue; management reiterates FY26 capex of SAR 190–210bn and defends the base dividend at "any plausible Brent deck". Q&A pressed on Jafurah Phase 3 timing (sanctioned early, answered directly) and on downstream margin softness (acknowledged, framed as cyclical). Tone: confident, unusually specific on gas economics.' },
      { quarter: "Q4 2025 results call", date: "9 MAR 26" },
      { quarter: "Q3 2025 results call", date: "4 NOV 25" },
      { quarter: "Q2 2025 results call", date: "5 AUG 25" },
    ],
    reports: [
      { title: "Annual Report FY25", date: "28 MAR 26" },
      { title: "Annual Report FY24", date: "25 MAR 25" },
      { title: "Annual Report FY23", date: "27 MAR 24" },
      { title: "Sustainability Report FY25", date: "14 APR 26" },
      { title: "Bond & Sukuk Prospectus", date: "9 JAN 26" },
    ],
    phraseAlerts: {
      active: ['"dividend"', '"Jafurah"'],
      suggestions: ["buyback", "guidance"],
      note: "2 OF 2 FREE ALERTS USED · PREMIUM = 50",
    },
    nextEvents: [
      { date: "8 JUL", label: "Ex-dividend · SAR 0.34" },
      { date: "4 AUG", label: "H1 2026 results + webcast 16:00 AST" },
      { date: "Q4 '26", label: "Jafurah Phase 2 first gas — guidance" },
    ],
    relatedResearch: [
      { headline: "Aramco after Jafurah Phase 3: gas optionality repriced", meta: "PREMIUM · L. AL-RASHID · 4 JUL" },
      { headline: "Dividend durability: stress-testing 2222 at $60 Brent", meta: "PREMIUM · DESK MODEL · 29 JUN" },
    ],
  },

  ownership: {
    periods: OWN8,
    foreignAtRecord: "FOREIGN OWNERSHIP AT RECORD 1.19%",
    rows: [
      { label: "Government of Saudi Arabia", values: ["81.48%", "81.48%", "81.48%", "81.48%", "81.48%", "81.48%", "81.48%", "81.48%"] },
      { label: "Public Investment Fund (PIF)", values: ["12.00%", "12.00%", "12.00%", "12.00%", "12.00%", "12.00%", "12.00%", "12.00%"] },
      { label: "Sanabil Investments", values: ["4.00%", "4.00%", "4.00%", "4.00%", "4.00%", "4.00%", "4.00%", "4.00%"] },
      { label: "Foreign institutions", values: ["0.82%", "0.86%", "0.91%", "0.98%", "1.04%", "1.09%", "1.14%", "1.19%"] },
      { label: "GCC institutions", values: ["0.44%", "0.43%", "0.42%", "0.41%", "0.40%", "0.40%", "0.39%", "0.38%"] },
      { label: "Retail & other public", values: ["1.26%", "1.23%", "1.19%", "1.13%", "1.08%", "1.03%", "0.99%", "0.95%"] },
    ],
    shareholderCount: ["2.94m", "2.91m", "2.88m", "2.84m", "2.81m", "2.79m", "2.76m", "2.74m"],
    topHolders: [
      { name: "Government of Saudi Arabia", type: "Sovereign", pct: "81.48%", change: "unchanged" },
      { name: "Public Investment Fund", type: "Sovereign wealth", pct: "12.00%", change: "unchanged" },
      { name: "Sanabil Investments", type: "PIF subsidiary", pct: "4.00%", change: "unchanged" },
      { name: "Vanguard Emerging Markets", type: "Foreign passive", pct: "0.31%", change: "+0.02", changeDir: "up" },
      { name: "BlackRock Frontiers", type: "Foreign active", pct: "0.22%", change: "+0.04", changeDir: "up" },
      { name: "Norges Bank IM", type: "Foreign sovereign", pct: "0.14%", change: "−0.01", changeDir: "down" },
    ],
    topHoldersAsOf: "MAR '26 DISCLOSURES",
    floatWatchHtml:
      "Free float is <b>2.6%</b> (≈ SAR 168bn). A 1% government sell-down would roughly <b>double</b> tradable supply — the single largest overhang debate on the name.",
    board: [
      { name: "Yasir O. Al-Rumayyan", role: "Chairman", since: "2019" },
      { name: "Amin H. Nasser", role: "President & CEO", since: "2015" },
      { name: "Mohammed Y. Al-Qahtani", role: "Downstream President", since: "2020" },
      { name: "Sir Mark Moody-Stuart", role: "Director", since: "2016" },
      { name: "Lynn Laverty Elsenhans", role: "Director", since: "2018" },
      { name: "Mark Weinberger", role: "Director · Audit chair", since: "2020" },
    ],
    boardMeta: "11 SEATS · 5 INDEPENDENT",
    management: [
      { name: "Amin H. Nasser", role: "President & Chief Executive Officer", bio: "With the company since 1982; CEO since 2015. Led the 2019 IPO and the gas expansion programme." },
      { name: "Ziad T. Al-Murshed", role: "EVP & Chief Financial Officer", bio: "CFO since 2021. Architect of the base + performance-linked dividend framework." },
      { name: "Nasir K. Al-Naimi", role: "President, Upstream", bio: "Oversees Jafurah delivery and the 12 mbd MSC maintenance programme." },
    ],
  },
};
