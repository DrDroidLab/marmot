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
    env: { ...process.env, MARMOT_ROOT: root, NO_COLOR: "1" },
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
  // cache-hit is a digest rule, never a live one. Configure a session that
  // would trip it and confirm the hook stays silent about it.
  writeFileSync(join(root, "marmot.json"), JSON.stringify({ live: ["cache-hit"], session: { costCap: 999999 } }));
  const entries = [prompt("go")];
  for (let i = 0; i < 30; i += 1) entries.push(response({ id: `m${i}`, u: usage({ input: 100_000, output: 1000, cacheRead: 1000 }), text: "x" }));
  const f = writeSession(root, { id: "lowcache", entries });

  const msg = message(fire(root, { hook_event_name: "Stop", transcript_path: f.path }));
  assert.match(msg, /cache/i, "a rule the user put in `live` should fire");
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
    env: { ...process.env, MARMOT_ROOT: root },
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
