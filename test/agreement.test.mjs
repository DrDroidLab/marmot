/**
 * The two readers must agree.
 *
 * `sessions.mjs` answers "what did this cost" and `detail.mjs` answers "what
 * happened", and they duplicate a little usage-accounting logic to do it. That
 * duplication is the whole risk: a fix applied to one and not the other shows up
 * as a report and a page that disagree about the same session, which is the
 * fastest way to lose trust in both. CLAUDE.md asks for this check by hand after
 * every change to either file; this runs it every time.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readSession } from "../src/sessions.mjs";
import { readSessionDetail } from "../src/detail.mjs";
import { tmpRoot, writeSession, prompt, notPrompt, toolResult, toolUse, response, usage, compaction } from "./helpers.mjs";

/** A session with every shape that matters, exercised through both readers. */
function busySession({ tagged = true } = {}) {
  const entries = [];
  const say = (text) =>
    tagged ? prompt(text) : { type: "user", timestamp: "2026-09-01T10:00:00.000Z", message: { role: "user", content: text } };
  // A legacy file carries no `promptSource` anywhere — not on its tool results
  // either. Reusing the tagged helper here would flip the file out of the
  // fallback path and quietly stop testing it.
  const result = (id, isError = false) =>
    tagged
      ? toolResult(id, { isError })
      : {
          type: "user",
          timestamp: "2026-09-01T10:00:00.000Z",
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "ok" }] },
        };

  entries.push(say("start the work"));
  for (let i = 0; i < 12; i += 1) {
    entries.push(
      response({
        id: `msg_${i}`,
        model: i % 4 === 0 ? "claude-sonnet-5" : "claude-opus-5",
        u: usage({
          input: 100 + i,
          output: 500 + i * 10,
          cacheRead: 20_000 + i * 100,
          write1h: i % 3 === 0 ? 5_000 : 0,
          write5m: i % 3 === 1 ? 2_000 : 0,
          thinking: i % 2 === 0 ? 300 : 0,
        }),
        thinking: i % 2 === 0 ? "thinking" : "",
        text: `reply ${i}`,
        tools: [toolUse("Bash", { command: `cmd ${i}` }, `t${i}`), toolUse("Read", { file_path: `/repo/f${i}.ts` }, `r${i}`)],
        sidechain: i === 7,
      }),
    );
    entries.push(result(`t${i}`, i % 5 === 0));
    entries.push(result(`r${i}`));
    if (i === 5) entries.push(compaction());
    if (i === 6) entries.push(say("follow up"));
  }
  entries.push(response({ id: "msg_skill", u: usage({ output: 50 }), tools: [toolUse("Skill", { skill: "code-review" }), toolUse("mcp__github__create_issue", {})] }));
  if (tagged) entries.push(notPrompt("queued"), notPrompt("system"));
  return entries;
}

function bothReaders(entries) {
  const { root, cleanup } = tmpRoot();
  const f = writeSession(root, { entries });
  const agg = readSession(f);
  const det = readSessionDetail(f.path);
  cleanup();
  return { agg, det };
}

test("the readers agree on cost, turns and tool calls", () => {
  const { agg, det } = bothReaders(busySession());
  assert.equal(det.cost.toFixed(10), agg.cost.toFixed(10), "cost");
  assert.equal(det.assistantTurns, agg.assistantTurns, "model turns");
  assert.equal(det.typedPrompts, agg.typedPrompts, "typed prompts");
  assert.equal(det.totalToolCalls, agg.totalToolCalls, "tool calls");
  assert.equal(det.toolErrors, agg.toolErrors, "tool errors");
  assert.equal(det.compactions, agg.compactions, "compactions");
  assert.equal(det.sidechainTurns, agg.sidechainTurns, "sidechain turns");
});

test("the readers agree on every token class", () => {
  const { agg, det } = bothReaders(busySession());
  assert.deepEqual(det.tokens, agg.tokens);
});

test("the readers agree on the cache hit rate and per-model split", () => {
  const { agg, det } = bothReaders(busySession());
  assert.equal(det.cacheHitRate, agg.cacheHitRate);
  assert.deepEqual(Object.keys(det.models).sort(), Object.keys(agg.models).sort());
  for (const m of Object.keys(agg.models)) assert.equal(det.models[m].toFixed(10), agg.models[m].toFixed(10));
});

test("the readers agree on a legacy transcript that predates promptSource", () => {
  // The fallback for untagged files lives in both readers and must be the same
  // rule, or the report and the page disagree about how many prompts you typed.
  const { agg, det } = bothReaders(busySession({ tagged: false }));
  assert.equal(det.typedPrompts, agg.typedPrompts, "typed prompts on a legacy file");
  assert.equal(det.cost.toFixed(10), agg.cost.toFixed(10));
  assert.equal(det.assistantTurns, agg.assistantTurns);
});

test("the readers agree on a session with nothing but a prompt", () => {
  const { agg, det } = bothReaders([prompt("hello")]);
  assert.equal(det.cost, agg.cost);
  assert.equal(det.typedPrompts, agg.typedPrompts);
  assert.equal(det.assistantTurns, agg.assistantTurns);
  assert.equal(det.cacheHitRate, agg.cacheHitRate);
});
