import { test } from "node:test";
import assert from "node:assert/strict";
import { usd, pct, num, tokens, mins, dim, bold, warn, info, good } from "../src/format.mjs";
import { wrap, totals } from "../src/render.mjs";
import { fakeSession } from "./helpers.mjs";

test("usd shows cents up to $100 and whole dollars above", () => {
  assert.equal(usd(0), "$0.00");
  assert.equal(usd(4.5), "$4.50");
  assert.equal(usd(99.994), "$99.99");
  assert.equal(usd(100), "$100");
  assert.equal(usd(4184.4), "$4,184");
  assert.equal(usd(1_000_000), "$1,000,000");
});

test("pct rounds to whole percent", () => {
  assert.equal(pct(0), "0%");
  assert.equal(pct(0.985), "99%");
  assert.equal(pct(0.3333), "33%");
  assert.equal(pct(1), "100%");
});

test("num groups thousands", () => {
  assert.equal(num(0), "0");
  assert.equal(num(999), "999");
  assert.equal(num(13823), "13,823");
  assert.equal(num(1234.6), "1,235");
});

test("tokens scales at each thousand boundary", () => {
  assert.equal(tokens(0), "0");
  assert.equal(tokens(999), "999");
  assert.equal(tokens(1000), "1.0K");
  assert.equal(tokens(1500), "1.5K");
  assert.equal(tokens(999_999), "1000.0K");
  assert.equal(tokens(1_000_000), "1.0M");
  assert.equal(tokens(5_800_000_000), "5.8B");
});

test("mins reads as minutes, hours or days", () => {
  assert.equal(mins(0), "0m");
  assert.equal(mins(45), "45m");
  assert.equal(mins(59), "59m");
  assert.equal(mins(60), "1.0h");
  assert.equal(mins(90), "1.5h");
  assert.equal(mins(1439), "24.0h");
  assert.equal(mins(1440), "1.0d");
  assert.equal(mins(2880), "2.0d");
});

test("colour helpers pass text through when the output is not a terminal", () => {
  // Tests never run on a TTY, so these must be identity functions here — and
  // must never corrupt the string with escape codes in piped output.
  for (const f of [dim, bold, warn, info, good]) assert.equal(f("plain"), "plain");
});

test("wrap breaks on words and indents every line", () => {
  const out = wrap("the quick brown fox jumps over the lazy dog", 20, "  ");
  const lines = out.split("\n");
  assert.ok(lines.length > 1);
  for (const l of lines) {
    assert.match(l, /^ {2}\S/, "each line is indented");
    assert.ok(l.length <= 22, `"${l}" fits the width`);
  }
  assert.equal(out.replace(/\s+/g, " ").trim(), "the quick brown fox jumps over the lazy dog");
});

test("wrap handles a single word longer than the width without looping", () => {
  const long = "x".repeat(50);
  const out = wrap(long, 20, "  ");
  assert.equal(out, `  ${long}`);
});

test("wrap on empty input produces nothing", () => {
  assert.equal(wrap("", 20, "  "), "");
});

test("totals sums a window and derives the cache hit rate", () => {
  const t = totals([
    fakeSession({ cost: 10, typedPrompts: 5, assistantTurns: 50, totalToolCalls: 30, toolErrors: 3, tokens: { input: 1000, output: 500, cacheRead: 8000, cacheWrite: 1000, thinking: 0 }, models: { "claude-opus-5": 10 } }),
    fakeSession({ cost: 5, typedPrompts: 3, assistantTurns: 20, totalToolCalls: 10, toolErrors: 0, tokens: { input: 1000, output: 500, cacheRead: 2000, cacheWrite: 1000, thinking: 0 }, models: { "claude-sonnet-5": 5 } }),
  ]);
  assert.equal(t.sessions, 2);
  assert.equal(t.cost, 15);
  assert.equal(t.prompts, 8);
  assert.equal(t.turns, 70);
  assert.equal(t.toolCalls, 40);
  assert.equal(t.toolErrors, 3);
  assert.equal(t.tok, 15_000);
  assert.equal(t.cacheHitRate, 10_000 / 14_000);
  assert.deepEqual(t.models, { "claude-opus-5": 10, "claude-sonnet-5": 5 });
});

test("totals of an empty window is zeroed with a null hit rate", () => {
  const t = totals([]);
  assert.equal(t.sessions, 0);
  assert.equal(t.cost, 0);
  assert.equal(t.cacheHitRate, null);
});
