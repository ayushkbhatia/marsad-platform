import { test } from "node:test";
import assert from "node:assert/strict";
import { bindingIdsIn } from "../bindings";
import type { AnyBlockNode } from "@/components/blocks";

const OBJ = "00000000-0000-4000-a000-0000000000b1";

test("collects ids from a nested binding, not just the block's own boundObjectId", () => {
  const nodes = [
    { _key: "1", code: "BLK-BIGNUM", payload: { caption: "x", value: { object_id: OBJ, field: "line_items.net_income" } } },
  ] as unknown as AnyBlockNode[];
  assert.deepEqual(bindingIdsIn(nodes), [OBJ]);
});

test("collects the block's boundObjectId even when the payload carries no binding", () => {
  const nodes = [
    { _key: "1", code: "BLK-PROV", payload: { objectType: "FILING.FINANCIALS" }, boundObjectId: OBJ },
  ] as unknown as AnyBlockNode[];
  assert.deepEqual(bindingIdsIn(nodes), [OBJ]);
});

test("de-duplicates so one article is one read, not one per block", () => {
  const nodes = [
    { _key: "1", code: "BLK-BIGNUM", payload: { value: { object_id: OBJ } } },
    { _key: "2", code: "BLK-DELTA", payload: { units: [{ object_id: OBJ, field: "close" }] } },
  ] as unknown as AnyBlockNode[];
  assert.equal(bindingIdsIn(nodes).length, 1);
});

test("a payload with no bindings costs no read", () => {
  const nodes = [
    { _key: "1", code: "BLK-THESIS", payload: { claims: ["a", "b", "c"] } },
  ] as unknown as AnyBlockNode[];
  assert.deepEqual(bindingIdsIn(nodes), []);
});
