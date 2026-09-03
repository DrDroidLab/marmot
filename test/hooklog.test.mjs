/**
 * The hook log exists because the hooks are the one part of Marmot nobody can
 * watch working. These tests hold it to the two things that makes it worth
 * having: it records the inputs a decision was made from, and it never costs
 * the nudge it is describing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { append, readLog, trim, logging, logPath, planTrace, hookWiring, hooksMissing, settingsFiles } from "../src/hooklog.mjs";
import { tmpRoot } from "./helpers.mjs";

test("a record round-trips, and the newest comes back first", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  append(root, { event: "Stop", outcome: "nothing to say" });
  append(root, { event: "Stop", outcome: "nudged" });

  const log = readLog(root);
  assert.equal(log.exists, true);
  assert.equal(log.total, 2);
  assert.equal(log.entries[0].outcome, "nudged", "newest first — that is the one you came to read");
  assert.ok(Date.parse(log.entries[0].at), "every record is timestamped");
});

test("a torn line costs one record, not the history", () => {
  // Two hooks can finish in the same moment. A half-written line must not take
  // the log with it.
  const { root, cleanup } = tmpRoot();
  append(root, { event: "Stop", outcome: "one" });
  writeFileSync(logPath(root), `${readFileSync(logPath(root), "utf8")}{"event":"Stop","outc\n`);
  append(root, { event: "Stop", outcome: "two" });

  const log = readLog(root);
  assert.equal(log.skipped, 1);
  assert.deepEqual(log.entries.map((e) => e.outcome), ["two", "one"]);
  cleanup();
});

test("nothing here throws, whatever it is handed", () => {
  // It runs at the end of every assistant turn. A log that can fail is a nudge
  // that can fail.
  assert.doesNotThrow(() => append("/proc/nonexistent-marmot", { event: "Stop" }));
  assert.equal(append("/proc/nonexistent-marmot", { event: "Stop" }), false);
  assert.deepEqual(readLog("/proc/nonexistent-marmot").entries, []);
  assert.doesNotThrow(() => trim("/proc/nonexistent-marmot"));

  const { root, cleanup } = tmpRoot();
  // A value JSON cannot represent must not take the process down.
  const circular = {}; circular.self = circular;
  assert.equal(append(root, { event: "Stop", circular }), false);
  cleanup();
});

test("the log is capped", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  for (let i = 0; i < 60; i += 1) append(root, { event: "Stop", n: i });
  assert.equal(trim(root, 20), 20);
  const log = readLog(root, { limit: 0 });
  assert.equal(log.entries.length, 20);
  assert.equal(log.entries[0].n, 59, "the newest survive");
});

test("logging is on by default, and switchable without a config file", () => {
  // On by default on purpose: a log you have to enable and then reproduce into
  // is off at the moment it would have told you something.
  assert.equal(logging({}, {}), true);
  assert.equal(logging(undefined, {}), true);
  assert.equal(logging({ log: { hooks: false } }, {}), false);
  assert.equal(logging({}, { MARMOT_NO_LOG: "1" }), false);
});

test("the plan is reduced to exactly what decides a nudge", () => {
  // Whether a dollar cap means anything is read off these. A wrong reading is
  // invisible everywhere else, which is the bug this log was written for.
  const p = planTrace({
    plan: "Max 20×",
    ageMins: 90.4,
    stale: true,
    limits: [
      { kind: "weekly_all", percent: 6, active: true },
      { kind: "weekly_scoped", percent: 0, active: false },
    ],
  });
  assert.equal(p.name, "Max 20×");
  assert.deepEqual(p.limits, [["weekly_all", 6]], "expired windows say nothing about the one you are in");
  assert.equal(p.ageMins, 90);
  assert.equal(p.stale, true);
  assert.equal(planTrace(null), null);
});

/** Writes a settings file carrying a Marmot hook. */
const writeHooks = (path, file, event = "Stop") => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ hooks: { [event]: [{ hooks: [{ type: "command", command: `node "${file}"`, timeout: 10 }] }] } }));
};

test("hooks are found wherever they were installed, not just settings.json", (t) => {
  // This was a real false negative: a machine whose hooks worked perfectly was
  // told they were not installed, because only settings.json was read.
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const self = join(root, "hook.mjs");
  writeFileSync(self, "");
  writeHooks(join(root, "settings.local.json"), self, "SessionStart");

  const w = hookWiring(root, { cwd: root, self });
  assert.equal(w.length, 1);
  assert.equal(w[0].event, "SessionStart");
  assert.equal(w[0].scope, "user (local)");
  assert.equal(w[0].exists, true);
  assert.equal(w[0].isRunningCopy, true);
});

test("a hook pointing at a file that is gone is called out", (t) => {
  // `init --hooks` writes an absolute path to the installed copy, so a
  // reinstall to a different prefix leaves an entry that reads correctly in the
  // settings file and silently never runs.
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  writeHooks(join(root, "settings.json"), join(root, "gone", "hook.mjs"));

  const w = hookWiring(root, { cwd: root });
  assert.equal(w[0].exists, false);
  assert.deepEqual(hooksMissing(w), ["SessionStart", "Stop"], "a hook that cannot run is not installed");
});

test("a malformed settings file is reported rather than swallowed", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  writeFileSync(join(root, "settings.json"), "{ not json");
  const w = hookWiring(root, { cwd: root });
  assert.equal(w.length, 1);
  assert.ok(w[0].malformed, "silence here reads as 'no hooks', which is a different problem");
});

test("every scope Claude Code layers is looked at", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const scopes = settingsFiles(root, "/proj").map((f) => f.scope);
  assert.deepEqual(scopes, ["user", "user (local)", "project", "project (local)"]);
  assert.ok(settingsFiles(root, "/proj").some((f) => f.path === "/proj/.claude/settings.json"));
});

test("someone else's hooks are not mistaken for Marmot's", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  writeFileSync(join(root, "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: 'node "/opt/other/lint.mjs"' }] }] } }));
  assert.deepEqual(hookWiring(root, { cwd: root }), []);
});
