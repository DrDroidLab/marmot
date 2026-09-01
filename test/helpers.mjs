/**
 * Fixture builders for the transcript format.
 *
 * The shapes here are copied from real `~/.claude/projects/**\/*.jsonl` entries
 * (keys only — no prompt text from any real session ever lands in this repo).
 * The one that matters most is `response()`: Claude Code writes one entry per
 * content block, and every one of those entries repeats the *same*
 * `message.usage`. Fixtures that emit a single tidy entry per response cannot
 * catch the 1.9x over-count that CLAUDE.md warns about, so `response()` always
 * fans out.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let seq = 0;
const uid = (p) => `${p}_${(seq += 1).toString().padStart(4, "0")}`;

/** A disposable ~/.claude root. Pass the returned `cleanup` to `t.after`. */
export function tmpRoot() {
  const root = mkdtempSync(join(tmpdir(), "marmot-test-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Usage as Claude Code writes it: the 1h/5m breakdown plus the flat total. */
export function usage({
  input = 0,
  output = 0,
  cacheRead = 0,
  write1h = 0,
  write5m = 0,
  thinking = 0,
  speed,
  flatOnly = false,
} = {}) {
  const u = {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: write1h + write5m,
    output_tokens_details: { thinking_tokens: thinking },
    service_tier: "standard",
  };
  // Older transcripts predate the breakdown and carry only the flat total.
  if (!flatOnly) u.cache_creation = { ephemeral_1h_input_tokens: write1h, ephemeral_5m_input_tokens: write5m };
  if (speed) u.speed = speed;
  return u;
}

const base = (over = {}) => ({
  parentUuid: null,
  isSidechain: false,
  uuid: uid("uuid"),
  timestamp: "2026-09-01T10:00:00.000Z",
  userType: "external",
  cwd: "/repo",
  sessionId: "s1",
  version: "2.0.0",
  gitBranch: "main",
  ...over,
});

/** A prompt the developer typed. */
export const prompt = (text, over = {}) =>
  base({ type: "user", promptSource: "typed", message: { role: "user", content: text }, ...over });

/** A user entry that is not a typed prompt: queued, system, or a tool result. */
export const notPrompt = (promptSource, over = {}) =>
  base({ type: "user", promptSource, message: { role: "user", content: "x" }, ...over });

/** A tool result comes back as a `user` entry. */
export const toolResult = (toolUseId, { isError = false, body = "ok", ...over } = {}) =>
  base({
    type: "user",
    promptSource: "system",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: isError, content: body }] },
    toolUseResult: { stdout: body },
    ...over,
  });

export const toolUse = (name, input = {}, id = uid("toolu")) => ({ type: "tool_use", id, name, input });

/**
 * One API response, fanned out across one JSONL entry per content block, each
 * repeating the same `message.id` and the same `message.usage`.
 */
export function response({ id = uid("msg"), model = "claude-opus-5", u = usage(), text = "", thinking = "", tools = [], sidechain = false, stop = "end_turn", over = {} } = {}) {
  const blocks = [];
  if (thinking) blocks.push({ type: "thinking", thinking });
  if (text) blocks.push({ type: "text", text });
  for (const t of tools) blocks.push(t);
  if (!blocks.length) blocks.push({ type: "text", text: "" });

  return blocks.map((b) =>
    base({
      type: "assistant",
      isSidechain: sidechain,
      requestId: `req_${id}`,
      message: { id, type: "message", role: "assistant", model, content: [b], stop_reason: stop, usage: u },
      ...over,
    }),
  );
}

/** The `compact_boundary` marker a /compact writes. */
export const compaction = (over = {}) =>
  base({ type: "system", subtype: "compact_boundary", isMeta: true, ...over });

/** Write entries to `<root>/projects/<project>/<id>.jsonl`. */
export function writeSession(root, { project = "-repo", id = "s1", entries = [] }) {
  const dir = join(root, "projects", project);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, entries.flat().map((e) => JSON.stringify(e)).join("\n") + "\n");
  return { path, id, project };
}

/** Write raw lines, for torn/malformed-line cases. */
export function writeRaw(root, { project = "-repo", id = "s1", text = "" }) {
  const dir = join(root, "projects", project);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, text);
  return { path, id, project };
}

/** A session record shaped like `readSession`'s output, for rule tests. */
export function fakeSession(over = {}) {
  return {
    id: "s1",
    project: "-repo",
    path: "/tmp/s1.jsonl",
    day: "2026-09-01",
    typedPrompts: 5,
    assistantTurns: 50,
    sidechainTurns: 0,
    compactions: 0,
    cost: 10,
    models: { "claude-opus-5": 10 },
    modelTurns: { "claude-opus-5": 50 },
    tokens: { input: 1000, output: 500, cacheRead: 8000, cacheWrite: 1000, thinking: 0 },
    toolCalls: {},
    totalToolCalls: 50,
    toolErrors: 0,
    toolErrorRate: 0,
    cacheHitRate: 0.8,
    skills: new Set(),
    mcpCalls: {},
    filesTouched: new Set(),
    permissionModes: new Set(),
    durationMins: 60,
    ...over,
  };
}
