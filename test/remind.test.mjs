/**
 * `marmot remind`: setting up limit reminders without opening a config file.
 * Defaults are 50/75/90 for every window, and every one of them can be moved —
 * for all windows, for one, or back to the defaults.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpRoot } from "./helpers.mjs";
import { loadConfig } from "../src/config.mjs";
import { limitSteps } from "../src/rules.mjs";

const CLI = fileURLToPath(new URL("../bin/marmot.mjs", import.meta.url));

const run = (root, args, { expectFail = false } = {}) => {
  try {
    return execFileSync(process.execPath, [CLI, "remind", ...args, "--root", root, "--no-refresh"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, MARMOT_NO_NOTIFY: "1", ANTHROPIC_API_KEY: "" } });
  } catch (e) {
    if (!expectFail) throw new Error(`marmot remind ${args.join(" ")} exited ${e.status}\n${e.stdout}\n${e.stderr}`);
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
};

const maxAccount = (root, limits) =>
  writeFileSync(`${root}.json`, JSON.stringify({
    oauthAccount: { organizationRateLimitTier: "default_claude_max_20x", organizationType: "claude_max", billingType: "stripe_subscription" },
    cachedUsageUtilization: { fetchedAtMs: Date.now(), utilization: { limits } },
  }));
const limit = (kind, percent, hours) => ({ kind, percent, severity: "normal", resets_at: new Date(Date.now() + hours * 3_600_000).toISOString(), is_active: true });

test("on Max it lists Claude's own windows at 50, 75 and 90, and keeps dollars out of it", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  maxAccount(root, [limit("session", 12, 2), limit("weekly_all", 40, 60)]);
  const out = run(root, []);
  assert.match(out, /Claude enforces these limits/);
  assert.match(out, /5-hour session\s+50%, 75%, 90%/);
  assert.match(out, /Weekly\s+50%, 75%, 90%/);
  assert.match(out, /now 40%/);
  assert.match(out, /no daily limit/);
  assert.match(out, /Dollar caps stay quiet/);
});

test("--window moves one window's marks and leaves the others alone", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  maxAccount(root, [limit("session", 12, 2), limit("weekly_all", 40, 60)]);
  run(root, ["--window", "session", "--at", "90"]);

  const cfg = loadConfig(root);
  assert.deepEqual(cfg.limits.byWindow, { session: [90] });
  assert.deepEqual(limitSteps(cfg, "Max 20×", "session"), [90]);
  assert.deepEqual(limitSteps(cfg, "Max 20×", "weekly_all"), [50, 75, 90]);
  assert.match(run(root, []), /set for this window/);

  run(root, ["--window", "weekly", "--at", "none"]);
  assert.deepEqual(limitSteps(loadConfig(root), "Max 20×", "weekly_all"), [], "none silences a window");
});

test("--at moves every window, and --reset brings back 50, 75 and 90", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  maxAccount(root, [limit("weekly_all", 40, 60)]);
  run(root, ["--at", "15"]);
  run(root, ["--window", "session", "--at", "95"]);
  assert.deepEqual(limitSteps(loadConfig(root), "Max 20×", "weekly_all"), [15]);
  assert.match(run(root, []), /differ from the default/);

  run(root, ["--reset"]);
  const cfg = loadConfig(root);
  for (const kind of ["session", "weekly_all"]) assert.deepEqual(limitSteps(cfg, "Max 20×", kind), [50, 75, 90], kind);
  const body = JSON.parse(readFileSync(join(root, "marmot.json"), "utf8"));
  assert.equal(body.limits.byPlan, undefined, "the overrides are gone from the file, not copied back in");
});

test("a bad window or a window with nothing to set is refused", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  assert.match(run(root, ["--window", "daily", "--at", "50"], { expectFail: true }), /session, weekly or weekly-model/);
  assert.match(run(root, ["--window", "session"], { expectFail: true }), /needs --at or --reset/);
});

test("where the plan is unknown, it says dollar caps apply", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  assert.match(run(root, []), /Dollar caps: \$50\.00 a day/);
});

test("--turns sets the long-session marks, and --reset brings back 10, 15 and 20", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  assert.match(run(root, []), /Long sessions: 10, 15, 20 prompts/);

  run(root, ["--turns", "30,8"]);
  assert.deepEqual(loadConfig(root).session.turnMarks, [8, 30], "sorted as it is written");
  assert.match(run(root, []), /differ from the default 10, 15, 20/);

  run(root, ["--turns", "none"]);
  assert.match(run(root, []), /Long sessions: silenced/);

  run(root, ["--reset"]);
  assert.deepEqual(loadConfig(root).session.turnMarks, [10, 15, 20]);
  assert.match(run(root, ["--turns", "ten"], { expectFail: true }), /prompt counts/);
});
