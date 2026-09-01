import { test } from "node:test";
import assert from "node:assert/strict";
import { readSessionDetail } from "../src/detail.mjs";
import { tmpRoot, writeSession, writeRaw, prompt, notPrompt, toolResult, toolUse, response, usage, compaction } from "./helpers.mjs";

const detail = (root, entries, opts) => readSessionDetail(writeSession(root, { entries }).path, opts);

test("the entries of one response merge into a single turn", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const d = detail(root, [
    prompt("go"),
    response({
      id: "msg_1",
      u: usage({ input: 100, output: 2000, cacheRead: 5000, write1h: 1000 }),
      thinking: "hmm",
      text: "doing it",
      tools: [toolUse("Bash", { command: "ls" }), toolUse("Read", { file_path: "/a.ts" })],
    }),
  ]);

  const turns = d.events.filter((e) => e.kind === "assistant");
  assert.equal(turns.length, 1, "one reply, one event — not one per content block");
  assert.equal(turns[0].tools.length, 2, "tools from sibling entries attach to the same turn");
  assert.equal(d.assistantTurns, 1);
  assert.equal(d.tokens.output, 2000);
  assert.equal(d.totalToolCalls, 2);
});

test("text from sibling entries is joined onto the turn", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  // Two text blocks in one response arrive as two entries.
  const entries = [
    ...response({ id: "msg_1", u: usage({ output: 10 }), text: "first part" }),
    ...response({ id: "msg_1", u: usage({ output: 10 }), text: "second part" }),
  ];
  const d = detail(root, entries);
  const turns = d.events.filter((e) => e.kind === "assistant");
  assert.equal(turns.length, 1);
  assert.match(turns[0].text, /first part/);
  assert.match(turns[0].text, /second part/);
  assert.equal(d.tokens.output, 10, "usage still counted once");
});

test("tool results are never stored, only their success or failure", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const secret = "SENSITIVE-FILE-CONTENTS-XYZZY";
  const d = detail(root, [
    prompt("read the file"),
    response({ id: "m1", u: usage({ output: 10 }), tools: [toolUse("Read", { file_path: "/a.ts" }, "t1")] }),
    toolResult("t1", { body: secret }),
  ]);
  assert.equal(JSON.stringify(d).includes(secret), false, "tool result bodies must not reach the page");
  assert.equal(d.events.filter((e) => e.kind === "assistant")[0].tools[0].name, "Read");
});

test("a failed tool result marks the call that produced it", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const d = detail(root, [
    response({ id: "m1", u: usage({ output: 10 }), tools: [toolUse("Bash", { command: "bad" }, "t1"), toolUse("Bash", { command: "good" }, "t2")] }),
    toolResult("t1", { isError: true }),
    toolResult("t2"),
  ]);
  const tools = d.events.filter((e) => e.kind === "assistant")[0].tools;
  assert.equal(tools[0].isError, true);
  assert.equal(tools[1].isError, false);
  assert.equal(d.toolErrors, 1);
});

test("an error result arriving before its call is still attached", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  // The error index is built in a first pass, so ordering cannot matter.
  const d = detail(root, [
    toolResult("t1", { isError: true }),
    response({ id: "m1", u: usage({ output: 10 }), tools: [toolUse("Bash", { command: "x" }, "t1")] }),
  ]);
  assert.equal(d.toolErrors, 1);
});

test("prompts, replies and compactions land in the timeline in order", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const d = detail(root, [
    prompt("first"),
    response({ id: "m1", u: usage({ output: 10 }), text: "reply" }),
    compaction(),
    prompt("second"),
    response({ id: "m2", u: usage({ output: 10 }), text: "reply two" }),
  ]);
  assert.deepEqual(d.events.map((e) => e.kind), ["prompt", "assistant", "compact", "prompt", "assistant"]);
  assert.equal(d.compactions, 1);
  assert.equal(d.typedPrompts, 2);
});

test("skills and MCP servers are counted per name", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const d = detail(root, [
    response({
      id: "m1",
      u: usage({ output: 10 }),
      tools: [toolUse("Skill", { skill: "code-review" }), toolUse("Skill", { skill: "code-review" }), toolUse("mcp__github__create_issue", {})],
    }),
  ]);
  assert.deepEqual(d.skillCounts, { "code-review": 2 });
  assert.deepEqual(d.mcpCounts, { github: 1 });
  const tool = d.events[0].tools[2];
  assert.equal(tool.server, "github");
});

test("long text is clipped and the overflow reported", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const long = "x".repeat(500);
  const d = detail(root, [prompt(long), response({ id: "m1", u: usage({ output: 10 }), text: long })], {
    caps: { prompt: 100, assistant: 50, tool: 10 },
  });
  const p = d.events.find((e) => e.kind === "prompt");
  const a = d.events.find((e) => e.kind === "assistant");
  assert.equal(p.text.length, 100);
  assert.equal(p.truncated, 400);
  assert.equal(a.text.length, 50);
  assert.equal(a.truncated, 450);
});

test("zero caps redact text entirely while keeping the counts", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const d = detail(root, [prompt("my secret prompt"), response({ id: "m1", u: usage({ output: 10 }), text: "the reply" })], {
    caps: { prompt: 0, assistant: 0, tool: 300 },
  });
  assert.equal(JSON.stringify(d).includes("secret"), false);
  assert.equal(JSON.stringify(d).includes("the reply"), false);
  assert.equal(d.typedPrompts, 1);
  assert.equal(d.assistantTurns, 1);
});

test("tool summaries read as one line rather than raw JSON", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const d = detail(root, [
    response({
      id: "m1",
      u: usage({ output: 10 }),
      tools: [
        toolUse("Bash", { command: "npm test", description: "run tests" }),
        toolUse("Read", { file_path: "/repo/a.ts" }),
        toolUse("Grep", { pattern: "TODO", path: "/repo/src" }),
        toolUse("Skill", { skill: "dataviz" }),
        toolUse("Agent", { description: "find the bug", prompt: "long prompt" }),
        toolUse("WebFetch", { url: "https://example.com" }),
        toolUse("TodoWrite", { todos: [1, 2, 3] }),
        toolUse("SomeUnknownTool", { note: "a string value" }),
        toolUse("EmptyTool", { count: 7 }),
      ],
    }),
  ]);
  const t9 = d.events[0].tools.map((x) => x.text);
  assert.deepEqual(t9, [
    "npm test",
    "/repo/a.ts",
    "TODO in /repo/src",
    "dataviz",
    "find the bug",
    "https://example.com",
    "3 items",
    "a string value",
    "count",
  ]);
});

test("session metadata and derived figures are populated", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const d = detail(root, [
    prompt("go", { timestamp: "2026-09-01T10:00:00.000Z", cwd: "/repo", gitBranch: "main", version: "2.1.0", permissionMode: "plan" }),
    { type: "ai-title", aiTitle: "Fix the retry path", sessionId: "s1" },
    response({ id: "m1", u: usage({ input: 1000, cacheRead: 9000, output: 10 }), text: "x", over: { timestamp: "2026-09-01T10:30:00.000Z", trackingPath: "/repo/a.ts" } }),
  ]);
  assert.equal(d.title, "Fix the retry path");
  assert.equal(d.cwd, "/repo");
  assert.equal(d.gitBranch, "main");
  assert.equal(d.day, "2026-09-01");
  assert.equal(d.durationMins, 30);
  assert.deepEqual(d.filesTouched, ["/repo/a.ts"]);
  assert.deepEqual(d.permissionModes, ["plan"]);
  assert.equal(d.cacheHitRate, 0.9);
});

test("cost per turn is attached to each event", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const d = detail(root, [response({ id: "m1", u: usage({ output: 1_000_000 }), text: "x" })]);
  assert.equal(d.events[0].cost, 25);
  assert.equal(d.cost, 25);
  assert.deepEqual(d.models, { "claude-opus-5": 25 });
});

test("an unpriced model contributes no cost but still renders", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const d = detail(root, [response({ id: "m1", model: "<synthetic>", u: usage({ output: 1000 }), text: "local" })]);
  assert.equal(d.cost, 0);
  assert.equal(d.events.length, 1);
});

test("malformed lines are skipped and a missing file returns null", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const f = writeRaw(root, { text: `${JSON.stringify(prompt("hi"))}\ngarbage\n{"partial":` });
  assert.equal(readSessionDetail(f.path).typedPrompts, 1);
  assert.equal(readSessionDetail("/nonexistent/x.jsonl"), null);
  assert.equal(readSessionDetail(writeRaw(root, { id: "empty", text: "" }).path), null);
});

test("queued and system entries are not prompts", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const d = detail(root, [prompt("real"), notPrompt("queued"), notPrompt("system"), toolResult("t1")]);
  assert.equal(d.typedPrompts, 1);
  assert.equal(d.events.filter((e) => e.kind === "prompt").length, 1);
});
