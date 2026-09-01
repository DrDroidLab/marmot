import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, utimesSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readSession, loadSessions, sessionFiles, configuredServers, byDay } from "../src/sessions.mjs";
import { tmpRoot, writeSession, writeRaw, prompt, notPrompt, toolResult, toolUse, response, usage, compaction } from "./helpers.mjs";

const read = (root, f) => readSession(f);

/* ── Invariant 1: usage is counted once per API response ───────────────── */

test("usage is counted once per response, not once per content block", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);

  // One response, five JSONL entries: thinking, text, and three tool calls.
  // Every entry repeats the same usage object, exactly as Claude Code writes it.
  const entries = response({
    id: "msg_1",
    u: usage({ input: 1000, output: 2000, cacheRead: 50_000, write1h: 10_000 }),
    thinking: "considering",
    text: "here is the answer",
    tools: [toolUse("Bash", { command: "ls" }), toolUse("Read", { file_path: "/a.ts" }), toolUse("Edit", { file_path: "/a.ts" })],
  });
  assert.equal(entries.length, 5, "fixture must fan out, or it cannot catch the bug");

  const f = writeSession(root, { entries: [prompt("go"), entries] });
  const s = read(root, f);

  assert.equal(s.assistantTurns, 1, "five entries are one model turn");
  assert.equal(s.tokens.output, 2000, "output counted once, not 5x");
  assert.equal(s.tokens.input, 1000);
  assert.equal(s.tokens.cacheRead, 50_000);
  assert.equal(s.tokens.cacheWrite, 10_000);
  // Content blocks, unlike usage, are per-entry and must all be counted.
  assert.equal(s.totalToolCalls, 3);
});

test("summing per entry would inflate a tool-heavy session by ~1.9x", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);

  // Shaped like a real tool-heavy session: every response carries a thinking
  // block, text and a tool call, so entries outnumber responses ~3:1.
  const entries = [prompt("go")];
  let naive = 0;
  const perResponse = 1000;
  for (let i = 0; i < 10; i += 1) {
    const r = response({ id: `msg_${i}`, u: usage({ output: perResponse }), thinking: "t", text: "x", tools: [toolUse("Bash", { command: "ls" })] });
    naive += r.length * perResponse;
    entries.push(r);
  }
  const s = read(root, writeSession(root, { entries }));

  assert.equal(s.assistantTurns, 10);
  assert.equal(s.tokens.output, 10 * perResponse);
  assert.equal(naive / s.tokens.output, 3, "the naive read is 3x here — the reader must not be");
});

test("responses are deduped by message.id, falling back to requestId", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);

  // Two entries sharing a message.id are one response; a different id is a
  // second response even when the text is identical.
  const a = response({ id: "msg_same", u: usage({ output: 100 }), text: "one", tools: [toolUse("Bash", { command: "a" })] });
  const b = response({ id: "msg_other", u: usage({ output: 100 }), text: "one" });
  const s = read(root, writeSession(root, { entries: [a, b] }));
  assert.equal(s.assistantTurns, 2);
  assert.equal(s.tokens.output, 200);
});

test("an entry with no message id still counts, keyed on requestId", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const entries = response({ id: "msg_x", u: usage({ output: 100 }), text: "hi" }).map((e) => {
    delete e.message.id;
    e.requestId = "req_shared";
    return e;
  });
  const dup = response({ id: "msg_y", u: usage({ output: 100 }), text: "hi again" }).map((e) => {
    delete e.message.id;
    e.requestId = "req_shared";
    return e;
  });
  const s = read(root, writeSession(root, { entries: [entries, dup] }));
  assert.equal(s.assistantTurns, 1, "same requestId is the same response");
  assert.equal(s.tokens.output, 100);
});

/* ── Invariant 2: a turn is a prompt the human typed ────────────────────── */

test("only promptSource:typed entries count as prompts", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const s = read(
    root,
    writeSession(root, {
      entries: [
        prompt("first"),
        response({ id: "m1", u: usage({ output: 10 }), tools: [toolUse("Bash", { command: "ls" }, "t1")] }),
        toolResult("t1"), // a user entry, but not a prompt
        notPrompt("queued"),
        notPrompt("system"),
        notPrompt(undefined), // compaction continuation
        prompt("second"),
      ],
    }),
  );
  assert.equal(s.typedPrompts, 2);
});

test("a tool-result flood does not inflate the prompt count", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const entries = [prompt("one")];
  for (let i = 0; i < 200; i += 1) {
    entries.push(response({ id: `m${i}`, u: usage({ output: 10 }), tools: [toolUse("Bash", { command: "ls" }, `t${i}`)] }));
    entries.push(toolResult(`t${i}`));
  }
  const s = read(root, writeSession(root, { entries }));
  assert.equal(s.typedPrompts, 1, "201 user entries, one typed prompt");
});

test("older transcripts with no promptSource fall back to the entry shape", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  // Nothing in this file carries promptSource, so the fallback must apply:
  // a user entry counts unless it is carrying a tool_result.
  const legacyPrompt = (text) => ({ type: "user", timestamp: "2026-09-01T10:00:00.000Z", message: { role: "user", content: text } });
  const legacyResult = (id) => ({
    type: "user",
    timestamp: "2026-09-01T10:00:00.000Z",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
  });
  const s = read(
    root,
    writeSession(root, { entries: [legacyPrompt("one"), legacyResult("t1"), legacyResult("t2"), legacyPrompt("two")] }),
  );
  assert.equal(s.typedPrompts, 2);
});

test("one typed entry anywhere switches the whole file off the fallback", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const bare = { type: "user", timestamp: "2026-09-01T10:00:00.000Z", message: { role: "user", content: "untagged" } };
  const s = read(root, writeSession(root, { entries: [prompt("tagged"), bare] }));
  assert.equal(s.typedPrompts, 1, "the untagged entry is a continuation, not a prompt");
});

test("isMeta user entries are never prompts", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const s = read(root, writeSession(root, { entries: [prompt("real"), prompt("meta", { isMeta: true })] }));
  assert.equal(s.typedPrompts, 1);
});

/* ── Invariant 3: cache writes ─────────────────────────────────────────── */

test("cache writes are read from the breakdown when the flat total is absent", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const entries = response({ id: "m1", u: usage({ write1h: 7000, write5m: 3000 }), text: "x" }).map((e) => {
    delete e.message.usage.cache_creation_input_tokens;
    return e;
  });
  const s = read(root, writeSession(root, { entries }));
  assert.equal(s.tokens.cacheWrite, 10_000);
});

test("cost reflects the 1h multiplier, not a flat 1.25x", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const oneHour = read(root, writeSession(root, { id: "a", entries: response({ id: "m1", u: usage({ write1h: 100_000 }), text: "x" }) }));
  const fiveMin = read(root, writeSession(root, { id: "b", entries: response({ id: "m2", u: usage({ write5m: 100_000 }), text: "x" }) }));
  assert.equal(oneHour.cost / fiveMin.cost, 1.6);
});

/* ── Defensive parsing ─────────────────────────────────────────────────── */

test("malformed and torn lines are skipped, not fatal", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const good = JSON.stringify(prompt("hello"));
  const turn = response({ id: "m1", u: usage({ output: 100 }), text: "hi" }).map((e) => JSON.stringify(e)).join("\n");
  const f = writeRaw(root, { text: `${good}\nnot json at all\n\n${turn}\n{"type":"assistant","message":` });
  const s = readSession(f);
  assert.equal(s.typedPrompts, 1);
  assert.equal(s.assistantTurns, 1);
  assert.equal(s.tokens.output, 100);
});

test("an empty or whitespace-only file yields no session", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  assert.equal(readSession(writeRaw(root, { id: "empty", text: "" })), null);
  assert.equal(readSession(writeRaw(root, { id: "blank", text: "\n\n  \n" })), null);
});

test("a missing file yields null rather than throwing", () => {
  assert.equal(readSession({ path: "/nonexistent/nope.jsonl", id: "x", project: "p" }), null);
});

test("an entry with no message is ignored", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const s = read(root, writeSession(root, { entries: [prompt("hi"), { type: "assistant", timestamp: "2026-09-01T10:00:00.000Z" }, { type: "ai-title", aiTitle: "x" }] }));
  assert.equal(s.assistantTurns, 0);
});

test("non-object content blocks do not throw", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const entries = response({ id: "m1", u: usage({ output: 10 }), text: "x" });
  entries[0].message.content = [null, "a string", 42, { type: "tool_use", name: "Bash", input: { command: "ls" }, id: "t1" }];
  const s = read(root, writeSession(root, { entries }));
  assert.equal(s.totalToolCalls, 1);
});

/* ── Extraction ────────────────────────────────────────────────────────── */

test("tool calls, skills and MCP servers are extracted by name", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const s = read(
    root,
    writeSession(root, {
      entries: [
        prompt("go"),
        response({
          id: "m1",
          u: usage({ output: 10 }),
          tools: [
            toolUse("Bash", { command: "ls" }),
            toolUse("Bash", { command: "pwd" }),
            toolUse("Skill", { skill: "code-review" }),
            toolUse("mcp__github__create_issue", { title: "x" }),
            toolUse("mcp__github__list_issues", {}),
            toolUse("mcp__sentry__search_issues", {}),
          ],
        }),
      ],
    }),
  );
  assert.equal(s.totalToolCalls, 6);
  assert.deepEqual(s.toolCalls.Bash, 2);
  assert.deepEqual([...s.skills], ["code-review"]);
  assert.deepEqual(s.mcpCalls, { github: 2, sentry: 1 });
});

test("tool errors are counted and rated against total calls", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const entries = [prompt("go")];
  for (let i = 0; i < 10; i += 1) {
    entries.push(response({ id: `m${i}`, u: usage({ output: 10 }), tools: [toolUse("Bash", { command: "ls" }, `t${i}`)] }));
    entries.push(toolResult(`t${i}`, { isError: i < 3 }));
  }
  const s = read(root, writeSession(root, { entries }));
  assert.equal(s.totalToolCalls, 10);
  assert.equal(s.toolErrors, 3);
  assert.equal(s.toolErrorRate, 0.3);
});

test("compactions are counted from either marker", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const s = read(root, writeSession(root, { entries: [prompt("a"), compaction(), { type: "user", isCompactSummary: true, timestamp: "2026-09-01T10:00:00.000Z", message: { content: "s" } }] }));
  assert.equal(s.compactions, 2);
});

test("unpriced models are surfaced, but synthetic turns are not", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const s = read(
    root,
    writeSession(root, {
      entries: [
        response({ id: "m1", model: "<synthetic>", u: usage({ output: 10 }), text: "local" }),
        response({ id: "m2", model: "some-future-model", u: usage({ output: 10 }), text: "x" }),
        response({ id: "m3", model: "claude-opus-5", u: usage({ output: 10 }), text: "x" }),
      ],
    }),
  );
  assert.deepEqual([...s.unpricedModels], ["some-future-model"]);
  assert.equal(s.pricedTurns, 1);
  assert.equal(s.assistantTurns, 3);
});

test("session metadata, timing and cache hit rate are derived", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const s = read(
    root,
    writeSession(root, {
      entries: [
        prompt("go", { timestamp: "2026-09-01T10:00:00.000Z", cwd: "/repo", gitBranch: "feat/x", version: "2.1.0", permissionMode: "acceptEdits" }),
        response({ id: "m1", u: usage({ input: 1000, cacheRead: 8000, write1h: 1000 }), text: "x", over: { timestamp: "2026-09-01T11:30:00.000Z", trackingPath: "/repo/a.ts" } }),
      ],
    }),
  );
  assert.equal(s.cwd, "/repo");
  assert.equal(s.gitBranch, "feat/x");
  assert.equal(s.version, "2.1.0");
  assert.equal(s.day, "2026-09-01");
  assert.equal(s.durationMins, 90);
  assert.deepEqual([...s.permissionModes], ["acceptEdits"]);
  assert.deepEqual([...s.filesTouched], ["/repo/a.ts"]);
  assert.equal(s.cacheHitRate, 8000 / 10_000);
});

test("a session with no tokens has a null cache hit rate, not a divide by zero", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const s = read(root, writeSession(root, { entries: [prompt("hi")] }));
  assert.equal(s.cacheHitRate, null);
  assert.equal(s.toolErrorRate, 0);
});

test("sidechain turns are counted separately", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const s = read(
    root,
    writeSession(root, {
      entries: [response({ id: "m1", u: usage({ output: 10 }), text: "main" }), response({ id: "m2", u: usage({ output: 10 }), text: "sub", sidechain: true })],
    }),
  );
  assert.equal(s.assistantTurns, 2);
  assert.equal(s.sidechainTurns, 1);
});

/* ── Discovery and windowing ───────────────────────────────────────────── */

test("sessionFiles finds jsonl files and ignores everything else", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  writeSession(root, { project: "-a", id: "one", entries: [prompt("x")] });
  writeSession(root, { project: "-b", id: "two", entries: [prompt("x")] });
  writeFileSync(join(root, "projects", "-a", "notes.txt"), "ignore me");
  const found = [...sessionFiles(root)].map((f) => f.id).sort();
  assert.deepEqual(found, ["one", "two"]);
});

test("sessionFiles is empty when there is no projects directory", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  assert.deepEqual([...sessionFiles(root)], []);
});

test("loadSessions filters on mtime and sorts newest first", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const recent = writeSession(root, { id: "recent", entries: [prompt("x", { timestamp: "2026-09-01T10:00:00.000Z" })] });
  const older = writeSession(root, { id: "older", entries: [prompt("x", { timestamp: "2026-08-20T10:00:00.000Z" })] });
  const stale = writeSession(root, { id: "stale", entries: [prompt("x", { timestamp: "2026-01-01T10:00:00.000Z" })] });

  const ago = (d) => new Date(Date.now() - d * 86_400_000);
  utimesSync(recent.path, ago(0), ago(0));
  utimesSync(older.path, ago(3), ago(3));
  utimesSync(stale.path, ago(90), ago(90));

  const ids = loadSessions({ root, days: 7 }).map((s) => s.id);
  assert.deepEqual(ids, ["recent", "older"], "the 90-day-old file is outside the window");
});

test("byDay rolls sessions up per calendar day, oldest first", () => {
  const mk = (day, cost, prompts, turns) => ({ day, cost, typedPrompts: prompts, assistantTurns: turns });
  const rows = byDay([mk("2026-09-02", 5, 2, 20), mk("2026-09-01", 3, 1, 10), mk("2026-09-01", 4, 3, 15)]);
  assert.deepEqual(
    rows.map((r) => [r.day, r.cost, r.sessions, r.prompts, r.turns]),
    [
      ["2026-09-01", 7, 2, 4, 25],
      ["2026-09-02", 5, 1, 2, 20],
    ],
  );
});

/* ── MCP config ────────────────────────────────────────────────────────── */

test("configuredServers merges mcp.json, settings.json and the project file", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const cwd = join(root, "proj");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(root, "mcp.json"), JSON.stringify({ mcpServers: { github: {}, sentry: {} } }));
  writeFileSync(join(root, "settings.json"), JSON.stringify({ mcpServers: { github: {}, datadog: {} } }));
  writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { local: {} } }));
  assert.deepEqual(configuredServers(root, cwd).sort(), ["datadog", "github", "local", "sentry"]);
});

test("a malformed mcp config is a finding for the report, not a crash", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  writeFileSync(join(root, "mcp.json"), "{ broken");
  writeFileSync(join(root, "settings.json"), JSON.stringify({ mcpServers: { github: {} } }));
  assert.deepEqual(configuredServers(root), ["github"]);
});

test("configuredServers is empty when nothing is configured", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  assert.deepEqual(configuredServers(root), []);
});
