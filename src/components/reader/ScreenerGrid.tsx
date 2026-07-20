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
const inputCls =
  "w-full border border-dark-hairline-strong bg-dark-bg px-2 py-1.5 font-mono text-[12px] text-dark-text placeholder:text-dark-text-faint focus:border-dark-text focus:outline-none";

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
    <div className="flex flex-col gap-5">
      {/* Filters */}
      <div className="flex flex-col gap-4 border border-dark-hairline bg-dark-panel p-4">
        <FilterBlock label="Venue">
          <div className="flex flex-wrap gap-1.5">
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

        <FilterBlock label="Sector">
          <div className="flex flex-wrap gap-1.5">
            {(facets?.sectors ?? []).map((s) => (
              <button
                key={s.key}
                type="button"
                className={`${chipBase} ${f.sectors.includes(s.key) ? chipOn : chipOff}`}
                onClick={() => setF((p) => ({ ...p, sectors: toggle(p.sectors, s.key) }))}
              >
                {s.name}
              </button>
            ))}
          </div>
        </FilterBlock>

        <FilterBlock label="Rating">
          <div className="flex flex-wrap gap-1.5">
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

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
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
            label="Score (0–100)"
            minV={f.scoreMin}
            maxV={f.scoreMax}
            onMin={(v) => setF((p) => ({ ...p, scoreMin: v }))}
            onMax={(v) => setF((p) => ({ ...p, scoreMax: v }))}
          />
        </div>

        <div className="flex items-center justify-between border-t border-dark-hairline pt-3">
          <span className="font-mono text-[10px] tracking-[0.06em] text-dark-text-faint uppercase">
            {loading ? "Running…" : `${total.toLocaleString("en-US")} matches`}
            {data ? ` · of ${data.universe.toLocaleString("en-US")}` : ""}
          </span>
          <button
            type="button"
            onClick={() => setF(INITIAL)}
            className="cursor-pointer border border-dark-hairline-strong px-3 py-1 font-mono text-[10px] tracking-[0.08em] text-dark-text-mid uppercase hover:text-dark-text"
          >
            Reset
          </button>
        </div>
      </div>

      {/* Results */}
      <div className="overflow-x-auto border border-dark-hairline bg-dark-panel">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-dark-hairline-strong text-dark-text-faint">
              <SortHead label={`Ticker${arrow("ticker")}`} onClick={() => setSort("ticker")} />
              <th className={`${TH} text-dark-text-faint`}>Company</th>
              <th className={`${TH} text-dark-text-faint`}>Sector</th>
              <SortHead label={`Last${arrow("price")}`} align="right" onClick={() => setSort("price")} />
              <SortHead label={`Chg %${arrow("change")}`} align="right" onClick={() => setSort("change")} />
              <SortHead label={`Vol${arrow("volume")}`} align="right" onClick={() => setSort("volume")} />
              <SortHead label={`Score${arrow("score")}`} align="right" onClick={() => setSort("score")} />
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
                  <tr key={r.securityId} className="border-b border-dark-hairline-soft hover:bg-dark-panel-alt">
                    <td className={`${TD} font-semibold text-dark-text`}>
                      <Link
                        href={`/stocks/${r.venueCode}/${r.ticker}`}
                        className="hover:underline underline-offset-2"
                      >
                        {r.ticker}
                        <span className="ml-1.5 text-[8px] text-dark-text-faint">{r.venueCode}</span>
                      </Link>
                    </td>
                    <td className="max-w-[220px] truncate px-3 py-2 font-ui text-[12px] text-dark-text-mid" title={r.name}>
                      {r.name}
                    </td>
                    <td className="px-3 py-2 font-ui text-[11px] text-dark-text-faint">{r.sectorName}</td>
                    <td className={`${TD} text-right text-dark-text`}>{fmtPrice(r.last)}</td>
                    <td className={`${TD} text-right font-semibold ${chgColor}`}>{fmtSignedPct(r.changePct)}</td>
                    <td className={`${TD} text-right text-dark-text-mid`}>{fmtCompact(r.volume)}</td>
                    <td className={`${TD} text-right text-dark-text`}>
                      {r.score != null ? (
                        <>
                          {r.score}
                          {r.rating ? <span className="ml-1 text-[9px] text-dark-text-faint">{r.rating}</span> : null}
                        </>
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
      </div>

      {data && total > rows.length ? (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => setF((p) => ({ ...p, limit: Math.min(p.limit + 100, 200) }))}
            disabled={f.limit >= 200}
            className="cursor-pointer border border-dark-hairline-strong px-5 py-2 font-ui text-[12px] font-semibold text-dark-text hover:bg-dark-panel-alt disabled:cursor-not-allowed disabled:opacity-40"
          >
            {f.limit >= 200 ? "Refine filters to see more" : "Show more"}
          </button>
        </div>
      ) : null}

      <p className="font-mono text-[9px] leading-[1.6] text-dark-text-faint">
        Delayed data, information only. Valuation ratios (P/E, P/B, ROE, yield) and Score factor
        grades are Premium — not included in this table.
      </p>
    </div>
  );
}

function FilterBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="font-mono text-[9px] font-semibold tracking-[0.14em] text-dark-text-faint uppercase">
        {label}
      </span>
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
    <div className="flex flex-col gap-1.5">
      <span className="font-mono text-[9px] font-semibold tracking-[0.14em] text-dark-text-faint uppercase">
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
  align?: "left" | "right";
}) {
  return (
    <th className={`${TH} ${align === "right" ? "text-right" : "text-left"} text-dark-text-mid`}>
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
