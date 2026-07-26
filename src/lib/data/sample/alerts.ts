/**
 * Alerts manager (5a) + Notifications panel (16b) — SAMPLE content.
 *
 * These two surfaces share one source model (README: "Shares its source model
 * with alerts"): an alert firing becomes a notification. Both render from the
 * sample here. There is no per-user alert/notification store yet (no `(auth)`
 * group, `billing.consume_meter` caps exist but 0 rows) — so this is a
 * MEMBER surface shipped ungated with a shared sample set for the design pass
 * (DEF-ALERTS-LIVE-DATA), same treatment as the watchlist (1h).
 */

// ── Alert states ─────────────────────────────────────────────────────────────
export type AlertState = "TRIGGERED" | "ARMED" | "PAUSED";

export interface StockAlert {
  ticker: string;
  name: string;
  condition: string;
  delivery: string; // "PUSH" / "PUSH + EMAIL" / "EMAIL"
  state: AlertState;
  lastFired: string; // "TODAY 13:58" / "12 JUN" / "—"
}

export interface ScreenAlert {
  name: string;
  cadence: string; // "WEEKLY DIGEST · SUN" / "REAL-TIME"
  detail: string; // "+3 new matches this week"
}

export interface PhraseAlert {
  phrase: string; // includes the quotes as authored
  scope: string; // "2222 only" / "Watchlist names"
  delivery: string;
  hits: string; // "1 hit this week"
}

export interface TriggerLogItem {
  when: string; // "13:58" / "SAT 14:41"
  kind: string; // "PRICE" / "SCORE" / "DIGEST" / "PHRASE" / "SCREEN"
  text: string;
}

export interface DeliveryChannel {
  label: string;
  on: boolean;
  premium?: boolean;
}

export interface AlertCap {
  used: number;
  limit: number;
  premiumLimit?: number;
}

export interface AlertsData {
  kpis: { label: string; value: string }[];
  composer: { ticker: string; condition: string; value: string; channel: string };
  stock: { cap: AlertCap; rows: StockAlert[] };
  screen: { cap: AlertCap; rows: ScreenAlert[]; ceilingNote: string };
  phrase: {
    cap: AlertCap;
    rows: PhraseAlert[];
    popularLocked: string[];
    note: string;
  };
  triggerLog: TriggerLogItem[];
  delivery: { channels: DeliveryChannel[]; quietHours: string; note: string };
  goPremium: { headline: string; body: string; cta: string };
}

export const SAMPLE_ALERTS: AlertsData = {
  kpis: [
    { label: "ARMED", value: "12 alerts" },
    { label: "TRIGGERED TODAY", value: "2 — SALIK, 2082" },
    { label: "DELIVERY", value: "Push + daily email" },
    { label: "QUIET HOURS", value: "22:00 – 07:00 GST" },
    { label: "PLAN", value: "Free — caps below" },
  ],
  composer: { ticker: "2222", condition: "Price crosses", value: "SAR 26.50", channel: "Push" },
  stock: {
    cap: { used: 8, limit: 10, premiumLimit: 800 },
    rows: [
      { ticker: "SALIK", name: "Salik Co.", condition: "Price crosses AED 6.00", delivery: "PUSH + EMAIL", state: "TRIGGERED", lastFired: "TODAY 13:58" },
      { ticker: "2082", name: "ACWA Power", condition: "Any Marsad Score change", delivery: "PUSH", state: "TRIGGERED", lastFired: "TODAY 12:20" },
      { ticker: "2222", name: "Saudi Aramco", condition: "Ex-dividend reminder · 8 Jul", delivery: "EMAIL", state: "ARMED", lastFired: "—" },
      { ticker: "TASI", name: "Tadawul All Share", condition: "Index falls more than 1% intraday", delivery: "PUSH", state: "ARMED", lastFired: "12 JUN" },
      { ticker: "1120", name: "Al Rajhi Bank", condition: "Price crosses SAR 104.00", delivery: "PUSH", state: "ARMED", lastFired: "—" },
      { ticker: "QNBK", name: "QNB Group", condition: "Q2 results published", delivery: "PUSH + EMAIL", state: "ARMED", lastFired: "—" },
      { ticker: "KFH", name: "Kuwait Finance House", condition: "Bonus issue effective · 13 Jul", delivery: "EMAIL", state: "ARMED", lastFired: "—" },
      { ticker: "EMAAR", name: "Emaar Properties", condition: "P/E (TTM) falls below 8.0×", delivery: "PUSH", state: "PAUSED", lastFired: "4 APR" },
    ],
  },
  screen: {
    cap: { used: 2, limit: 2 },
    rows: [
      { name: "Gulf Dividend Aristocrats", cadence: "WEEKLY DIGEST · SUN", detail: "+3 new matches this week" },
      { name: "Sub-1× Book Banks", cadence: "REAL-TIME", detail: "+1 new match — Warba Bank entered" },
    ],
    ceilingNote: "Free tier ceiling reached. Premium raises this to 75 screen alerts.",
  },
  phrase: {
    cap: { used: 2, limit: 2 },
    rows: [
      { phrase: '"Jafurah"', scope: "2222 only", delivery: "PUSH", hits: "1 hit this week" },
      { phrase: '"dividend"', scope: "Watchlist names", delivery: "EMAIL", hits: "4 hits this week" },
    ],
    popularLocked: ["stake sale", "buyback", "rights issue", "guidance"],
    note: "Premium tracks 50 phrases across all 812 names — locked chips arm instantly after upgrade.",
  },
  triggerLog: [
    { when: "13:58", kind: "PRICE", text: "SALIK crossed AED 6.00 — push delivered" },
    { when: "12:20", kind: "SCORE", text: "ACWA Power score 71 → 78 — push delivered" },
    { when: "07:30", kind: "DIGEST", text: "Wire Brief digest — 14 items, emailed" },
    { when: "SAT 14:41", kind: "PHRASE", text: '"Jafurah" matched in 2222 filing — emailed' },
    { when: "SAT 09:12", kind: "SCREEN", text: "Dividend Aristocrats screen +2 matches" },
  ],
  delivery: {
    channels: [
      { label: "Push notifications", on: true },
      { label: "Email — instant triggers", on: true },
      { label: "Email — 07:30 daily digest", on: true },
      { label: "WhatsApp", on: false, premium: true },
    ],
    quietHours: "22:00 – 07:00 GST",
    note: "Market-hours triggers are never delayed. Quiet hours only hold digests and low-priority items.",
  },
  goPremium: {
    headline: "GO PREMIUM",
    body: "800 stock · 75 screen · 50 phrase alerts, plus WhatsApp delivery.",
    cta: "Upgrade — SAR 89/mo",
  },
};

// ── Notifications (16b) ──────────────────────────────────────────────────────
export type NotificationTab = "All" | "Alerts" | "Research" | "Filings";

export interface NotificationItem {
  id: string;
  tag: string; // "PRICE ALERT" / "EARNINGS" / 'PHRASE · "DIVIDEND"' / "NEW RESEARCH"
  category: Exclude<NotificationTab, "All">;
  title: string;
  body?: string;
  when: string; // "2m ago" / "1h ago" / "Yesterday"
  unread: boolean;
  href?: string;
}

export const SAMPLE_NOTIFICATIONS: NotificationItem[] = [
  {
    id: "n1",
    tag: "PRICE ALERT",
    category: "Alerts",
    title: "2222 crossed SAR 30.00 ▲",
    body: "+4.9% intraday on the Jafurah Phase 3 news",
    when: "2m ago",
    unread: true,
    href: "/stocks/TDWL/2222",
  },
  { id: "n2", tag: "EARNINGS", category: "Alerts", title: "SNB Q2 beat consensus by +4.2%", when: "1h ago", unread: true, href: "/earnings" },
  { id: "n3", tag: 'PHRASE · "DIVIDEND"', category: "Filings", title: "4 new filings match your saved phrase", when: "2h ago", unread: true, href: "/wire" },
  { id: "n4", tag: "NEW RESEARCH", category: "Research", title: "Noor Al-Suwaidi published on Alinma", when: "Yesterday", unread: false, href: "/analysts/noor-al-suwaidi" },
];

export const UNREAD_COUNT = SAMPLE_NOTIFICATIONS.filter((n) => n.unread).length;
