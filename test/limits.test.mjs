/**
 * Which ceiling speaks on which plan.
 *
 * On Pro, Max and Team, Claude enforces a 5-hour window and weekly ones, and
 * those are the only thing worth interrupting for — the dollars are a shadow
 * price. On Enterprise and API the spend is real, so dollar caps speak there.
 * The bug this pins down: an empty or stale limit snapshot used to count as
 * "no quota", which fell back to dollars and sent a Max subscriber ten
 * "cost cap" nudges in a week.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS } from "../src/config.mjs";
import { windowRules, sessionRules, limitSteps } from "../src/rules.mjs";
import { enforcesLimits, dollarCapsApply, refreshUsageInBackground } from "../src/plan.mjs";

const TODAY = "2026-09-08";
const row = (id, day, cost) => ({ id, day, cost, models: { "claude-opus-5": cost }, typedPrompts: 30, assistantTurns: 300, totalToolCalls: 200, toolErrors: 0, toolErrorRate: 0, cacheHitRate: 0.98, compactions: 0, mcpCalls: {}, skills: [], filesTouched: new Set(), dirTouches: {}, promptTimes: [], baselineTokens: 30000 });

/** Six ordinary days, then one far past both the cap and the baseline. */
const history = [
  ...[10, 12, 8, 11, 9, 10].map((c, i) => row(`p${i}`, `2026-09-0${i + 1}`, c)),
  row("today", TODAY, 400),
];
const fired = (plan, cfg = DEFAULTS) => windowRules(history, cfg, { today: TODAY, includeMcp: false, plan }).map((w) => w.id);
const sessionCost = (plan) => sessionRules.find((r) => r.id === "session-cost").check(history.at(-1), DEFAULTS, { plan });

const future = (ms) => new Date(Date.now() + ms).toISOString();
const reading = (kind, label, percent) => ({ kind, label, percent, resetsAt: future(kind === "session" ? 3_600_000 : 200_000_000), active: true });

test("Pro, Max and Team are the plans Claude enforces limits on", () => {
  for (const p of ["Pro", "Max", "Max 5×", "Max 20×", "Team", "subscription"]) assert.equal(enforcesLimits(p), true, p);
  for (const p of ["Enterprise", "API", null]) assert.equal(enforcesLimits(p), false, String(p));
});

test("a subscription never hears about dollars, even with no limit reading at all", () => {
  // Missing, empty, stale and expired snapshots: every one of them used to
  // fall back to a dollar cap.
  for (const name of ["Pro", "Max 20×", "Team"]) {
    for (const plan of [
      { plan: name, limits: [], ageMins: null, stale: true },
      { plan: name, limits: [{ ...reading("weekly_all", "weekly", 10), expired: true }], ageMins: 600, stale: true },
      { plan: name, limits: [reading("weekly_all", "weekly", 10)], ageMins: 2, stale: false },
    ]) {
      const ids = fired(plan);
      assert.ok(!ids.includes("daily-cost"), `${name}: no daily cost cap`);
      assert.ok(!ids.includes("daily-baseline"), `${name}: no dollar baseline either`);
      assert.equal(sessionCost(plan), null, `${name}: no session cost cap`);
      assert.equal(dollarCapsApply(plan), false);
    }
  }
});

test("Enterprise and API keep their dollar caps, whatever limits they report", () => {
  for (const plan of [
    { plan: "Enterprise", limits: [], ageMins: 2 },
    { plan: "Enterprise", limits: [reading("weekly_all", "weekly", 10)], ageMins: 2 },
    { plan: "API", limits: [], ageMins: null },
  ]) {
    const ids = fired(plan);
    assert.ok(ids.includes("daily-cost"), `${plan.plan}: daily cost cap`);
    assert.ok(ids.includes("daily-baseline"), `${plan.plan}: baseline`);
    assert.ok(sessionCost(plan), `${plan.plan}: session cost cap`);
  }
});

test("a plan Marmot cannot identify gets dollars, unless it reports limits of its own", () => {
  assert.ok(fired(null).includes("daily-cost"));
  assert.ok(fired({ plan: null, limits: [] }).includes("daily-cost"));
  assert.ok(!fired({ plan: null, limits: [reading("weekly_all", "weekly", 10)], ageMins: 2 }).includes("daily-cost"));
});

test("the default marks are 50, 75 and 90 for every window on every subscription", () => {
  for (const p of ["Pro", "Max 5×", "Max 20×", "Team", "Enterprise"]) {
    for (const kind of ["session", "weekly_all", "weekly_scoped"]) assert.deepEqual(limitSteps(DEFAULTS, p, kind), [50, 75, 90], `${p} ${kind}`);
  }
});

test("a window's own marks win over the plan's", () => {
  const cfg = { ...DEFAULTS, limits: { ...DEFAULTS.limits, byWindow: { session: [90], weekly_all: [] } } };
  assert.deepEqual(limitSteps(cfg, "Max 20×", "session"), [90]);
  assert.deepEqual(limitSteps(cfg, "Max 20×", "five_hour"), [90], "the older name for the same window");
  assert.deepEqual(limitSteps(cfg, "Max 20×", "weekly_all"), [], "an empty list silences a window");
  assert.deepEqual(limitSteps(cfg, "Max 20×", "weekly_scoped"), [50, 75, 90], "the rest keep the plan's marks");

  const plan = { plan: "Max 20×", ageMins: 1, limits: [reading("session", "5-hour session", 80), reading("weekly_scoped", "weekly · Opus", 80)] };
  const keys = windowRules([], cfg, { today: TODAY, includeMcp: false, plan }).filter((w) => w.id === "limit-reached").map((w) => w.key);
  assert.deepEqual(keys, ["limit-reached:weekly_scoped:75"], "80% of the session window is under its own 90% mark");
});

test("a limit nudge names the window it is about", () => {
  // Anything that was not "weekly" used to be called the 5-hour limit, which
  // is what the per-model weekly window was labelled.
  const plan = { plan: "Max 20×", ageMins: 1, limits: [reading("weekly_scoped", "weekly · Opus", 80), reading("session", "5-hour session", 51)] };
  const labels = windowRules([], DEFAULTS, { today: TODAY, includeMcp: false, plan }).filter((w) => w.id === "limit-reached").map((w) => w.label);
  assert.deepEqual(labels, ["75% of your weekly · Opus limit", "50% of your 5-hour session limit"]);
});

test("the background refresh asks Claude Code, detached, and never throws", () => {
  const calls = [];
  const fake = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { on() {}, unref() {} };
  };
  assert.equal(refreshUsageInBackground({ env: { TMPDIR: "/tmp" }, spawnFn: fake }), true);
  assert.equal(calls[0].cmd, "claude");
  assert.deepEqual(calls[0].args, ["-p", "/usage"]);
  assert.equal(calls[0].opts.detached, true, "the hook must not wait on it");
  assert.equal(calls[0].opts.env.MARMOT_NO_REFRESH, "1", "and whatever it starts must not refresh in turn");

  assert.equal(refreshUsageInBackground({ spawnFn: () => { throw new Error("ENOENT"); } }), false);
});
