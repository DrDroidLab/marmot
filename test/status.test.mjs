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
import { tmpRoot, writeSession, prompt, response, usage } from "./helpers.mjs";

const CLI = fileURLToPath(new URL("../bin/marmot.mjs", import.meta.url));
const HOOK = fileURLToPath(new URL("../scripts/hook.mjs", import.meta.url));
const ENV = { ...process.env, NO_COLOR: "1", MARMOT_NO_NOTIFY: "1", MARMOT_NO_LOG: "1" };

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
  const s = buildStatus({ root, cfg: loadConfig(root), days: 30 });

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
  const series = dailySeries([{ day: "2026-09-14", cost: 2, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }], 3, now);
  assert.deepEqual(series.map((d) => [d.day, d.cost, d.tokens]), [["2026-09-13", 0, 0], ["2026-09-14", 2, 2], ["2026-09-15", 0, 0]]);
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
