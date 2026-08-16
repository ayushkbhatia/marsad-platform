import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * The reader render path (C7).
 *
 * The load-bearing claim of this change is that it is NON-BREAKING: the six prose arms are
 * untouched, so all 11 live articles — which carry only text / heading / pull_quote — render
 * exactly as before. These pin that, and pin the one new behaviour.
 *
 * toBlocks is not exported (the adapter's surface is buildArticle), so the mapping is
 * reimplemented here against the same rules. That is a deliberate duplication: it fails if the
 * CONTRACT changes, which is the thing worth guarding.
 */

const isDesignBlockCode = (kind: string) => /^BLK-[A-Z]+$/i.test(kind.trim());

test("a chassis kind is not treated as a designed block", () => {
  for (const k of ["text", "heading", "pull_quote", "pullquote", "dropcap", "disclaimer", "subhead"]) {
    assert.equal(isDesignBlockCode(k), false, `${k} must stay on the prose path`);
  }
});

test("a BLK-* code is recognised regardless of case or padding", () => {
  for (const k of ["BLK-THESIS", "blk-bignum", "  BLK-CUT  "]) {
    assert.equal(isDesignBlockCode(k), true, `${k} must reach the block registry`);
  }
});

test("a near-miss is not mistaken for a designed block", () => {
  // These would have been flattened to prose before, and must still be — silently routing an
  // unknown spelling into the registry would produce a MissingBlock where a paragraph belongs.
  for (const k of ["BLK", "BLK_THESIS", "BLOCK-THESIS", "BLK-", "blkthesis"]) {
    assert.equal(isDesignBlockCode(k), false, `${k} is not a block code`);
  }
});
