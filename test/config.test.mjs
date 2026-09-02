import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, configPath, DEFAULTS } from "../src/config.mjs";
import { tmpRoot } from "./helpers.mjs";

const write = (root, obj) => writeFileSync(join(root, "marmot.json"), typeof obj === "string" ? obj : JSON.stringify(obj));

test("with no config file the defaults apply and say so", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const cfg = loadConfig(root);
  assert.equal(cfg._exists, false);
  assert.equal(cfg._path, configPath(root));
  assert.equal(cfg.session.turnCap, DEFAULTS.session.turnCap);
  assert.equal(cfg.daily.costCap, DEFAULTS.daily.costCap);
});

test("an override replaces one value and leaves its siblings alone", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  write(root, { session: { turnCap: 5 } });
  const cfg = loadConfig(root);
  assert.equal(cfg._exists, true);
  assert.equal(cfg.session.turnCap, 5);
  assert.equal(cfg.session.costCap, DEFAULTS.session.costCap, "siblings survive the merge");
  assert.equal(cfg.daily.costCap, DEFAULTS.daily.costCap, "other sections survive too");
});

test("nested sections merge rather than replace", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  write(root, { models: { premiumShare: 0.9 }, cache: { minTurns: 5 } });
  const cfg = loadConfig(root);
  assert.equal(cfg.models.premiumShare, 0.9);
  assert.deepEqual(cfg.models.premium, DEFAULTS.models.premium);
  assert.equal(cfg.cache.minTurns, 5);
  assert.equal(cfg.cache.minHitRate, DEFAULTS.cache.minHitRate);
});

test("arrays are replaced wholesale, not merged element-wise", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  write(root, { live: ["session-cost"], models: { premium: ["claude-fable-5"] } });
  const cfg = loadConfig(root);
  assert.deepEqual(cfg.live, ["session-cost"]);
  assert.deepEqual(cfg.models.premium, ["claude-fable-5"]);
});

test("rate overrides pass through for negotiated rates", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  write(root, { rateOverrides: { "claude-opus-5": { in: 3, out: 15 } } });
  assert.deepEqual(loadConfig(root).rateOverrides, { "claude-opus-5": { in: 3, out: 15 } });
});

test("a malformed config falls back to defaults and warns on stderr", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  write(root, "{ this is not json");

  const written = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => (written.push(String(chunk)), true);
  let cfg;
  try {
    cfg = loadConfig(root);
  } finally {
    process.stderr.write = original;
  }

  assert.equal(cfg.session.turnCap, DEFAULTS.session.turnCap);
  assert.equal(cfg._exists, false, "a file we could not read is not a config");
  assert.match(written.join(""), /ignoring malformed/);
});

test("an empty object config is simply the defaults", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  write(root, {});
  const cfg = loadConfig(root);
  assert.equal(cfg.session.turnCap, DEFAULTS.session.turnCap);
  assert.equal(cfg._exists, true);
});

test("loadConfig never mutates DEFAULTS", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const before = JSON.stringify(DEFAULTS);
  write(root, { session: { turnCap: 999 }, models: { premium: ["x"] } });
  loadConfig(root);
  assert.equal(JSON.stringify(DEFAULTS), before);
});

test("every rule in `live` is a rule that exists", async () => {
  const { sessionRules } = await import("../src/rules.mjs");
  // Window rules are not in `sessionRules`, so they are listed here. Adding a
  // window rule without adding it here is exactly the drift this catches.
  const known = new Set([...sessionRules.map((r) => r.id), "daily-cost", "daily-baseline", "limit-reached", "limit-pace"]);
  for (const id of DEFAULTS.live) assert.ok(known.has(id), `${id} is not a known rule`);
});

test("the defaults carry a ratio gap, a sample and a dollar floor", () => {
  // The three guards every rule is required to have. If one goes missing from
  // the defaults, the rule it belongs to starts firing on everything.
  assert.ok(DEFAULTS.session.turnCap > 0);
  assert.ok(DEFAULTS.session.costFloor > 0);
  assert.ok(DEFAULTS.cache.minTurns > 0 && DEFAULTS.cache.minHitRate > 0);
  assert.ok(DEFAULTS.toolErrors.minCalls > 0 && DEFAULTS.toolErrors.maxRate > 0);
  assert.ok(DEFAULTS.models.lightWorkToolCalls < DEFAULTS.models.lightWorkMaxToolCalls);
  assert.ok(DEFAULTS.daily.baselineMinDays > 0 && DEFAULTS.daily.baselineMinCost > 0);
});
