/**
 * session-turns: a long session, said at 10, 15 and 20 prompts by default, on
 * every plan, compacted or not. Each mark speaks once per session.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS } from "../src/config.mjs";
import { sessionRules, turnMarks } from "../src/rules.mjs";
import { readCatalog } from "../src/notifications.mjs";
import { tmpRoot, writeSession, prompt, response, usage, compaction } from "./helpers.mjs";

const rule = sessionRules.find((r) => r.id === "session-turns");
const at = (typedPrompts, over = {}, cfg = DEFAULTS, plan = null) =>
  rule.check({ typedPrompts, compactions: 0, cost: 0.4, assistantTurns: typedPrompts * 8, ...over }, cfg, { plan });
const withMarks = (marks) => ({ ...DEFAULTS, session: { ...DEFAULTS.session, turnMarks: marks } });

test("it speaks at 10, 15 and 20 prompts by default", () => {
  assert.deepEqual(turnMarks(DEFAULTS), [10, 15, 20]);
  assert.equal(at(9), null);
  assert.equal(at(10).key, "session-turns:10");
  assert.equal(at(14).key, "session-turns:10");
  assert.equal(at(15).key, "session-turns:15");
  assert.equal(at(57).key, "session-turns:20", "the highest mark passed, not every one");
  assert.equal(at(15).label, "15 prompts in this session");
  assert.match(at(15).detail, /15 prompts in this session so far/);
});

test("it speaks on every plan, whatever the session cost", () => {
  for (const name of [null, "Pro", "Max 20×", "Team", "Enterprise", "API"]) {
    assert.equal(at(12, {}, DEFAULTS, { plan: name, limits: [] })?.key, "session-turns:10", String(name));
  }
  assert.ok(at(12, { cost: 0 }), "no dollar floor: on a subscription the dollars are not the point");
});

test("compacting does not quiet it", () => {
  const hit = at(16, { compactions: 2 });
  assert.equal(hit.key, "session-turns:15");
  assert.match(hit.detail, /compacted 2 times/);
  assert.match(at(16, { compactions: 1 }).detail, /compacted once/);
  assert.match(at(16).detail, /never compacted/);
});

test("the marks are yours to set", () => {
  assert.equal(at(12, {}, withMarks([25, 5])).key, "session-turns:5", "in any order");
  assert.equal(at(30, {}, withMarks([25, 5])).key, "session-turns:25");
  assert.equal(at(500, {}, withMarks([])), null, "an empty list silences it");
  assert.equal(at(500, {}, withMarks(null)), null);
  assert.deepEqual(turnMarks(withMarks([0, -3, "x", 8, 8])), [8], "junk costs a mark, not the rule");
});

/* ── through the real hook ─────────────────────────────────────────────── */

const HOOK = fileURLToPath(new URL("../scripts/hook.mjs", import.meta.url));
const fire = (root, input) => {
  const out = execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, MARMOT_ROOT: root, NO_COLOR: "1", MARMOT_NO_NOTIFY: "1", MARMOT_NO_REFRESH: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return out.trim() ? JSON.parse(out).hookSpecificOutput.systemMessage : "";
};

/** A cheap session of `prompts` typed prompts, compacted after the fifth. */
function session(root, prompts) {
  const entries = [];
  for (let i = 0; i < prompts; i += 1) {
    if (i === 5) entries.push(compaction());
    entries.push(prompt(`step ${i}`));
    entries.push(response({ id: `m${i}`, u: usage({ input: 50, output: 200 }), text: "ok" }));
  }
  return writeSession(root, { id: "long", entries });
}

test("the hook says so at each mark, once each, on a Max plan, and catalogues it", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  writeFileSync(`${root}.json`, JSON.stringify({
    oauthAccount: { organizationRateLimitTier: "default_claude_max_20x", organizationType: "claude_max", billingType: "stripe_subscription" },
    cachedUsageUtilization: { fetchedAtMs: Date.now(), utilization: { limits: [{ kind: "weekly_all", percent: 6, resets_at: new Date(Date.now() + 2e8).toISOString(), is_active: true }] } },
  }));
  // No quiet period, so the second mark is not held behind the first.
  writeFileSync(join(root, "marmot.json"), JSON.stringify({ interrupt: { minGapMins: 0 } }));

  const f = session(root, 11);
  const first = fire(root, { hook_event_name: "Stop", transcript_path: f.path });
  assert.match(first, /10 prompts in this session/);
  assert.match(first, /compacted once/, "a compacted session still hears it");
  assert.equal(fire(root, { hook_event_name: "Stop", transcript_path: f.path }), "", "the same mark does not repeat");

  session(root, 16);
  assert.match(fire(root, { hook_event_name: "Stop", transcript_path: f.path }), /15 prompts in this session/, "the next mark is news");

  assert.deepEqual(readCatalog(root).entries.map((e) => e.rules[0].id), ["session-turns:15", "session-turns:10"]);
});
