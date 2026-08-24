/**
 * PR.1 step 2 — the brief verifier. NO DATABASE. Pure, synchronous, testable with the network down.
 *
 * This is the property that makes an evidence layer worth having: **every fact a brief returns
 * resolves to a live lake object, and its field path yields the value the brief froze.** If that
 * does not hold, everything downstream — the writer's bindings, the fit stage's arithmetic pass,
 * the citation allow-set — is built on a claim nobody checked.
 *
 * It takes an already-fetched snapshot map rather than a SQL client on purpose: the assembler does
 * one set-based read, and verification is then a pure function over the result. That keeps it fast,
 * makes it a unit test rather than an integration test, and means it can also run in CI against
 * fixtures with no credentials.
 *
 * ── THE FOUR TRAPS ──────────────────────────────────────────────────────────────────────────────
 * Each has bitten this project or its neighbours already, and each is a golden test:
 *  1. **numeric string vs JSON number.** postgres.js returns `numeric` as a JS *string*
 *     ('902850000'), while a jsonb number arrives as a real number (56.06186582284612). A `===`
 *     between the two is always false, so a correct fact would be reported as drifted.
 *  2. **an absent line_items key.** `binding.ts`'s regex validates a path's SHAPE, never that the
 *     key exists. A bank has no `gross_profit`; an industrial has no `net_interest_income`.
 *     Resolving to `undefined` must be a failure, not a null fact.
 *  3. **a non-v4 uuid.** `lake.objects.id` defaults to `gen_random_uuid()` and 20,000/20,000 live
 *     ids are strict RFC v4, so `z.uuid()` in the binding schema is strict too. A DB-legal
 *     8-4-4-4-12 hex that is not v4 passes Postgres and fails the binding — the exact bug that was
 *     living in `fit.test.ts`'s own OBJ constant.
 *  4. **a retired object.** Producers supersede by natural key nightly (COMPUTED.RATIOS measured
 *     13.9 revisions per key). A brief that binds a superseded revision either refuses at fit or,
 *     worse, follows the chain and renders a NEW value under FROZEN prose.
 *
 * @see docs/architecture/build-specs/PR1-evidence-bundles.md §9 step 2
 */
import type { Evidence, EvidenceBrief, EvidenceLeg } from "./envelope.js";
import { formatFor, isLineItemField, isResolvableField } from "./lexicon.js";
import { STATUSES_ALLOWING_ANY_EVIDENCE, STATUSES_ALLOWING_BOUND_FACTS } from "./types.js";

/** A live `lake.objects` row, as the assembler read it. */
export interface ObjectSnapshot {
  id: string;
  object_type: string;
  natural_key: string;
  revision: number;
  state: string;
  /** null ⇒ live. Non-null ⇒ superseded, and never bindable. */
  superseded_by: string | null;
  effective_date: string | null;
  unit: string | null;
  payload: Record<string, unknown> | null;
}

export type ResolveFailureCode =
  | "unknown_object"
  | "superseded"
  | "retired"
  | "field_not_resolvable"
  | "field_missing"
  | "value_mismatch"
  | "format_missing"
  | "status_carries_evidence"
  | "bound_fact_in_unbound_status"
  | "allow_set_mismatch"
  | "duplicate_fact_id";

export interface ResolveFailure {
  code: ResolveFailureCode;
  fact_id: string;
  bundle: string;
  detail: string;
}

/** RFC 9562 v4, matching Zod's `z.uuid()` — version nibble 4, variant nibble 8/9/a/b. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isStrictUuidV4(v: string): boolean {
  return UUID_V4.test(v);
}

/**
 * Resolve a dotted path against a snapshot.
 *
 * Returns `{ found: false }` for a missing key — distinct from `{ found: true, value: null }` for a
 * key that exists and is null. Trap 2 depends on the difference: `dividend_yield` is null on all
 * 736 COMPUTED.RATIOS rows (present, null) whereas `gross_profit` is simply absent from a bank's
 * line items (missing), and only the second is a bug in the assembler.
 */
export function resolveField(
  snap: ObjectSnapshot,
  field: string,
): { found: boolean; value: unknown } {
  if (field === "effective_date") return { found: true, value: snap.effective_date };
  if (field === "unit") return { found: true, value: snap.unit };

  const parts = field.split(".");
  if (parts[0] !== "payload") return { found: false, value: undefined };

  let cur: unknown = snap.payload;
  for (const key of parts.slice(1)) {
    if (cur === null || cur === undefined || typeof cur !== "object") return { found: false, value: undefined };
    if (!Object.prototype.hasOwnProperty.call(cur, key)) return { found: false, value: undefined };
    cur = (cur as Record<string, unknown>)[key];
  }
  return { found: true, value: cur };
}

/**
 * Compare a frozen brief value against a freshly resolved one.
 *
 * Trap 1 lives here. postgres.js returns `numeric` columns as JS strings while jsonb numbers
 * arrive as numbers, so '6250000000.00' and 6250000000 are the same fact in two representations.
 * Numbers are compared numerically with a relative tolerance; everything else by string identity.
 */
export function valuesAgree(frozen: unknown, live: unknown, relTol = 1e-9): boolean {
  if (frozen === null || frozen === undefined) return live === null || live === undefined;
  if (live === null || live === undefined) return false;

  const fN = typeof frozen === "number" ? frozen : Number(frozen);
  const lN = typeof live === "number" ? live : Number(live);
  const bothNumeric =
    Number.isFinite(fN) && Number.isFinite(lN) &&
    (typeof frozen === "number" || String(frozen).trim() !== "") &&
    (typeof live === "number" || String(live).trim() !== "");

  if (bothNumeric) {
    if (fN === lN) return true;
    const scale = Math.max(Math.abs(fN), Math.abs(lN));
    return scale === 0 ? Math.abs(fN - lN) <= relTol : Math.abs(fN - lN) / scale <= relTol;
  }
  return String(frozen) === String(live);
}

function checkEvidence(
  ev: Evidence,
  leg: EvidenceLeg,
  objects: Map<string, ObjectSnapshot>,
  out: ResolveFailure[],
): void {
  const fail = (code: ResolveFailureCode, detail: string) =>
    out.push({ code, fact_id: ev.fact_id, bundle: ev.bundle, detail });

  // An unbound fact has no binding by construction — nothing to resolve, and that is the point.
  if (ev.kind === "unbound") {
    if (!STATUSES_ALLOWING_ANY_EVIDENCE.has(leg.status)) {
      fail("status_carries_evidence", `leg status '${leg.status}' may not carry evidence`);
    }
    return;
  }

  if (!STATUSES_ALLOWING_BOUND_FACTS.has(leg.status)) {
    fail(
      "bound_fact_in_unbound_status",
      `leg status '${leg.status}' may not carry a ${ev.kind}; only present/stale may`,
    );
    return;
  }

  const id = ev.binding.object_id;

  // Trap 3 — a DB-legal uuid that the binding schema will refuse.
  if (!isStrictUuidV4(id)) {
    fail("unknown_object", `object_id '${id}' is not a strict RFC v4 uuid and will fail z.uuid()`);
    return;
  }

  const snap = objects.get(id);
  if (!snap) {
    fail("unknown_object", `object_id '${id}' is not in the snapshot set`);
    return;
  }

  // Trap 4 — a superseded revision.
  if (snap.superseded_by !== null) {
    fail(
      "superseded",
      `object ${id} (${snap.object_type} rev ${snap.revision}) is superseded by ${snap.superseded_by}`,
    );
    return;
  }
  if (snap.state === "RETIRED") {
    fail("retired", `object ${id} is RETIRED and may never be returned by a bundle`);
    return;
  }

  if (ev.kind === "ref") return; // a ref carries no field and no value, by design

  const field = ev.binding.field;
  if (!isResolvableField(field)) {
    fail(
      "field_not_resolvable",
      `field '${field}' is outside RESOLVABLE_FIELD (numeric_value is excluded absolutely)`,
    );
    return;
  }

  // Trap 2 — the path is well-formed but the key does not exist on this object.
  const { found, value } = resolveField(snap, field);
  if (!found) {
    fail("field_missing", `field '${field}' does not exist on ${snap.object_type} ${id}`);
    return;
  }

  // Trap 1 — string-vs-number across the postgres.js/jsonb boundary.
  if (!valuesAgree(ev.value, value)) {
    fail(
      "value_mismatch",
      `frozen ${JSON.stringify(ev.value)} != live ${JSON.stringify(value)} at ${snap.object_type}.${field}`,
    );
  }

  if (!isLineItemField(snap.object_type, field) && formatFor(snap.object_type, field) === null) {
    fail("format_missing", `no FIELD_FORMAT entry for ${snap.object_type}|${field}`);
  }
}

/**
 * Verify a brief against the objects it claims to rest on.
 *
 * Returns every failure rather than the first: a brief with six broken facts should report six, so
 * one pass tells the assembler everything that is wrong.
 */
export function verifyBundle(
  brief: EvidenceBrief,
  objects: Map<string, ObjectSnapshot>,
): ResolveFailure[] {
  const out: ResolveFailure[] = [];
  const seen = new Set<string>();
  const bound = new Set<string>();

  for (const leg of brief.legs) {
    if (leg.evidence.length > 0 && !STATUSES_ALLOWING_ANY_EVIDENCE.has(leg.status)) {
      out.push({
        code: "status_carries_evidence",
        fact_id: "-",
        bundle: leg.bundle,
        detail: `leg status '${leg.status}' carries ${leg.evidence.length} evidence items but may carry none`,
      });
    }

    for (const ev of leg.evidence) {
      if (seen.has(ev.fact_id)) {
        out.push({
          code: "duplicate_fact_id",
          fact_id: ev.fact_id,
          bundle: leg.bundle,
          detail: `fact_id '${ev.fact_id}' is used more than once in this brief`,
        });
      }
      seen.add(ev.fact_id);
      if (ev.kind !== "unbound") bound.add(ev.binding.object_id);
      checkEvidence(ev, leg, objects, out);
    }
  }

  // The allow-set is what PR.4 writes to lake.citations. If it disagrees with the bindings the
  // brief actually carries, the writer can cite something the evidence never supported — which is
  // precisely the hole DEF-WRITER-CITATION-ALLOWSET describes.
  const allow = new Set(brief.allow_set);
  for (const id of bound) {
    if (!allow.has(id)) {
      out.push({
        code: "allow_set_mismatch",
        fact_id: "-",
        bundle: "-",
        detail: `object ${id} is bound by evidence but missing from allow_set`,
      });
    }
  }
  for (const id of allow) {
    if (!bound.has(id)) {
      out.push({
        code: "allow_set_mismatch",
        fact_id: "-",
        bundle: "-",
        detail: `object ${id} is in allow_set but no evidence binds it`,
      });
    }
  }

  return out;
}
