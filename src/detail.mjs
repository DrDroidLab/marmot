/**
 * One session, turn by turn.
 *
 * The aggregate reader in `sessions.mjs` answers "what did this cost". This one
 * answers "what actually happened" — every prompt, every model turn, every tool
 * call, in order.
 *
 * It deliberately does NOT carry tool *results*. In a real session those are 95%
 * of the bytes on disk (40MB of one 42MB transcript here), they are the least
 * interesting thing to re-read, and dropping them is what keeps a browsable page
 * under a megabyte. Names, inputs and success/failure are kept.
 */

import { readFileSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { turnCost } from "./pricing.mjs";
import { isTypedPrompt } from "./sessions.mjs";

const CAP = { prompt: 6000, assistant: 3000, tool: 300 };

const clip = (s, n) => {
  const t = String(s ?? "");
  return t.length > n ? { text: t.slice(0, n), truncated: t.length - n } : { text: t, truncated: 0 };
};

const textOf = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
};

/**
 * What a tool call was actually doing, in one line. Reading `{"file_path":
 * "/a/b/c.ts"}` as raw JSON is unreadable at a glance; "c.ts" is not.
 */
function summariseTool(name, input) {
  const i = input ?? {};
  const first = (...keys) => keys.map((k) => i[k]).find((v) => typeof v === "string" && v);
  if (name === "Bash") return first("command") ?? "";
  if (/^(Read|Write|Edit|NotebookEdit)$/.test(name)) {
    const p = first("file_path", "path", "notebook_path") ?? "";
    return p;
  }
  if (/^(Grep|Glob)$/.test(name)) return [first("pattern"), i.path ? `in ${i.path}` : ""].filter(Boolean).join(" ");
  if (name === "Skill") return first("skill", "args") ?? "";
  if (name === "Agent" || name === "Task") return first("description", "prompt") ?? "";
  if (name === "WebFetch" || name === "WebSearch") return first("url", "query") ?? "";
  if (name === "TodoWrite") return Array.isArray(i.todos) ? `${i.todos.length} items` : "";
  const s = Object.values(i).find((v) => typeof v === "string" && v.length);
  return s ?? Object.keys(i).join(", ");
}

export function readSessionDetail(path, { rateOverrides, caps = CAP } = {}) {
  let raw, mtime;
  try {
    mtime = statSync(path).mtime.toISOString();
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }

  const id = basename(path, ".jsonl");
  const s = {
    id,
    project: basename(dirname(path)),
    path,
    mtime,
    cwd: null,
    gitBranch: null,
    version: null,
    startedAt: null,
    endedAt: null,
    title: null,
    events: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
    cost: 0,
    typedPrompts: 0,
    assistantTurns: 0,
    sidechainTurns: 0,
    compactions: 0,
    toolCounts: {},
    toolErrors: 0,
    skillCounts: {},
    mcpCounts: {},
    models: {},
    modelTokens: {},
    // Kept in step with sessions.mjs so a detail record is a superset of a
    // session record: the browser page then runs the same rules over the same
    // fields as the report, and the two cannot quote different numbers.
    baselineTokens: null,
    dirTouches: {},
    promptTimes: [],
    filesTouched: new Set(),
    permissionModes: new Set(),
  };

  let fileHasPromptSource = false;
  const lines = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o.promptSource) fileHasPromptSource = true;
      lines.push(o);
    } catch {
      /* a torn final line is normal while a session is live */
    }
  }
  if (!lines.length) return null;

  // Tool results are read only to learn whether the call failed, and to attach
  // that back to the call. The bodies are never kept.
  // See sessions.mjs: one API response spans several entries sharing a
  // `message.id`, each repeating the same usage. They are merged back into one
  // turn here — which is also how a reader thinks of it: one reply, its text,
  // and the tools it called.
  const turnByResponse = new Map();
  const errored = new Set();
  for (const o of lines) {
    for (const b of o.message?.content ?? []) {
      if (b?.type === "tool_result" && b.is_error && b.tool_use_id) errored.add(b.tool_use_id);
    }
  }

  for (const o of lines) {
    if (o.timestamp) {
      if (!s.startedAt || o.timestamp < s.startedAt) s.startedAt = o.timestamp;
      if (!s.endedAt || o.timestamp > s.endedAt) s.endedAt = o.timestamp;
    }
    s.cwd ??= o.cwd ?? null;
    s.gitBranch ??= o.gitBranch ?? null;
    s.version ??= o.version ?? null;
    s.title ??= o.aiTitle ?? null;
    if (o.permissionMode) s.permissionModes.add(o.permissionMode);
    if (o.trackingPath) {
      s.filesTouched.add(o.trackingPath);
      const dir = o.trackingPath.split("/").slice(0, -1).join("/") || "/";
      const d = (s.dirTouches[dir] ??= { dir, count: 0, firstTurn: s.assistantTurns, lastTurn: s.assistantTurns });
      d.count += 1;
      d.lastTurn = s.assistantTurns;
    }

    if (o.isCompactSummary || o.subtype === "compact_boundary") {
      s.compactions += 1;
      s.events.push({ kind: "compact", at: o.timestamp ?? null });
      continue;
    }

    // Shared with the aggregate reader rather than restated: the two must agree
    // on what a prompt is, and an older transcript's tool results are user
    // entries too — counting them here read a 2-prompt session as 26.
    if (isTypedPrompt(o, fileHasPromptSource)) {
      s.typedPrompts += 1;
      if (o.timestamp) s.promptTimes.push(o.timestamp);
      s.events.push({ kind: "prompt", at: o.timestamp ?? null, ...clip(textOf(o.message?.content), caps.prompt) });
      continue;
    }

    if (o.type !== "assistant" || !o.message) continue;
    const msg = o.message;
    const key = msg.id ?? o.requestId ?? null;
    const existing = key === null ? null : turnByResponse.get(key);

    const tools = [];
    for (const b of msg.content ?? []) {
      if (b?.type !== "tool_use") continue;
      const isMcp = /^mcp__/.test(b.name);
      const server = isMcp ? b.name.split("__")[1] : null;
      const skill = b.name === "Skill" ? b.input?.skill : null;
      s.toolCounts[b.name] = (s.toolCounts[b.name] ?? 0) + 1;
      if (skill) s.skillCounts[skill] = (s.skillCounts[skill] ?? 0) + 1;
      if (server) s.mcpCounts[server] = (s.mcpCounts[server] ?? 0) + 1;
      const isError = b.id ? errored.has(b.id) : false;
      if (isError) s.toolErrors += 1;
      tools.push({ name: b.name, server, skill, isError, ...clip(summariseTool(b.name, b.input), caps.tool) });
    }
    const body = textOf(msg.content);

    if (existing) {
      existing.tools.push(...tools);
      if (body) {
        const merged = clip([existing.text, body].filter(Boolean).join("\n"), caps.assistant);
        existing.text = merged.text;
        existing.truncated = merged.truncated;
      }
      continue;
    }

    const u = msg.usage;
    let cost = 0;
    if (u) {
      s.assistantTurns += 1;
      if (o.isSidechain) s.sidechainTurns += 1;
      const cc = u.cache_creation ?? {};
      s.tokens.input += u.input_tokens ?? 0;
      s.tokens.output += u.output_tokens ?? 0;
      s.tokens.cacheRead += u.cache_read_input_tokens ?? 0;
      s.tokens.cacheWrite += u.cache_creation_input_tokens ?? (cc.ephemeral_1h_input_tokens ?? 0) + (cc.ephemeral_5m_input_tokens ?? 0);
      s.tokens.thinking += u.output_tokens_details?.thinking_tokens ?? 0;
      cost = turnCost(u, msg.model, rateOverrides) ?? 0;
      s.cost += cost;
      if (msg.model) {
        s.models[msg.model] = (s.models[msg.model] ?? 0) + cost;
        const inTok = u.input_tokens ?? 0;
        const outTok = u.output_tokens ?? 0;
        const readTok = u.cache_read_input_tokens ?? 0;
        const writeTok = u.cache_creation_input_tokens ?? (cc.ephemeral_1h_input_tokens ?? 0) + (cc.ephemeral_5m_input_tokens ?? 0);
        const mt = (s.modelTokens[msg.model] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
        mt.input += inTok;
        mt.output += outTok;
        mt.cacheRead += readTok;
        mt.cacheWrite += writeTok;
        mt.total += inTok + outTok + readTok + writeTok;
      }
      if (s.baselineTokens === null && !o.isSidechain) {
        s.baselineTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? (cc.ephemeral_1h_input_tokens ?? 0) + (cc.ephemeral_5m_input_tokens ?? 0));
      }
    }

    if (!u && !tools.length && !body) continue;
    const ev = {
      kind: "assistant",
      at: o.timestamp ?? null,
      model: msg.model ?? null,
      sidechain: !!o.isSidechain,
      cost,
      stop: msg.stop_reason ?? null,
      thinking: u?.output_tokens_details?.thinking_tokens ?? 0,
      tok: u ? { in: u.input_tokens ?? 0, out: u.output_tokens ?? 0, cr: u.cache_read_input_tokens ?? 0, cw: u.cache_creation_input_tokens ?? 0 } : null,
      tools,
      ...clip(body, caps.assistant),
    };
    s.events.push(ev);
    if (key !== null) turnByResponse.set(key, ev);
  }

  s.startedAt ??= mtime;
  s.endedAt ??= mtime;
  s.day = s.endedAt.slice(0, 10);
  s.durationMins = (new Date(s.endedAt) - new Date(s.startedAt)) / 60000;
  s.filesTouched = [...s.filesTouched];
  s.permissionModes = [...s.permissionModes];
  const seen = s.tokens.cacheRead + s.tokens.cacheWrite + s.tokens.input;
  s.cacheHitRate = seen ? s.tokens.cacheRead / seen : null;
  s.totalToolCalls = Object.values(s.toolCounts).reduce((a, c) => a + c, 0);
  s.toolErrorRate = s.totalToolCalls ? s.toolErrors / s.totalToolCalls : 0;
  // Aliases, so the rules and the report totals can read a detail record
  // without knowing which reader produced it.
  s.mcpCalls = s.mcpCounts;
  s.skills = Object.keys(s.skillCounts);
  s.toolCalls = s.toolCounts;
  return s;
}
