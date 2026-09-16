/**
 * The menu bar app's contract: `status`, `tick`, and the hook-to-app handoff.
 *
 * The app decodes these payloads without re-deriving anything, so the shape is
 * the interface. And `tick` shares the hooks' state file, so the part worth
 * pinning down is that a mark is announced once — by whichever notices it — and
 * that a running app gets the hook's nudge instead of a dialog.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildStatus, tick, dailySeries } from "../src/status.mjs";
import { appendInbox, appAlive, writeHeartbeat, inboxPath, heartbeatPath } from "../src/inbox.mjs";
import { loadConfig } from "../src/config.mjs";
import { loadSessions } from "../src/sessions.mjs";
import { tmpRoot, writeSession, prompt, response, usage } from "./helpers.mjs";

const CLI = fileURLToPath(new URL("../bin/marmot.mjs", import.meta.url));
const HOOK = fileURLToPath(new URL("../scripts/hook.mjs", import.meta.url));
const ENV = { ...process.env, NO_COLOR: "1", MARMOT_NO_NOTIFY: "1", MARMOT_NO_LOG: "1" };

// Local days are the point of the chart, so pin the zone the assertions assume.
process.env.TZ = "UTC";

/** A Max 20× snapshot with one live weekly window at `percent`. */
function withPlan(root, percent) {
  writeFileSync(
    `${root}.json`,
    JSON.stringify({
      oauthAccount: { organizationRateLimitTier: "default_claude_max_20x", billingType: "stripe_subscription" },
      cachedUsageUtilization: {
        fetchedAtMs: Date.now(),
        utilization: {
          limits: [{ kind: "weekly_all", group: "weekly", percent, severity: "normal", resets_at: new Date(Date.now() + 2 * 86_400_000).toISOString(), is_active: true }],
        },
      },
    }),
  );
  return () => rmSync(`${root}.json`, { force: true });
}

/** Well past the $25 session cap at opus-5 rates: 1.5M output tokens. */
function costlySession(root, id = "sess-costly") {
  const entries = [prompt("go")];
  for (let i = 0; i < 30; i += 1) entries.push(response({ id: `c${i}`, u: usage({ input: 100, output: 50_000 }) }));
  writeSession(root, { project: "-repo", id, entries });
  return join(root, "projects", "-repo", `${id}.jsonl`);
}

test("status carries every section the app reads", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  costlySession(root);
  // The fixtures are stamped 2026-09-01, so judge the window from a fixed day.
  const s = buildStatus({ root, cfg: loadConfig(root), days: 30, now: Date.parse("2026-09-15T12:00:00Z") });

  assert.equal(s.version, 1);
  assert.equal(s.daily.length, 30, "one entry per day of the window, zeros included");
  assert.ok(s.window.cost > 25);
  assert.equal(s.models[0].model, "claude-opus-5");
  assert.equal(s.plan.name, null);
  assert.deepEqual(s.limits, []);
  assert.equal(s.config.notify.depleted, true);
  assert.equal(s.config._path, undefined, "internal keys stay out of the payload");
  assert.equal(s.hooks.installed, false);
  for (const key of ["today", "spend", "recommendations", "nudges", "recent", "paths"]) assert.ok(key in s, `missing ${key}`);
});

test("status reads the plan and says which limits are live", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  t.after(withPlan(root, 80));
  const s = buildStatus({ root, cfg: loadConfig(root), days: 7 });
  assert.equal(s.plan.name, "Max 20×");
  assert.equal(s.plan.paysPerToken, false);
  assert.equal(s.limits[0].usable, true);
  assert.ok(s.limits[0].pace && typeof s.limits[0].pace.pace === "number");
});

test("dailySeries fills the days nothing ran", () => {
  const now = Date.parse("2026-09-15T12:00:00Z");
  const series = dailySeries([{ daily: { "2026-09-14": { cost: 2, tokens: 2, models: { "claude-opus-5": { cost: 2, tokens: 2 } } } } }], 3, now);
  assert.deepEqual(series.map((d) => [d.day, d.cost, d.tokens]), [["2026-09-13", 0, 0], ["2026-09-14", 2, 2], ["2026-09-15", 0, 0]]);
  assert.deepEqual(series[1].models, [{ model: "claude-opus-5", cost: 2, tokens: 2 }]);
});

test("the chart files each turn under the day it happened, not the day its session ended", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  writeSession(root, {
    id: "sess-midnight",
    entries: [
      prompt("late"),
      response({ id: "late-1", u: usage({ input: 100, output: 1_000 }), over: { timestamp: "2026-09-10T23:30:00.000Z" } }),
      response({ id: "late-2", u: usage({ input: 100, output: 3_000 }), over: { timestamp: "2026-09-11T00:30:00.000Z" } }),
    ],
  });
  const series = dailySeries(loadSessions({ root, days: 30 }), 3, Date.parse("2026-09-11T12:00:00Z"));
  assert.deepEqual(series.map((d) => [d.day, d.tokens]), [["2026-09-09", 0], ["2026-09-10", 1_100], ["2026-09-11", 3_100]]);
  assert.equal(series[2].models[0].model, "claude-opus-5");
});

test("tick announces a crossed mark once, whoever asks twice", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  t.after(withPlan(root, 80));
  const cfg = loadConfig(root);

  const first = tick({ root, cfg });
  assert.equal(first.notifications.length, 1);
  assert.equal(first.notifications[0].key, "limit-reached:weekly_all:75");
  assert.match(first.notifications[0].title, /75% of your weekly limit/);
  assert.match(first.notifications[0].body, /\n\n/, "the body carries the action as well as the detail");

  assert.equal(tick({ root, cfg }).notifications.length, 0);
});

test("tick lets the last mark through the quiet gap, and nothing else", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const cfg = loadConfig(root);
  t.after(withPlan(root, 80));
  assert.equal(tick({ root, cfg }).notifications.length, 1); // starts the quiet gap

  withPlan(root, 92);
  const urgent = tick({ root, cfg });
  assert.equal(urgent.notifications.length, 1);
  assert.equal(urgent.notifications[0].key, "limit-reached:weekly_all:90");
  assert.equal(urgent.notifications[0].urgent, true);
});

test("tick --app writes the heartbeat and drains what the hooks queued", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const cfg = loadConfig(root);
  appendInbox(root, { title: "Marmot · Session past the cost cap", body: "detail\n\naction", id: "session-cost" });

  const r = tick({ root, cfg, app: true });
  assert.equal(r.notifications.length, 1);
  assert.equal(r.notifications[0].source, "hook");
  assert.equal(existsSync(inboxPath(root)), false);
  assert.equal(appAlive(root), true);
  assert.equal(tick({ root, cfg, app: true }).notifications.length, 0, "drained, not re-read");
});

test("an old heartbeat, or MARMOT_NO_APP, means no app", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  writeHeartbeat(root, { now: Date.now() - 10 * 60_000 });
  assert.equal(appAlive(root), false);
  writeHeartbeat(root);
  assert.equal(appAlive(root, { env: { MARMOT_NO_APP: "1" } }), false);
  assert.equal(appAlive(root, { env: {} }), true);
});

const stop = (root, transcript, env = ENV) =>
  execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: "Stop", transcript_path: transcript }),
    encoding: "utf8",
    env: { ...env, MARMOT_ROOT: root, MARMOT_NO_REFRESH: "1" },
  });

test("the Stop hook hands its nudge to a running app instead of a dialog", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const transcript = costlySession(root);
  writeHeartbeat(root);

  // Not silenced, or there is nothing to hand over. The fresh heartbeat is what
  // keeps this from opening a real dialog: the nudge goes to the inbox instead.
  const { MARMOT_NO_NOTIFY, CI, ...loud } = ENV;
  stop(root, transcript, loud);
  const queued = readFileSync(inboxPath(root), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(queued.length, 1);
  assert.match(queued[0].title, /cost cap/);
  assert.match(queued[0].body, /\n\n/, "the app always gets the action too");
});

test("with no app running the hook never writes an inbox", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  stop(root, costlySession(root));
  assert.equal(existsSync(inboxPath(root)), false);
  assert.equal(existsSync(heartbeatPath(root)), false);
});

test("the CLI prints status and tick as JSON", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  costlySession(root);
  const run = (args) => JSON.parse(execFileSync(process.execPath, [CLI, ...args, "--root", root], { encoding: "utf8", env: ENV }));

  assert.equal(run(["status", "--days", "7"]).daily.length, 7);
  assert.equal(run(["tick", "--app"]).version, 1);
  assert.equal(existsSync(heartbeatPath(root)), true);
  assert.equal(run(["status", "--demo"]).demo, true);
});

test("the demo has everything a screenshot needs: limits, a chart, and advice", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const s = JSON.parse(execFileSync(process.execPath, [CLI, "status", "--demo", "--days", "30", "--root", root], { encoding: "utf8", env: ENV }));

  assert.equal(s.demo, true);
  assert.ok(s.plan.name, "a plan to show");
  assert.ok(s.limits.some((l) => (l.percent ?? 0) > 0), "limit bars with something in them");
  assert.ok(s.daily.filter((d) => d.cost > 0).length >= 5, "enough days for a chart");
  assert.ok(s.daily.some((d) => d.models.length), "days carry their model split");
  assert.ok(s.recommendations.length >= 2, `recommendations to read, got ${s.recommendations.length}`);
  assert.ok(
    s.recommendations.some((r) => r.source === "claude-code"),
    "including Claude Code's own attribution",
  );
  assert.ok(s.window.cost > 0 && s.window.tokens > 0);
});

/** A Max 20× snapshot with these windows live: [[kind, percent], ...]. */
function withLimits(root, windows) {
  writeFileSync(
    `${root}.json`,
    JSON.stringify({
      oauthAccount: { organizationRateLimitTier: "default_claude_max_20x", billingType: "stripe_subscription" },
      cachedUsageUtilization: {
        fetchedAtMs: Date.now(),
        utilization: {
          limits: windows.map(([kind, percent]) => ({
            kind,
            group: kind === "session" ? "session" : "weekly",
            percent,
            severity: "normal",
            resets_at: new Date(Date.now() + (kind === "session" ? 3 : 48) * 3_600_000).toISOString(),
            is_active: true,
          })),
        },
      },
    }),
  );
  return () => rmSync(`${root}.json`, { force: true });
}

test("a window that just reset stays on the menu at 0%, and never nudges", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  writeFileSync(
    `${root}.json`,
    JSON.stringify({
      oauthAccount: { organizationRateLimitTier: "default_claude_max_20x", billingType: "stripe_subscription" },
      cachedUsageUtilization: {
        fetchedAtMs: Date.now() - 10 * 60_000,
        utilization: {
          limits: [
            { kind: "session", percent: 92, resets_at: new Date(Date.now() - 2 * 60_000).toISOString(), is_active: true },
            { kind: "weekly_all", percent: 18, resets_at: new Date(Date.now() + 86_400_000).toISOString(), is_active: true },
          ],
        },
      },
    }),
  );
  t.after(() => rmSync(`${root}.json`, { force: true }));
  const cfg = loadConfig(root);

  const session = buildStatus({ root, cfg, days: 7 }).limits.find((l) => l.kind === "session");
  assert.deepEqual(
    { percent: session.percent, usable: session.usable, justReset: session.justReset, resetsAt: session.resetsAt },
    { percent: 0, usable: true, justReset: true, resetsAt: null },
  );
  assert.deepEqual(tick({ root, cfg }).notifications, [], "the stale 92% must not fire the 90% mark");
});

test("limitMarks shows the marks each window will really speak at", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  t.after(withLimits(root, [["session", 10], ["weekly_all", 10]]));
  const cfg = loadConfig(root);
  cfg.limits = { ...cfg.limits, byWindow: { session: [30, 60], weekly_all: [] } };

  const { limitMarks } = buildStatus({ root, cfg, days: 7 });
  assert.deepEqual(limitMarks.session, { marks: [30, 60], custom: true });
  assert.deepEqual(limitMarks.weekly_all, { marks: [], custom: true }, "an empty list silences the window");
  assert.deepEqual(limitMarks.weekly_scoped, { marks: [50, 75, 90], custom: false }, "no override: the plan's marks");
});

test("tick nudges at each window's own marks, and never for a silenced window", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  t.after(withLimits(root, [["session", 35], ["weekly_all", 80]]));
  const cfg = loadConfig(root);
  cfg.limits = { ...cfg.limits, byWindow: { session: [30], weekly_all: [] } };

  const r = tick({ root, cfg });
  assert.deepEqual(r.notifications.map((n) => n.key), ["limit-reached:session:30"]);
  assert.equal(r.held, 0, "the silenced weekly window is not even held back");
});

test("any number of marks: each one speaks once as usage climbs past it", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const cfg = loadConfig(root);
  cfg.limits = { ...cfg.limits, byWindow: { weekly_all: [10, 20, 40, 60, 80] } };
  cfg.interrupt = { ...cfg.interrupt, minGapMins: 0 };

  const heard = [];
  for (const percent of [15, 25, 25, 45, 85]) {
    withLimits(root, [["weekly_all", percent]]);
    heard.push(...tick({ root, cfg }).notifications.map((n) => n.key));
  }
  t.after(() => rmSync(`${root}.json`, { force: true }));
  assert.deepEqual(heard, ["limit-reached:weekly_all:10", "limit-reached:weekly_all:20", "limit-reached:weekly_all:40", "limit-reached:weekly_all:80"]);
});
