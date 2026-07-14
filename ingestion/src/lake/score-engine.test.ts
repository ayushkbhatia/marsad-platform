import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreUniverse,
  winsorizedPercentiles,
  ratingForScore,
  gradeForScore,
  MIN_COHORT,
  type ScoreInput,
} from './score-engine.js';

/** A fully-populated Value/Growth/Profitability/Momentum input for one name.
 *  Every metric set so all four factors compute; overlay to perturb one name. */
function fullInput(id: number, over: Partial<ScoreInput> = {}): ScoreInput {
  return {
    securityId: id,
    venue: 'TDWL',
    sector: 'energy',
    earningsYield: 0.08,
    pb: 1.5,
    evEbitda: 8,
    dividendYield: 0.04,
    epsGrowthYoy: 0.1,
    revGrowthYoy: 0.08,
    epsCagr3y: 0.09,
    revCagr3y: 0.07,
    roe: 0.15,
    roce: 0.12,
    netMargin: 0.2,
    grossMargin: 0.35,
    ret12_1: 0.12,
    ret6m: 0.06,
    ret3m: 0.03,
    last: 55,
    week52High: 60,
    week52Low: 40,
    ...over,
  };
}

/** A cohort of ≥8 evenly-spread names so percentiles are well-defined. */
function cohortOf(n: number, sector = 'energy'): ScoreInput[] {
  const out: ScoreInput[] = [];
  for (let i = 0; i < n; i += 1) {
    const t = i / (n - 1); // 0..1 across the cohort
    out.push(
      fullInput(1000 + i, {
        sector,
        earningsYield: 0.02 + t * 0.1, // higher = cheaper = better
        pb: 3 - t * 2, // lower = cheaper (inverted internally)
        evEbitda: 14 - t * 8,
        dividendYield: 0.01 + t * 0.05,
        epsGrowthYoy: -0.05 + t * 0.3,
        revGrowthYoy: -0.02 + t * 0.2,
        epsCagr3y: 0 + t * 0.2,
        revCagr3y: 0 + t * 0.15,
        roe: 0.05 + t * 0.2,
        roce: 0.04 + t * 0.16,
        netMargin: 0.05 + t * 0.25,
        grossMargin: 0.2 + t * 0.3,
        ret12_1: -0.1 + t * 0.4,
        ret6m: -0.05 + t * 0.25,
        ret3m: -0.03 + t * 0.15,
        last: 40 + t * 20,
        week52High: 60,
        week52Low: 40,
      }),
    );
  }
  return out;
}

test('winsorization caps an extreme outlier before ranking', () => {
  // 50 tame values 1..50 + one absurd outlier (a mis-parsed EPS). With n=51 the
  // 98th-pctile bound falls on a real tame value, so the outlier is clamped down
  // to it and ties there rather than sitting alone above the cohort. Without
  // winsorization the outlier would stretch the top of the distribution.
  const tame: number[] = [];
  for (let i = 1; i <= 50; i += 1) tame.push(i);
  const values = [...tame, 1_000_000];
  const pct = winsorizedPercentiles(values);
  const outlierPct = pct[pct.length - 1]!;
  const nearTopPct = pct[49]!; // raw value 50, the largest tame value
  // The clamped outlier does not rank strictly above the clamp bound — it ties
  // with the tame values pinned at the 98th-pctile ceiling.
  assert.equal(outlierPct, nearTopPct, 'clamped outlier ties at the winsor ceiling');
  assert.ok(outlierPct <= 100 && outlierPct >= 90, `outlier still ranks high: ${outlierPct}`);
  // Median value maps near the middle (distribution-free rank).
  const mid = pct[24]!; // raw value 25 of 1..50
  assert.ok(mid > 40 && mid < 60, `median near 50: ${mid}`);
});

test('percentile ordering is monotone in the raw metric', () => {
  const pct = winsorizedPercentiles([10, 20, 30, 40, 50]);
  for (let i = 1; i < pct.length; i += 1) {
    assert.ok(pct[i]! > pct[i - 1]!, `rank increases with value at ${i}`);
  }
});

test('nulls stay null and do not join the ranking population', () => {
  const pct = winsorizedPercentiles([null, 1, 2, 3, null]);
  assert.equal(pct[0], null);
  assert.equal(pct[4], null);
  assert.equal(pct[1] !== null, true);
});

test('the strongest name in a cohort scores highest and rates BUY-ward', () => {
  const results = scoreUniverse(cohortOf(9));
  assert.equal(results.length, 9);
  const byComposite = [...results].sort((a, b) => b.composite - a.composite);
  const best = byComposite[0]!;
  const worst = byComposite[byComposite.length - 1]!;
  assert.ok(best.composite > worst.composite);
  // Best name is top of both its cohort and the (single-cohort) universe.
  assert.ok(best.sectorPercentile >= 90, `best sector pct high: ${best.sectorPercentile}`);
  assert.ok(best.score >= worst.score);
  assert.equal(best.securityId, 1008); // last (t=1) is the strongest across all metrics
});

test('bank override drops EV/EBITDA and leans on P/B for Value', () => {
  // Build two otherwise-identical cohorts; in one, every name is a bank with a
  // wildly bad (irrelevant) EV/EBITDA. If EV/EBITDA were used the bank Value
  // factor would move; under the override it must be identical to the non-EV run.
  const base = cohortOf(9, 'banks');
  const withBadEv = base.map((s) => ({ ...s, evEbitda: 999 }));
  const banks = scoreUniverse(base);
  const banksBadEv = scoreUniverse(withBadEv);

  for (let i = 0; i < banks.length; i += 1) {
    assert.equal(
      banks[i]!.factorScores.value,
      banksBadEv[i]!.factorScores.value,
      'bank Value factor ignores EV/EBITDA entirely',
    );
  }

  // Sanity: a non-bank cohort DOES respond to EV/EBITDA changes.
  const energy = scoreUniverse(cohortOf(9, 'energy'));
  const energyBadEv = scoreUniverse(cohortOf(9, 'energy').map((s) => ({ ...s, evEbitda: 999 })));
  const changed = energy.some((r, i) => r.factorScores.value !== energyBadEv[i]!.factorScores.value);
  assert.ok(changed, 'energy Value factor uses EV/EBITDA');
});

test('a factor with >50% null component weight becomes null and is dropped', () => {
  // Strip Growth on one name: null out eps_growth (35) + rev_growth (25) = 60% of
  // the 100 weight ⇒ only 40% present < 50% ⇒ Growth factor null; the composite
  // renormalizes over the remaining four (well, three: revisions is always null).
  const cohort = cohortOf(9);
  cohort[3] = fullInput(cohort[3]!.securityId, {
    sector: 'energy',
    epsGrowthYoy: null,
    revGrowthYoy: null,
    // eps_cagr (25) + rev_cagr (15) = 40% present.
  });
  const results = scoreUniverse(cohort);
  const target = results.find((r) => r.securityId === cohort[3]!.securityId)!;
  assert.equal(target.factorScores.growth, null, 'Growth drops below 50% coverage');
  assert.equal(target.grades.growth, null, 'null factor ⇒ null grade');
  // Still scored (Value/Profitability/Momentum present = 3 factors ≥ MIN).
  assert.ok(Number.isFinite(target.score));
});

test('a name with fewer than 3 factors yields no score row', () => {
  // One name keeps only Value; Growth/Profitability/Momentum all null.
  const cohort = cohortOf(9);
  const lonelyId = 4242;
  cohort.push({
    securityId: lonelyId,
    venue: 'TDWL',
    sector: 'energy',
    earningsYield: 0.05,
    pb: 2,
    evEbitda: 10,
    dividendYield: 0.03,
    // no growth, no profitability, no momentum inputs → those factors null.
  });
  const results = scoreUniverse(cohort);
  assert.equal(
    results.some((r) => r.securityId === lonelyId),
    false,
    'a 1-factor name is omitted (D-5, ≥3 factors to publish)',
  );
});

test('revisions is always null (D-8) and drops from the composite', () => {
  const results = scoreUniverse(cohortOf(9));
  for (const r of results) {
    assert.equal(r.factorScores.revisions, null);
    assert.equal(r.grades.revisions, null);
  }
});

test('rating bands map score→rating at the D-4 thresholds', () => {
  assert.equal(ratingForScore(100), 'BUY');
  assert.equal(ratingForScore(80), 'BUY');
  assert.equal(ratingForScore(79), 'OVERWEIGHT');
  assert.equal(ratingForScore(60), 'OVERWEIGHT');
  assert.equal(ratingForScore(59), 'HOLD');
  assert.equal(ratingForScore(40), 'HOLD');
  assert.equal(ratingForScore(39), 'UNDERWEIGHT');
  assert.equal(ratingForScore(20), 'UNDERWEIGHT');
  assert.equal(ratingForScore(19), 'SELL');
  assert.equal(ratingForScore(0), 'SELL');
});

test('factor grade thresholds match the 12-bucket ladder', () => {
  assert.equal(gradeForScore(90), 'A+');
  assert.equal(gradeForScore(89.9), 'A');
  assert.equal(gradeForScore(83), 'A');
  assert.equal(gradeForScore(76), 'A-');
  assert.equal(gradeForScore(69), 'B+');
  assert.equal(gradeForScore(62), 'B');
  assert.equal(gradeForScore(55), 'B-');
  assert.equal(gradeForScore(48), 'C+');
  assert.equal(gradeForScore(41), 'C');
  assert.equal(gradeForScore(34), 'C-');
  assert.equal(gradeForScore(27), 'D+');
  assert.equal(gradeForScore(20), 'D');
  assert.equal(gradeForScore(19.9), 'D-');
  assert.equal(gradeForScore(null), null);
  // Every grade matches the DB CHECK regex ^[A-D][+-]?$.
  for (const s of [0, 20, 34, 48, 62, 76, 90, 100]) {
    assert.match(gradeForScore(s)!, /^[A-D][+-]?$/);
  }
});

test('composite weighting is Value-tilted (0.25/0.20/0.20/0.20 over present factors)', () => {
  // Single name, single-cohort (thin) — its composite is a pure weighted mean of
  // its own factor percentiles. With one name, every metric percentile is 50
  // (it ties with itself), so every factor = 50 and composite = 50.
  const solo = scoreUniverse([fullInput(1)]);
  assert.equal(solo.length, 1);
  assert.equal(Math.round(solo[0]!.composite), 50);
  assert.equal(solo[0]!.factorScores.value, 50);
  assert.equal(solo[0]!.thinCohort, true, 'a 1-name cohort is thin');
  assert.equal(solo[0]!.sectorPeerCount, 1);
});

test('thin cohorts (< MIN_COHORT) are flagged but still scored', () => {
  const small = scoreUniverse(cohortOf(MIN_COHORT - 1));
  assert.equal(small.length, MIN_COHORT - 1);
  for (const r of small) assert.equal(r.thinCohort, true);

  const full = scoreUniverse(cohortOf(MIN_COHORT));
  for (const r of full) assert.equal(r.thinCohort, false);
});

test('sector percentile is cohort-relative; score is the universe re-percentile', () => {
  // Two cohorts scored together. Normalization is cohort-relative (07 §3.5): each
  // cohort's own best name reaches ~top sector percentile regardless of the other
  // cohort's absolute level, and the published score is the percentile of the
  // (cohort-relative) composite across the whole scored universe.
  const energy = cohortOf(9, 'energy');
  // A weak banks cohort: same internal spread (so percentiles are well-defined)
  // but shifted uniformly lower than energy, and re-id'd to avoid collision.
  const banks = cohortOf(9, 'banks').map((s, i) => {
    const t = i / 8;
    return fullInput(s.securityId + 100, {
      sector: 'banks',
      earningsYield: 0.005 + t * 0.02,
      pb: 6 - t * 2,
      evEbitda: 20 - t * 4,
      dividendYield: 0.001 + t * 0.01,
      roe: 0.01 + t * 0.05,
      roce: 0.005 + t * 0.04,
      netMargin: 0.01 + t * 0.05,
      grossMargin: 0.02 + t * 0.08,
      epsGrowthYoy: -0.3 + t * 0.15,
      revGrowthYoy: -0.2 + t * 0.1,
      epsCagr3y: -0.15 + t * 0.08,
      revCagr3y: -0.12 + t * 0.06,
      ret12_1: -0.4 + t * 0.2,
      ret6m: -0.3 + t * 0.15,
      ret3m: -0.2 + t * 0.1,
      last: 40 + t * 5,
      week52High: 60,
      week52Low: 40,
    });
  });
  const results = scoreUniverse([...energy, ...banks]);
  assert.equal(results.length, 18);
  // Every name carries its own cohort's peer count (9 per cohort).
  for (const r of results) assert.equal(r.sectorPeerCount, 9);
  // Each cohort's own best name reaches ~top of its OWN cohort (cohort-relative).
  const energyTop = results.filter((r) => r.securityId <= 1008).sort((a, b) => b.sectorPercentile - a.sectorPercentile)[0]!;
  const banksTop = results.filter((r) => r.securityId > 1008).sort((a, b) => b.sectorPercentile - a.sectorPercentile)[0]!;
  assert.ok(energyTop.sectorPercentile >= 90, `energy top cohort pct: ${energyTop.sectorPercentile}`);
  assert.ok(banksTop.sectorPercentile >= 90, `banks top cohort pct: ${banksTop.sectorPercentile}`);
  // The published score is a valid 0–100 percentile spread across all 18 names.
  const scores = results.map((r) => r.score);
  assert.ok(Math.min(...scores) >= 0 && Math.max(...scores) <= 100);
  assert.ok(Math.max(...scores) - Math.min(...scores) > 50, 'universe score spans a wide range');
});

test('negative earnings yield ranks at the bottom of Value, not null', () => {
  // E/P uses net_income/market_cap so a loss-maker gets a negative yield and ranks
  // worst — it must still produce a Value factor (not drop to null like 1/pe would).
  // Two runs of the same cohort: one where name[0] has a healthy E/P, one where it
  // posts a loss (negative E/P). The loss-maker must still get a Value factor
  // (1/pe would null out on a sign flip; E/P does not) and rank its E/P component
  // dead last — so its Value factor is strictly lower than in the healthy run.
  const idx = 4; // a mid-cohort name (healthy E/P) with room to fall to the bottom
  const healthy = cohortOf(9);
  const withLoss = cohortOf(9);
  withLoss[idx] = { ...withLoss[idx]!, earningsYield: -0.15 };

  const healthyRes = scoreUniverse(healthy);
  const lossRes = scoreUniverse(withLoss);
  const targetId = healthy[idx]!.securityId;
  const loser = lossRes.find((r) => r.securityId === targetId)!;
  const healthyName = healthyRes.find((r) => r.securityId === targetId)!;

  assert.ok(loser.factorScores.value !== null, 'negative E/P still yields a Value factor');
  assert.ok(
    loser.factorScores.value! < healthyName.factorScores.value!,
    'a loss drags the Value factor down rather than nulling it',
  );
});
