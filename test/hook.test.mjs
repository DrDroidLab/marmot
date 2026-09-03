/**
 * The nudge delivery path, driven the way Claude Code drives it: JSON on stdin,
 * a `systemMessage` on stdout. This is the part that was only ever verified by
 * running a real session against it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpRoot, writeSession, prompt, toolUse, response, usage } from "./helpers.mjs";

const HOOK = fileURLToPath(new URL("../scripts/hook.mjs", import.meta.url));

const fire = (root, input) => {
  const out = execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, MARMOT_ROOT: root, NO_COLOR: "1", MARMOT_NO_NOTIFY: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return out.trim() ? JSON.parse(out) : null;
};

const message = (res) => res?.hookSpecificOutput?.systemMessage ?? "";

/** An expensive session: past the cost cap, long, and never compacted. */
function expensiveSession(root, { id = "sess-live", prompts = 30 } = {}) {
  const entries = [];
  for (let i = 0; i < prompts; i += 1) {
    entries.push(prompt(`step ${i}`));
    entries.push(
      response({
        id: `m${i}`,
        u: usage({ input: 5_000, output: 20_000, cacheRead: 200_000, write1h: 50_000 }),
        text: "working",
        tools: [toolUse("Bash", { command: "ls" })],
      }),
    );
  }
  return writeSession(root, { id, entries });
}

test("a Stop hook on a cheap session says nothing", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const f = writeSession(root, { id: "cheap", entries: [prompt("hi"), response({ id: "m1", u: usage({ output: 100 }), text: "hello" })] });
  assert.equal(fire(root, { hook_event_name: "Stop", transcript_path: f.path }), null);
});

test("a subscription's dollar cap stays quiet, because the money is already spent", (t) => {
  // This shipped broken. `dollarsAreBilled` was right and unit-tested, but the
  // hook called `rule.check(current, cfg)` with no third argument, so `ctx.plan`
  // was undefined and every session rule judged a Max user as pay-as-you-go.
  // The result was a "$25.00 cap" nudge to someone whose money is long gone and
  // whose only real ceiling is the weekly quota. Nothing tested the *context*
  // the hook passes, only the rules given a correct one.
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  writeFileSync(`${root}.json`, JSON.stringify({
    oauthAccount: { organizationRateLimitTier: "default_claude_max_20x", organizationType: "claude_max", billingType: "stripe_subscription" },
    cachedUsageUtilization: {
      fetchedAtMs: Date.now(),
      utilization: { limits: [{ kind: "weekly_all", group: "weekly", percent: 6, severity: "normal", resets_at: new Date(Date.now() + 200_000_000).toISOString(), is_active: true }] },
    },
  }));
  const f = expensiveSession(root, { id: "max-plan" });
  const msg = message(fire(root, { hook_event_name: "Stop", transcript_path: f.path }));
  assert.doesNotMatch(msg, /cost cap/, "a dollar cap means nothing on a plan with quota");

  // And the same session on no identifiable plan still gets it, so this is the
  // plan being read rather than the rule being switched off.
  const { root: r2, cleanup: c2 } = tmpRoot();
  t.after(c2);
  const f2 = expensiveSession(r2, { id: "no-plan" });
  assert.match(message(fire(r2, { hook_event_name: "Stop", transcript_path: f2.path })), /cost cap/);
});

test("a Stop hook on an expensive session emits a systemMessage", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const f = expensiveSession(root);
  const res = fire(root, { hook_event_name: "Stop", transcript_path: f.path });
  const msg = message(res);
  assert.equal(res.hookSpecificOutput.hookEventName, "Stop");
  assert.match(msg, /Marmot/);
  assert.match(msg, /\$/, "a nudge states what it cost");
});

test("a live nudge speaks once, then holds until the cost doubles", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const f = expensiveSession(root);
  const first = message(fire(root, { hook_event_name: "Stop", transcript_path: f.path }));
  assert.ok(first.length > 0);

  const second = message(fire(root, { hook_event_name: "Stop", transcript_path: f.path }));
  assert.equal(second, "", "the same session should not repeat itself every turn");

  // State records what has been said.
  const state = JSON.parse(readFileSync(join(root, "marmot-state.json"), "utf8"));
  assert.ok(Object.keys(state.fired).length > 0);
});

test("only rules listed in `live` may interrupt mid-session", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  // `live` is the whole gate on interrupting: a rule listed there speaks, and
  // one that is not stays for the digest however loudly it applies.
  writeFileSync(join(root, "marmot.json"), JSON.stringify({ live: ["session-cost"], session: { costCap: 1 } }));
  const entries = [prompt("go")];
  for (let i = 0; i < 30; i += 1) entries.push(response({ id: `m${i}`, u: usage({ input: 100_000, output: 1000, cacheRead: 1000 }), text: "x" }));
  const f = writeSession(root, { id: "lowcache", entries });

  const msg = message(fire(root, { hook_event_name: "Stop", transcript_path: f.path }));
  assert.match(msg, /cost cap/i, "a rule the user put in `live` should fire");
});

test("a missing or unreadable transcript is not an error", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  assert.equal(fire(root, { hook_event_name: "Stop", transcript_path: "/nonexistent/x.jsonl" }), null);
  assert.equal(fire(root, { hook_event_name: "Stop" }), null, "no transcript path at all");
});

test("malformed hook input exits cleanly", () => {
  const { root, cleanup } = tmpRoot();
  const out = execFileSync(process.execPath, [HOOK], {
    input: "not json",
    encoding: "utf8",
    env: { ...process.env, MARMOT_ROOT: root, MARMOT_NO_NOTIFY: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  assert.equal(out.trim(), "");
  cleanup();
});

test("the SessionStart digest fires once a day and then holds", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  expensiveSession(root, { id: "yesterday" });

  const first = message(fire(root, { hook_event_name: "SessionStart" }));
  assert.match(first, /Marmot ·/);

  const second = fire(root, { hook_event_name: "SessionStart" });
  assert.equal(second, null, "the digest is once a day, not once a session");

  const state = JSON.parse(readFileSync(join(root, "marmot-state.json"), "utf8"));
  assert.equal(state.digestShownOn, new Date().toISOString().slice(0, 10));
});

test("the digest can be turned off", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  expensiveSession(root);
  writeFileSync(join(root, "marmot.json"), JSON.stringify({ digest: { cadence: "off" } }));
  assert.equal(fire(root, { hook_event_name: "SessionStart" }), null);
});

test("the digest says nothing when there are no sessions at all", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  assert.equal(fire(root, { hook_event_name: "SessionStart" }), null);
});

test("the hook never emits colour escapes into the transcript", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const f = expensiveSession(root);
  const msg = message(fire(root, { hook_event_name: "Stop", transcript_path: f.path }));
  assert.ok(!msg.includes("\x1b["), "ANSI codes would render as noise in the UI");
});
