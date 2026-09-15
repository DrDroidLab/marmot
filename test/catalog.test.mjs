/**
 * The notification catalog: what you were shown, in the words you were shown
 * it, beside what decided it. Driven through the real hook, because the hook is
 * the part nobody can watch.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpRoot, writeSession, prompt, toolUse, response, usage, compaction } from "./helpers.mjs";
import { record, readCatalog, recording, delivery, catalogPath } from "../src/notifications.mjs";
import { readLog } from "../src/hooklog.mjs";

const HOOK = fileURLToPath(new URL("../scripts/hook.mjs", import.meta.url));
const CLI = fileURLToPath(new URL("../bin/marmot.mjs", import.meta.url));

const fire = (root, input, env = {}) => {
  const out = execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, MARMOT_ROOT: root, NO_COLOR: "1", MARMOT_NO_NOTIFY: "1", MARMOT_NO_REFRESH: "1", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return out.trim() ? JSON.parse(out) : null;
};

/** A Max 20× account, with a limit snapshot or with none. */
const maxAccount = (root, limits = null) =>
  writeFileSync(`${root}.json`, JSON.stringify({
    oauthAccount: { organizationRateLimitTier: "default_claude_max_20x", organizationType: "claude_max", billingType: "stripe_subscription" },
    ...(limits ? { cachedUsageUtilization: { fetchedAtMs: Date.now(), utilization: { limits } } } : {}),
  }));
const weekly = (percent) => ({ kind: "weekly_all", group: "weekly", percent, severity: "normal", resets_at: new Date(Date.now() + 2e8).toISOString(), is_active: true });

/** Expensive enough to cross any dollar cap, and optionally compacted part way. */
function expensiveSession(root, { id, compacted = false }) {
  const entries = [];
  for (let i = 0; i < 30; i += 1) {
    if (compacted && i === 10) entries.push(compaction());
    entries.push(prompt(`step ${i}`));
    entries.push(response({ id: `m${i}`, u: usage({ input: 5_000, output: 20_000, cacheRead: 200_000, write1h: 50_000 }), text: "working", tools: [toolUse("Bash", { command: "ls" })] }));
  }
  return writeSession(root, { id, entries });
}

test("a record round-trips, newest first, and can be switched off", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  record(root, { kind: "nudge", title: "one" });
  record(root, { kind: "digest", title: "two" });
  const c = readCatalog(root);
  assert.equal(c.total, 2);
  assert.equal(c.entries[0].title, "two");
  assert.ok(Date.parse(c.entries[0].at));

  assert.equal(recording({ log: { notifications: false } }, {}), false);
  assert.equal(recording({}, { MARMOT_NO_LOG: "1" }), false);
  assert.equal(recording({}, {}), true, "on by default");
  assert.equal(record(root, { kind: "nudge" }, { cfg: { log: { notifications: false } } }), false);
});

test("delivery says where it went, and whether anything was attempted at all", () => {
  const sent = delivery({ style: "alert", desktop: { cmd: "osascript" }, bell: "tty" }, { env: {} });
  assert.deepEqual(sent, { transcript: true, style: "alert", desktop: "osascript", bell: "tty", silenced: false });
  assert.equal(delivery(null, { env: { MARMOT_NO_NOTIFY: "1" } }).silenced, true);
  assert.equal(delivery(null, { env: {}, transcript: false }).desktop, null);
});

test("a limit nudge reaches a compacted session, and the catalog keeps its words", (t) => {
  // Compaction resets context; it does not reset Claude's limits, so it must
  // not quiet a nudge about them.
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  maxAccount(root, [weekly(76)]);
  const f = expensiveSession(root, { id: "compacted", compacted: true });
  const res = fire(root, { hook_event_name: "Stop", transcript_path: f.path });
  const msg = res?.hookSpecificOutput?.systemMessage ?? "";
  assert.match(msg, /75% of your weekly limit/);
  assert.doesNotMatch(msg, /cost cap/, "and no dollar cap on Max");

  const c = readCatalog(root);
  assert.equal(c.total, 1);
  const e = c.entries[0];
  assert.equal(e.kind, "nudge");
  assert.equal(e.title, "Marmot · 75% of your weekly limit");
  assert.match(e.body, /76% of your weekly limit is gone/, "the desktop text itself");
  assert.equal(e.message, msg, "and the transcript line, exactly");
  assert.equal(e.rules[0].id, "limit-reached:weekly_all:75");
  assert.equal(e.session, "compacted");
  assert.equal(e.plan.name, "Max 20×");
  assert.equal(e.delivery.silenced, true, "the test run muted it, and the record says so");
});

test("nothing shown means nothing catalogued", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const f = writeSession(root, { id: "cheap", entries: [prompt("hi"), response({ id: "m1", u: usage({ output: 100 }), text: "hello" })] });
  fire(root, { hook_event_name: "Stop", transcript_path: f.path });
  assert.equal(existsSync(catalogPath(root)), false);
});

test("the daily digest is catalogued too", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  writeSession(root, { id: "d1", entries: [prompt("hi"), response({ id: "m1", u: usage({ output: 100 }), text: "hello" })] });
  const res = fire(root, { hook_event_name: "SessionStart" });
  if (!res) return; // no session inside the digest's window on this clock
  const e = readCatalog(root).entries[0];
  assert.equal(e.kind, "digest");
  assert.equal(e.message, res.hookSpecificOutput.systemMessage);
});

test("a subscription with no limit reading gets no dollar nudge, and asks for a fresh reading", { skip: process.platform === "win32" }, async (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  maxAccount(root, null);
  const f = expensiveSession(root, { id: "unread" });

  // A stand-in `claude` that only writes down how it was called.
  const bin = join(root, "fakebin");
  mkdirSync(bin);
  const marker = join(root, "refreshed");
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "$@" > "${marker}"\n`);
  chmodSync(join(bin, "claude"), 0o755);
  const env = { MARMOT_NO_REFRESH: "", PATH: `${bin}:${process.env.PATH}` };

  const first = fire(root, { hook_event_name: "Stop", transcript_path: f.path }, env)?.hookSpecificOutput?.systemMessage ?? "";
  assert.doesNotMatch(first, /cost cap/, "no $25 cap on Max, however expensive");
  for (let i = 0; i < 60 && !existsSync(marker); i += 1) await new Promise((r) => setTimeout(r, 50));
  assert.equal(readFileSync(marker, "utf8").trim(), "-p /usage", "the next turn has a reading to judge");
  assert.match(readLog(root).entries[0].refresh, /background/);

  fire(root, { hook_event_name: "Stop", transcript_path: f.path }, env);
  assert.match(readLog(root).entries[0].refresh, /recently/, "not a new claude process every turn");
});

test("marmot notifications shows what was said, and --json is pipeable", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const run = (args) => execFileSync(process.execPath, [CLI, ...args, "--root", root], { encoding: "utf8", env: { ...process.env, MARMOT_NO_NOTIFY: "1" } });

  assert.match(run(["notifications"]), /No notifications recorded/);

  record(root, { kind: "nudge", title: "Marmot · 50% of your weekly limit", body: "52% of your weekly limit is gone on Max 20×.", rules: [{ id: "limit-reached:weekly_all:50" }], delivery: { transcript: true, style: "alert", desktop: "osascript", silenced: false } });
  record(root, { kind: "digest", title: "Marmot · daily digest", body: "yesterday: $3.00", delivery: { transcript: true, silenced: false } });

  const out = run(["notifications"]);
  assert.match(out, /2 shown/);
  assert.match(out, /52% of your weekly limit is gone/);
  assert.match(out, /dialog via osascript/);
  assert.match(out, /limit-reached:weekly_all:50/);

  const kinds = run(["notifications", "--json"]).trim().split("\n").map((l) => JSON.parse(l).kind);
  assert.deepEqual(kinds, ["nudge", "digest"], "oldest first");
  assert.equal(run(["notifications", "--path"]).trim(), catalogPath(root));
});

test("test-notification is catalogued, marked as a test", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  execFileSync(process.execPath, [CLI, "test-notification", "--banner", "--root", root], { encoding: "utf8", env: { ...process.env, MARMOT_NO_NOTIFY: "1" } });
  const e = readCatalog(root).entries[0];
  assert.equal(e.kind, "test");
  assert.equal(e.delivery.transcript, false);
  assert.equal(e.delivery.silenced, true);
});
