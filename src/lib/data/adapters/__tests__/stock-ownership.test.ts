import test from "node:test";
import assert from "node:assert/strict";
import type { OwnershipBundle } from "@/lib/data/stock-events";

/**
 * Fixture test for the Ownership & People adapter (BRIDGE-BUILD-PLAN P1.7).
 *
 * WHY THIS FILE EXISTS: the four ownership tables are 0 rows, so the tab ships
 * an honest `EmptyState awaitingFeed` and there is no live read that can prove
 * the mapping works. This test is that proof — it feeds the adapter a
 * hand-built non-empty `OwnershipBundle` (a FIXTURE, never rendered in
 * production) and asserts the `Ownership` contract it produces. When the
 * ownership producer lands, this is the guarantee that the tab lights up
 * correctly instead of silently mis-rendering.
 *
 * RUNNING IT: the Next app has no test runner in `package.json` and adding one
 * is out of scope for this step, so this runs on Node's built-in runner with
 * native TypeScript type-stripping — no dependency, no config:
 *
 *     node --test "src/lib/data/adapters/__tests__/stock-ownership.test.ts"
 *
 * The adapter is imported dynamically through a non-literal specifier so that
 * `tsc` (which forbids a literal `.ts` import extension without
 * `allowImportingTsExtensions`) and Node (which requires the extension) are
 * both satisfied. `typeof import(...)` keeps the module fully typed.
 */

type AdapterModule = typeof import("../stock-ownership");

const SPECIFIER = "../stock-ownership" + ".ts";

async function loadAdapter(): Promise<AdapterModule> {
  return (await import(SPECIFIER)) as AdapterModule;
}

/** Two quarters of a plausible-but-synthetic GCC name. Fixture only. */
function fixture(): OwnershipBundle {
  const snapshots = [
    {
      asOf: "2025-12-31",
      categories: { government: 40, foreign_institutions: 5.5, "retail & other public": 54.5 },
      foreignOwnershipPct: 5.5,
      isFolRecord: false,
    },
    {
      asOf: "2026-03-31",
      categories: { government: 40, foreign_institutions: 6.25, "retail & other public": 53.75 },
      foreignOwnershipPct: 6.25,
      isFolRecord: true,
    },
  ];

  return {
    holders: [
      {
        holderId: 1,
        name: "Sovereign Holding Co",
        holderType: "sovereign_wealth",
        country: "SA",
        established: 1971,
        disclosedValueUsd: 1_200_000_000,
        asOf: "2026-03-31",
        stakePct: 40,
        qoqChangePp: 0,
      },
      {
        holderId: 2,
        name: "Northbridge EM Fund",
        holderType: "foreign passive",
        country: "US",
        established: null,
        disclosedValueUsd: null,
        asOf: "2026-03-31",
        stakePct: 3.125,
        qoqChangePp: 0.75,
      },
      {
        holderId: 3,
        name: "Gulf Pension Fund",
        holderType: "pension",
        country: "AE",
        established: null,
        disclosedValueUsd: null,
        asOf: "2026-03-31",
        stakePct: 1.4,
        qoqChangePp: -0.2,
      },
      {
        holderId: 4,
        name: "Undisclosed Nominee",
        holderType: "nominee",
        country: null,
        established: null,
        disclosedValueUsd: null,
        asOf: "2026-03-31",
        stakePct: null,
        qoqChangePp: null,
      },
    ],
    snapshots,
    latestSnapshot: snapshots[1],
    board: [
      {
        id: 10,
        name: "A. Al-Mansouri",
        role: "board",
        title: "Chairman",
        isIndependent: false,
        seatCount: 9,
        asOf: "2024-04-15",
      },
      {
        id: 11,
        name: "R. Haddad",
        role: "board",
        title: null,
        isIndependent: true,
        seatCount: 9,
        asOf: "2022-06-01",
      },
    ],
    management: [
      {
        id: 20,
        name: "S. Rahman",
        role: "management",
        title: "Chief Executive Officer",
        isIndependent: null,
        seatCount: null,
        asOf: "2023-01-09",
      },
      {
        id: 21,
        name: "K. Yousef",
        role: "management",
        title: null,
        isIndependent: null,
        seatCount: null,
        asOf: null,
      },
    ],
  };
}

test("empty bundle → null (the awaitingFeed signal, today's live state)", async () => {
  const { toOwnership } = await loadAdapter();
  const empty: OwnershipBundle = {
    holders: [],
    snapshots: [],
    latestSnapshot: null,
    board: [],
    management: [],
  };
  assert.equal(toOwnership(empty), null);
});

test("periods are 8 slots, oldest→newest, short history left-padded", async () => {
  const { toOwnership } = await loadAdapter();
  const o = toOwnership(fixture());
  assert.ok(o);
  assert.equal(o.periods.length, 8);
  assert.deepEqual(o.periods, ["—", "—", "—", "—", "—", "—", "Dec '25", "Mar '26"]);
  assert.equal(o.shareholderCount.length, 8);
  assert.deepEqual(new Set(o.shareholderCount), new Set(["—"]));
});

test("shareholding rows are ordered by latest stake and pct-formatted", async () => {
  const { toOwnership } = await loadAdapter();
  const o = toOwnership(fixture());
  assert.ok(o);
  assert.deepEqual(
    o.rows.map((r) => r.label),
    ["Retail & other public", "Government", "Foreign institutions"],
  );
  const foreign = o.rows.find((r) => r.label === "Foreign institutions");
  assert.ok(foreign);
  assert.equal(foreign.values.length, 8);
  assert.deepEqual(foreign.values.slice(6), ["5.50%", "6.25%"]);
});

test("foreign-ownership banner reflects the FOL record flag", async () => {
  const { toOwnership } = await loadAdapter();
  const withRecord = toOwnership(fixture());
  assert.ok(withRecord);
  assert.equal(withRecord.foreignAtRecord, "FOREIGN OWNERSHIP AT RECORD 6.25%");

  const b = fixture();
  b.latestSnapshot = { ...b.latestSnapshot!, isFolRecord: false };
  assert.equal(toOwnership(b)!.foreignAtRecord, "FOREIGN OWNERSHIP 6.25%");

  const c = fixture();
  c.latestSnapshot = { ...c.latestSnapshot!, foreignOwnershipPct: null };
  assert.equal(toOwnership(c)!.foreignAtRecord, "FOREIGN OWNERSHIP NOT DISCLOSED");
});

test("top holders carry pct, humanised type, and a directional QoQ change", async () => {
  const { toOwnership } = await loadAdapter();
  const o = toOwnership(fixture());
  assert.ok(o);
  assert.equal(o.topHoldersAsOf, "MAR '26 DISCLOSURES");
  assert.deepEqual(o.topHolders, [
    { name: "Sovereign Holding Co", type: "Sovereign wealth", pct: "40.00%", change: "unchanged" },
    { name: "Northbridge EM Fund", type: "Foreign passive", pct: "3.13%", change: "+0.75", changeDir: "up" },
    { name: "Gulf Pension Fund", type: "Pension", pct: "1.40%", change: "−0.20", changeDir: "down" },
    { name: "Undisclosed Nominee", type: "Nominee", pct: "—", change: "—" },
  ]);
});

test("board and management map without inventing missing fields", async () => {
  const { toOwnership } = await loadAdapter();
  const o = toOwnership(fixture());
  assert.ok(o);
  assert.deepEqual(o.board, [
    { name: "A. Al-Mansouri", role: "Chairman", since: "2024" },
    { name: "R. Haddad", role: "Independent director", since: "2022" },
  ]);
  assert.equal(o.boardMeta, "9 SEATS · 1 INDEPENDENT");
  assert.deepEqual(o.management, [
    { name: "S. Rahman", role: "Chief Executive Officer", bio: "" },
    { name: "K. Yousef", role: "Management", bio: "" },
  ]);
  // No float figure exists upstream — the copy must say so, not fabricate one.
  assert.match(o.floatWatchHtml, /appears here once the ownership producer/);
  assert.doesNotMatch(o.floatWatchHtml, /\d+(\.\d+)?%/);
});

test("a holders-only bundle still renders (partial degrade, not null)", async () => {
  const { toOwnership } = await loadAdapter();
  const b = fixture();
  b.snapshots = [];
  b.latestSnapshot = null;
  const o = toOwnership(b);
  assert.ok(o);
  assert.equal(o.rows.length, 0);
  assert.equal(o.periods.length, 8);
  assert.equal(o.topHolders.length, 4);
  assert.equal(o.foreignAtRecord, "FOREIGN OWNERSHIP NOT DISCLOSED");
});
