/**
 * Shared primitives used by more than one surface contract.
 *
 * CONTRACT LAYER — see `docs/BRIDGE-BUILD-PLAN.md` §3. These types are the
 * FE↔BE seam: a sample module and a real adapter are two implementations of
 * the same contract. Never edit a contract to fit a DB shape (Law #1); if the
 * database cannot serve a field, the adapter degrades it honestly and the gap
 * gets a `DEF-*` row in `docs/BUILD-STATUS.md` §7.
 */

/** Direction of a change value — drives colour, never sign alone. */
export type Direction = "up" | "down" | "flat";
