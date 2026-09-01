import { test } from "node:test";
import assert from "node:assert/strict";
import { rateFor, turnCost, RATES, FAST_RATES, CACHE_READ, CACHE_WRITE_5M, CACHE_WRITE_1H } from "../src/pricing.mjs";
import { usage } from "./helpers.mjs";

test("rateFor matches a model by prefix, so a dated suffix still prices", () => {
  assert.deepEqual(rateFor("claude-opus-5"), { in: 5, out: 25 });
  assert.deepEqual(rateFor("claude-opus-5-20260101"), { in: 5, out: 25 });
  assert.deepEqual(rateFor("claude-sonnet-5-20260101"), { in: 2, out: 10 });
  assert.deepEqual(rateFor("claude-haiku-4-5-20251001"), { in: 1, out: 5 });
});

test("rateFor takes the longest matching prefix, not the first", () => {
  // Two keys match "claude-opus-5-mini-x". The more specific one must win, or a
  // future cheaper variant silently prices as full Opus.
  const overrides = { "claude-opus-5-mini": { in: 1, out: 4 } };
  assert.deepEqual(rateFor("claude-opus-5-mini-x", undefined, overrides), { in: 1, out: 4 });
  assert.deepEqual(rateFor("claude-opus-5-other", undefined, overrides), { in: 5, out: 25 });
});

test("rateFor returns null for an unknown or absent model", () => {
  assert.equal(rateFor("gpt-4o"), null);
  assert.equal(rateFor("<synthetic>"), null);
  assert.equal(rateFor(""), null);
  assert.equal(rateFor(null), null);
  assert.equal(rateFor(undefined), null);
});

test("fast mode prices Opus at the premium table", () => {
  assert.deepEqual(rateFor("claude-opus-5", "fast"), { in: 10, out: 50 });
  assert.deepEqual(rateFor("claude-opus-4-8", "fast"), { in: 10, out: 50 });
  // Fast rates are exactly 2x the standard Opus rates.
  assert.equal(FAST_RATES["claude-opus-5"].in, RATES["claude-opus-5"].in * 2);
  assert.equal(FAST_RATES["claude-opus-5"].out, RATES["claude-opus-5"].out * 2);
});

test("a model with no fast rate is unpriced in fast mode rather than mispriced", () => {
  // The fast table is not merged over RATES: a model absent from it has no
  // published fast price, and guessing the standard one would understate.
  assert.equal(rateFor("claude-sonnet-5", "fast"), null);
});

test("rate overrides apply to standard rates", () => {
  assert.deepEqual(rateFor("claude-opus-5", undefined, { "claude-opus-5": { in: 3, out: 15 } }), { in: 3, out: 15 });
});

test("turnCost prices each token class at its own multiplier", () => {
  // 1000 in @ $5/M            = 0.005
  // 10000 cache read @ 10%    = 0.005
  // 1000 out @ $25/M          = 0.025
  const c = turnCost(usage({ input: 1000, output: 1000, cacheRead: 10_000 }), "claude-opus-5");
  assert.equal(c.toFixed(6), (0.035).toFixed(6));
});

test("a 1h cache write costs 2x input and a 5m write 1.25x", () => {
  const oneHour = turnCost(usage({ write1h: 10_000 }), "claude-opus-5");
  const fiveMin = turnCost(usage({ write5m: 10_000 }), "claude-opus-5");
  assert.equal(oneHour, (10_000 * 5 * CACHE_WRITE_1H) / 1e6);
  assert.equal(fiveMin, (10_000 * 5 * CACHE_WRITE_5M) / 1e6);
  // The gap this encodes: pricing every write at 5m understates by a fifth.
  assert.equal(oneHour / fiveMin, CACHE_WRITE_1H / CACHE_WRITE_5M);
});

test("both write classes in one response are priced separately", () => {
  const c = turnCost(usage({ write1h: 10_000, write5m: 4_000 }), "claude-opus-5");
  assert.equal(c, (10_000 * 5 * 2 + 4_000 * 5 * 1.25) / 1e6);
});

test("a legacy transcript with only the flat total is priced at the cheaper 5m rate", () => {
  // No `cache_creation` breakdown. Assuming 1h there would overstate; 5m is the
  // conservative read.
  const legacy = turnCost(usage({ write5m: 10_000, flatOnly: true }), "claude-opus-5");
  assert.equal(legacy, (10_000 * 5 * CACHE_WRITE_5M) / 1e6);
});

test("an explicit 1h-only breakdown does not double-count the flat total", () => {
  // `cache_creation_input_tokens` repeats what the breakdown already says. If
  // the fallback fired here the write would be billed twice.
  const u = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 10_000,
    cache_creation: { ephemeral_1h_input_tokens: 10_000 },
  };
  assert.equal(turnCost(u, "claude-opus-5"), (10_000 * 5 * CACHE_WRITE_1H) / 1e6);
});

test("turnCost is null for an unpriced model, and zero-safe for empty usage", () => {
  assert.equal(turnCost(usage({ output: 1000 }), "<synthetic>"), null);
  assert.equal(turnCost(usage({ output: 1000 }), null), null);
  assert.equal(turnCost({}, "claude-opus-5"), 0);
});

test("fast mode doubles the cost of the same usage", () => {
  const u = { input: 1000, output: 1000, cacheRead: 10_000, write1h: 5_000 };
  const std = turnCost(usage(u), "claude-opus-5");
  const fast = turnCost(usage({ ...u, speed: "fast" }), "claude-opus-5");
  assert.equal(fast, std * 2);
});

test("cache read is a tenth of the input rate", () => {
  assert.equal(CACHE_READ, 0.1);
  const read = turnCost(usage({ cacheRead: 1_000_000 }), "claude-opus-5");
  const input = turnCost(usage({ input: 1_000_000 }), "claude-opus-5");
  assert.equal(read, input * CACHE_READ);
});
