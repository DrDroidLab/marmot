import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readState, writeState, shouldFire, markFired } from "../src/state.mjs";
import { tmpRoot } from "./helpers.mjs";

test("a fresh machine starts with nothing said", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  assert.deepEqual(readState(root), { digestShownOn: null, fired: {} });
});

test("state round-trips through disk", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const s = readState(root);
  s.digestShownOn = "2026-09-01";
  markFired(s, "sess1", "session-cost", 30);
  writeState(s, root);

  const back = readState(root);
  assert.equal(back.digestShownOn, "2026-09-01");
  assert.equal(back.fired["sess1:session-cost"], 30);
});

test("a rule speaks once per session", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const s = readState(root);
  assert.equal(shouldFire(s, "sess1", "cache-hit"), true);
  markFired(s, "sess1", "cache-hit");
  assert.equal(shouldFire(s, "sess1", "cache-hit"), false);
  assert.equal(shouldFire(s, "sess2", "cache-hit"), true, "a different session is a different fact");
  assert.equal(shouldFire(s, "sess1", "tool-errors"), true, "a different rule too");
});

test("cost rules speak again at each doubling", () => {
  const s = { digestShownOn: null, fired: {} };
  assert.equal(shouldFire(s, "s1", "session-cost", 30), true);
  markFired(s, "s1", "session-cost", 30);

  assert.equal(shouldFire(s, "s1", "session-cost", 40), false, "$40 is not news after $30");
  assert.equal(shouldFire(s, "s1", "session-cost", 59), false);
  assert.equal(shouldFire(s, "s1", "session-cost", 60), true, "twice the last figure is");

  markFired(s, "s1", "session-cost", 60);
  assert.equal(shouldFire(s, "s1", "session-cost", 100), false);
  assert.equal(shouldFire(s, "s1", "session-cost", 120), true);
});

test("the baseline rule doubles too, and non-cost rules never repeat", () => {
  const s = { digestShownOn: null, fired: {} };
  markFired(s, "s1", "daily-baseline", 20);
  assert.equal(shouldFire(s, "s1", "daily-baseline", 40), true);
  assert.equal(shouldFire(s, "s1", "daily-baseline", 25), false);

  markFired(s, "s1", "session-turns", 0);
  assert.equal(shouldFire(s, "s1", "session-turns", 1000), false, "turns is not a cost rule");
});

test("a zero-cost mark still blocks a repeat rather than dividing by zero", () => {
  const s = { digestShownOn: null, fired: {} };
  markFired(s, "s1", "session-cost", 0);
  assert.equal(s.fired["s1:session-cost"], 0.01, "floored, so doubling stays meaningful");
  assert.equal(shouldFire(s, "s1", "session-cost", 0), false);
  assert.equal(shouldFire(s, "s1", "session-cost", 5), true);
});

test("the state file is capped so it cannot grow without bound", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const s = readState(root);
  for (let i = 0; i < 250; i += 1) markFired(s, `sess${i}`, "cache-hit");
  writeState(s, root);

  const back = readState(root);
  const keys = Object.keys(back.fired);
  assert.equal(keys.length, 200);
  assert.ok(keys.includes("sess249:cache-hit"), "the most recent survive");
  assert.ok(!keys.includes("sess0:cache-hit"), "the oldest are dropped");
});

test("a malformed state file costs dedupe, not the nudge", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  writeFileSync(join(root, "marmot-state.json"), "{ not json");
  assert.deepEqual(readState(root), { digestShownOn: null, fired: {} });
});

test("a state file missing its fields degrades to the defaults", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  writeFileSync(join(root, "marmot-state.json"), JSON.stringify({ somethingElse: 1 }));
  assert.deepEqual(readState(root), { digestShownOn: null, fired: {} });
});

test("an unwritable location does not throw", () => {
  const s = { digestShownOn: null, fired: {} };
  assert.doesNotThrow(() => writeState(s, "/proc/nonexistent-marmot-root"));
});

test("the written file is readable JSON", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const s = readState(root);
  markFired(s, "s1", "session-cost", 5);
  writeState(s, root);
  const parsed = JSON.parse(readFileSync(join(root, "marmot-state.json"), "utf8"));
  assert.equal(parsed.fired["s1:session-cost"], 5);
});
