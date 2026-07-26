/**
 * Alerts manager + Notifications — view-model contract.
 *
 * CONTRACT LAYER (design 5a + 16b). This is the FE↔BE seam: the sample module
 * in `src/lib/data/sample/` and the real adapter in `src/lib/data/adapters/`
 * are two implementations of THIS type. Swapping a page from sample to live is
 * a one-line change in its `page.tsx`.
 *
 * Law #1 (docs/BRIDGE-BUILD-PLAN.md §0.1): never edit this type to fit a DB
 * column. If the data cannot be served, the adapter returns null/"—" and the
 * gap is logged as a DEF-* row.
 */
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
