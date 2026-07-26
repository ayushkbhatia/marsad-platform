"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { fmtPrice, fmtSignedPct, fmtCompact } from "@/lib/reader/format";

/**
 * Screener filter + results grid (client island, dark data-room surface).
 *
 * Calls the CDN-cacheable `/api/screener/run` over a constrained public field
 * allowlist. The valuation columns (P/E, P/B, ROE, Yield) are PREMIUM — they are
 * rendered as inert locked column stubs: no ratio value is ever fetched or held
 * in this component's state.
 */

interface Row {
  securityId: number;
  venueCode: string;
  ticker: string;
  name: string;
  sector: string;
  sectorName: string;
  currency: string | null;
  last: number | null;
  changePct: number | null;
  volume: number | null;
  tickDir: number | null;
  score: number | null;
  rating: string | null;
}

interface Facets {
  venues: string[];
  sectors: Array<{ key: string; name: string }>;
  ratings: string[];
}

interface RunResponse {
  rows: Row[];
  total: number;
  universe: number;
  facets: Facets;
  sort: string;
  dir: "asc" | "desc";
}

type SortField = "ticker" | "price" | "change" | "score" | "volume";

interface FilterState {
  venues: string[];
  sectors: string[];
  ratings: string[];
  priceMin: string;
  priceMax: string;
  changeMin: string;
  changeMax: string;
  scoreMin: string;
  scoreMax: string;
  sort: SortField;
  dir: "asc" | "desc";
  limit: number;
}

const INITIAL: FilterState = {
  venues: [],
  sectors: [],
  ratings: [],
  priceMin: "",
  priceMax: "",
  changeMin: "",
  changeMax: "",
  scoreMin: "",
  scoreMax: "",
  sort: "change",
  dir: "desc",
  limit: 100,
};

const PREMIUM_COLS = ["P/E", "P/B", "ROE", "Yield"] as const;

/** Mono caption for the results footer's "SORTED BY …" line. */
const SORT_LABEL: Record<SortField, string> = {
  ticker: "TICKER",
  price: "PRICE",
  change: "1D CHANGE",
  score: "MARSAD SCORE",
  volume: "VOLUME",
};

function toggle(list: string[], v: string): string[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

function buildQuery(f: FilterState): string {
  const p = new URLSearchParams();
  if (f.venues.length) p.set("venue", f.venues.join(","));
  if (f.sectors.length) p.set("sector", f.sectors.join(","));
  if (f.ratings.length) p.set("rating", f.ratings.join(","));
  for (const [k, v] of [
    ["priceMin", f.priceMin],
    ["priceMax", f.priceMax],
    ["changeMin", f.changeMin],
    ["changeMax", f.changeMax],
    ["scoreMin", f.scoreMin],
    ["scoreMax", f.scoreMax],
  ] as const) {
    if (v.trim() !== "") p.set(k, v.trim());
  }
  p.set("sort", f.sort);
  p.set("dir", f.dir);
  p.set("limit", String(f.limit));
  return p.toString();
}

const chipBase =
  "cursor-pointer border px-2 py-1 font-mono text-[10px] tracking-[0.04em] uppercase transition-colors";
const chipOn = "border-dark-text bg-dark-text text-dark-bg";
const chipOff = "border-dark-hairline-strong text-dark-text-mid hover:text-dark-text";
// `focus:outline-none` alone (no replacement ring) fails WCAG 2.4.7 Focus
// Visible — a 1px border-color change is too weak a focus indicator on its
// own. Keep the border change but restore a real ring via `focus-visible`
// (keyboard-only, so a mouse click doesn't add visual noise) using the same
// dark-surface text token for AA contrast against `bg-dark-bg`.
const inputCls =
  "w-full border border-dark-hairline-strong bg-dark-bg px-2 py-1.5 font-mono text-[12px] text-dark-text placeholder:text-dark-text-faint focus:border-dark-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-dark-text";

const TH = "px-3 py-2 text-left font-mono text-[9px] font-semibold tracking-[0.12em] uppercase";
const TD = "px-3 py-2 font-mono text-[12px] tabular-nums";

export function ScreenerGrid() {
  const [f, setF] = useState<FilterState>(INITIAL);
  const [data, setData] = useState<RunResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const query = useMemo(() => buildQuery(f), [f]);

  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    const id = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/screener/run?${query}`, {
          signal: ac.signal,
          headers: { accept: "application/json" },
        });
        if (!res.ok) throw new Error(`screener responded ${res.status}`);
        const json = (await res.json()) as RunResponse;
        if (!cancelled) {
          setData(json);
          setError(null);
        }
      } catch (e) {
        if (!cancelled && (e as Error).name !== "AbortError") setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      ac.abort();
      clearTimeout(id);
    };
  }, [query]);

  const setSort = useCallback((field: SortField) => {
    setF((prev) =>
      prev.sort === field
        ? { ...prev, dir: prev.dir === "desc" ? "asc" : "desc" }
        : { ...prev, sort: field, dir: field === "ticker" ? "asc" : "desc" },
    );
  }, []);

  const facets = data?.facets;
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const arrow = (field: SortField) => (f.sort === field ? (f.dir === "desc" ? " ▼" : " ▲") : "");

  return (
    <div className="grid grid-cols-1 px-6 pt-4 pb-6 lg:grid-cols-[264px_1fr]">
      {/* Filter rail (design 1f) */}
      <div className="flex flex-col gap-[18px] lg:border-r lg:border-dark-hairline lg:pr-5">
        <FilterBlock label="Universe">
          <div className="flex flex-wrap gap-[5px]">
            <button
              type="button"
              className={`${chipBase} ${f.venues.length === 0 ? chipOn : chipOff}`}
              onClick={() => setF((p) => ({ ...p, venues: [] }))}
            >
              All
            </button>
            {(facets?.venues ?? []).map((v) => (
              <button
                key={v}
                type="button"
                className={`${chipBase} ${f.venues.includes(v) ? chipOn : chipOff}`}
                onClick={() => setF((p) => ({ ...p, venues: toggle(p.venues, v) }))}
              >
                {v}
              </button>
            ))}
          </div>
        </FilterBlock>

        <FilterBlock
          label="Sector"
          right={
            f.sectors.length > 0 ? (
              <span className="font-mono text-[9px] text-dark-text">{f.sectors.length} SELECTED</span>
            ) : null
          }
        >
          <div className="flex flex-col gap-1">
            {(facets?.sectors ?? []).map((s) => {
              const on = f.sectors.includes(s.key);
              return (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => setF((p) => ({ ...p, sectors: toggle(p.sectors, s.key) }))}
                  className={`flex cursor-pointer items-center gap-2 text-left font-ui text-[11.5px] ${
                    on ? "text-dark-text" : "text-dark-text-faint hover:text-dark-text-mid"
                  }`}
                >
                  <span
                    aria-hidden
                    className={`h-[10px] w-[10px] flex-none border ${
                      on ? "border-dark-text bg-dark-text" : "border-dark-hairline-strong"
                    }`}
                  />
                  {s.name}
                </button>
              );
            })}
          </div>
        </FilterBlock>

        <FilterBlock label="Rating">
          <div className="flex flex-wrap gap-[5px]">
            {(facets?.ratings ?? []).map((r) => (
              <button
                key={r}
                type="button"
                className={`${chipBase} ${f.ratings.includes(r) ? chipOn : chipOff}`}
                onClick={() => setF((p) => ({ ...p, ratings: toggle(p.ratings, r) }))}
              >
                {r}
              </button>
            ))}
          </div>
        </FilterBlock>

        <RangeBlock
          label="Price"
          minV={f.priceMin}
          maxV={f.priceMax}
          onMin={(v) => setF((p) => ({ ...p, priceMin: v }))}
          onMax={(v) => setF((p) => ({ ...p, priceMax: v }))}
        />
        <RangeBlock
          label="Change %"
          minV={f.changeMin}
          maxV={f.changeMax}
          onMin={(v) => setF((p) => ({ ...p, changeMin: v }))}
          onMax={(v) => setF((p) => ({ ...p, changeMax: v }))}
        />
        <RangeBlock
          label="Marsad Score"
          minV={f.scoreMin}
          maxV={f.scoreMax}
          onMin={(v) => setF((p) => ({ ...p, scoreMin: v }))}
          onMax={(v) => setF((p) => ({ ...p, scoreMax: v }))}
        />

        {/* Filters apply live (debounced) — this is the match readout + reset. */}
        <div className="mt-1 flex gap-2">
          <span className="flex-1 bg-dark-text py-[9px] text-center font-ui text-[11px] font-bold tracking-[0.06em] text-dark-bg">
            {loading ? "RUNNING…" : `${total.toLocaleString("en-US")} MATCH`}
          </span>
          <button
            type="button"
            onClick={() => setF(INITIAL)}
            className="cursor-pointer border border-dark-hairline-soft px-3 py-[9px] font-ui text-[11px] text-dark-text-faint hover:text-dark-text"
          >
            Reset
          </button>
        </div>
      </div>

      {/* Results */}
      <div className="overflow-x-auto lg:pl-[22px]">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-dark-hairline-strong text-dark-text-faint">
              <SortHead label={`Ticker${arrow("ticker")}`} onClick={() => setSort("ticker")} />
              <th className={`${TH} text-dark-text-faint`}>Company</th>
              <th className={`${TH} text-dark-text-faint`}>Venue</th>
              <SortHead label={`Price${arrow("price")}`} align="right" onClick={() => setSort("price")} />
              <SortHead label={`1D${arrow("change")}`} align="right" onClick={() => setSort("change")} />
              <SortHead label={`Vol${arrow("volume")}`} align="right" onClick={() => setSort("volume")} />
              <SortHead label={`Score${arrow("score")}`} align="center" onClick={() => setSort("score")} />
              {PREMIUM_COLS.map((c) => (
                <th key={c} className={`${TH} text-right text-dark-text-faint`} title={`${c} — Premium`}>
                  <span className="inline-flex items-center gap-1">
                    <span aria-hidden>🔒</span>
                    {c}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {error ? (
              <tr>
                <td colSpan={7 + PREMIUM_COLS.length} className="px-3 py-8 text-center font-mono text-[12px] text-negative-dark">
                  {error}
                </td>
              </tr>
            ) : rows.length === 0 && !loading ? (
              <tr>
                <td colSpan={7 + PREMIUM_COLS.length} className="px-3 py-10 text-center font-mono text-[11px] tracking-[0.06em] text-dark-text-faint uppercase">
                  No securities match these filters.
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const dir = (r.changePct ?? 0) > 0 ? 1 : (r.changePct ?? 0) < 0 ? -1 : 0;
                const chgColor = dir > 0 ? "text-positive-dark" : dir < 0 ? "text-negative-dark" : "text-dark-text-mid";
                return (
                  <tr key={r.securityId} className="border-b border-[#211f1a] hover:bg-[#1a1915]">
                    <td className={`${TD} font-semibold text-dark-text`}>
                      <Link
                        href={`/stocks/${r.venueCode}/${r.ticker}`}
                        className="hover:underline underline-offset-2"
                      >
                        {r.ticker}
                      </Link>
                    </td>
                    <td className="max-w-[220px] truncate px-3 py-2 font-ui text-[12px] text-dark-text-mid" title={r.name}>
                      {r.name}
                    </td>
                    <td className="px-3 py-2">
                      <span className="inline-block border border-dark-hairline-soft px-1.5 py-[2px] font-mono text-[8.5px] text-dark-text-faint">
                        {r.venueCode}
                      </span>
                    </td>
                    <td className={`${TD} text-right text-dark-text-mid`}>{fmtPrice(r.last)}</td>
                    <td className={`${TD} text-right font-semibold ${chgColor}`}>{fmtSignedPct(r.changePct)}</td>
                    <td className={`${TD} text-right text-dark-text-faint`}>{fmtCompact(r.volume)}</td>
                    <td className={`${TD} text-center`}>
                      {r.score != null ? (
                        <span
                          className="inline-block px-[9px] py-[3px] font-mono text-[11px] font-bold text-dark-text"
                          style={{
                            background:
                              r.score >= 80
                                ? "var(--color-heatmap-9)"
                                : r.score >= 70
                                  ? "var(--color-heatmap-6)"
                                  : "var(--color-dark-hairline-strong)",
                          }}
                          title={r.rating ?? undefined}
                        >
                          {r.score}
                        </span>
                      ) : (
                        <span className="text-dark-text-faint">—</span>
                      )}
                    </td>
                    {PREMIUM_COLS.map((c) => (
                      <td key={c} className={`${TD} text-right text-dark-text-faint`} aria-label={`${c} premium`}>
                        <span className="opacity-50" aria-hidden>
                          🔒
                        </span>
                      </td>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>

        {/* Results footer (design 1f) — match caption + column/watchlist actions. */}
        <div className="flex flex-wrap items-center gap-3.5 px-2.5 pt-3.5">
          <span className="font-mono text-[10px] text-dark-text-faint">
            {loading
              ? "RUNNING…"
              : `${rows.length.toLocaleString("en-US")} OF ${total.toLocaleString("en-US")} COMPANIES MATCH · SORTED BY ${SORT_LABEL[f.sort]}`}
          </span>
          <span className="ml-auto font-mono text-[10px] text-dark-text-faint" title="Premium columns">
            ADD COLUMN +
          </span>
          <Link
            href="/watchlist"
            className="font-mono text-[10px] text-dark-text-faint hover:text-dark-text"
          >
            SEND TO WATCHLIST →
          </Link>
        </div>

        {data && total > rows.length ? (
          <div className="flex justify-center pt-3">
            <button
              type="button"
              onClick={() => setF((p) => ({ ...p, limit: Math.min(p.limit + 100, 200) }))}
              disabled={f.limit >= 200}
              className="cursor-pointer border border-dark-hairline-strong px-5 py-2 font-ui text-[12px] font-semibold text-dark-text hover:bg-[#1a1915] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {f.limit >= 200 ? "Refine filters to see more" : "Show more"}
            </button>
          </div>
        ) : null}

        <p className="px-2.5 pt-3 font-mono text-[9px] leading-[1.6] text-dark-text-faint">
          Delayed data, information only. Valuation ratios (P/E, P/B, ROE, yield) and Score factor
          grades are Premium — not included in this table.
        </p>
      </div>
    </div>
  );
}

function FilterBlock({
  label,
  right,
  children,
}: {
  label: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[9px] tracking-[0.16em] text-dark-text-faint uppercase">
          {label}
        </span>
        {right}
      </div>
      {children}
    </div>
  );
}

function RangeBlock({
  label,
  minV,
  maxV,
  onMin,
  onMax,
}: {
  label: string;
  minV: string;
  maxV: string;
  onMin: (v: string) => void;
  onMax: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="font-mono text-[9px] tracking-[0.16em] text-dark-text-faint uppercase">
        {label}
      </span>
      <div className="flex items-center gap-2">
        <input
          type="number"
          inputMode="decimal"
          value={minV}
          onChange={(e) => onMin(e.target.value)}
          placeholder="min"
          className={inputCls}
        />
        <span className="font-mono text-[11px] text-dark-text-faint">–</span>
        <input
          type="number"
          inputMode="decimal"
          value={maxV}
          onChange={(e) => onMax(e.target.value)}
          placeholder="max"
          className={inputCls}
        />
      </div>
    </div>
  );
}

function SortHead({
  label,
  onClick,
  align = "left",
}: {
  label: string;
  onClick: () => void;
  align?: "left" | "right" | "center";
}) {
  const a = align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left";
  return (
    <th className={`${TH} ${a} text-dark-text-mid`}>
      <button
        type="button"
        onClick={onClick}
        className="cursor-pointer font-mono uppercase tracking-[0.12em] hover:text-dark-text"
      >
        {label}
      </button>
    </th>
  );
}
