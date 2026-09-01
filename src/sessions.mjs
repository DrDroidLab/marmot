/**
 * Reads the session records Claude Code already writes to disk.
 *
 * Every session appends to `~/.claude/projects/<slug>/<session-id>.jsonl` as it
 * runs. Nothing here uploads, and nothing here reads prompt or response text —
 * only counts, identifiers and tool names.
 *
 * The format is internal and undocumented, so every field access is defensive:
 * a malformed line is skipped, an unknown shape degrades to a partial session
 * rather than throwing. A version of Claude Code that renames a field should
 * cost you a metric, not the report.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { turnCost } from "./pricing.mjs";
import { readServerConfigs } from "./mcp.mjs";

export const defaultRoot = () => join(homedir(), ".claude");

export function* sessionFiles(root) {
  const dir = join(root, "projects");
  if (!existsSync(dir)) return;
  for (const project of readdirSync(dir)) {
    let entries = [];
    try {
      entries = readdirSync(join(dir, project));
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith(".jsonl")) continue;
      yield { project, path: join(dir, project, f), id: basename(f, ".jsonl") };
    }
  }
}

/**
 * A human turn is a prompt the developer actually typed.
 *
 * This is the metric the turn nudge is built on, and getting it wrong makes the
 * nudge meaningless: tool results come back as `type: "user"` entries too, so
 * counting every user entry inflates a 62-prompt session to 1,191. Claude Code
 * tags real prompts with `promptSource: "typed"`; `"system"` is task
 * notifications and reminders, and an absent value is a compaction
 * continuation. Older transcripts predate the field, so fall back to the shape.
 */
export function isTypedPrompt(o, fileHasPromptSource) {
  if (o.type !== "user" || o.isMeta) return false;
  if (fileHasPromptSource) return o.promptSource === "typed";
  const c = o.message?.content;
  return !(Array.isArray(c) && c.some((b) => b?.type === "tool_result"));
}

export function readSession({ path, id, project }, { rateOverrides } = {}) {
  let mtime;
  try {
    mtime = statSync(path).mtime.toISOString();
  } catch {
    return null;
  }

  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }

  const lines = [];
  let fileHasPromptSource = false;
  // Claude Code writes one JSONL entry per content block — a thinking block, the
  // text, then each tool_use — and every one of those entries repeats the same
  // `message.usage`. Counting them all inflates cost and turns by ~1.9x on a
  // tool-heavy session. Usage is counted once per `message.id`; content blocks
  // are still counted per entry, because each entry carries a different one.
  const countedUsage = new Set();
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

  const s = {
    id,
    project,
    path,
    mtime,
    startedAt: null,
    endedAt: null,
    cwd: null,
    gitBranch: null,
    version: null,
    typedPrompts: 0,
    assistantTurns: 0,
    sidechainTurns: 0,
    compactions: 0,
    models: {},
    modelTurns: {},
    modelTokens: {},
    // The prefix carried into the first request: system prompt, CLAUDE.md,
    // every skill description and every attached tool definition. It is what
    // you pay before typing anything, and it rides on every later turn.
    baselineTokens: null,
    // Ordered enough to tell whether a long session stayed on one thing.
    dirTouches: {},
    promptTimes: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
    cost: 0,
    pricedTurns: 0,
    unpricedModels: new Set(),
    toolCalls: {},
    totalToolCalls: 0,
    toolErrors: 0,
    skills: new Set(),
    mcpCalls: {},
    permissionModes: new Set(),
    filesTouched: new Set(),
  };

  for (const o of lines) {
    if (o.timestamp) {
      if (!s.startedAt || o.timestamp < s.startedAt) s.startedAt = o.timestamp;
      if (!s.endedAt || o.timestamp > s.endedAt) s.endedAt = o.timestamp;
    }
    s.cwd ??= o.cwd ?? null;
    s.gitBranch ??= o.gitBranch ?? null;
    s.version ??= o.version ?? null;
    if (o.permissionMode) s.permissionModes.add(o.permissionMode);
    if (o.trackingPath) {
      s.filesTouched.add(o.trackingPath);
      // Which area of the tree, and when — the raw material for judging whether
      // one long session was really several.
      const dir = o.trackingPath.split("/").slice(0, -1).join("/") || "/";
      const d = (s.dirTouches[dir] ??= { dir, count: 0, firstTurn: s.assistantTurns, lastTurn: s.assistantTurns });
      d.count += 1;
      d.lastTurn = s.assistantTurns;
    }
    if (o.isCompactSummary || o.subtype === "compact_boundary") s.compactions += 1;
    if (isTypedPrompt(o, fileHasPromptSource)) {
      s.typedPrompts += 1;
      if (o.timestamp) s.promptTimes.push(o.timestamp);
    }

    const msg = o.message;
    if (!msg) continue;

    const usageKey = msg.id ?? o.requestId ?? null;
    const firstForResponse = usageKey === null || !countedUsage.has(usageKey);
    if (o.type === "assistant" && msg.usage && firstForResponse) {
      if (usageKey !== null) countedUsage.add(usageKey);
      const u = msg.usage;
      s.assistantTurns += 1;
      if (o.isSidechain) s.sidechainTurns += 1;
      if (msg.model) s.modelTurns[msg.model] = (s.modelTurns[msg.model] ?? 0) + 1;

      const cc = u.cache_creation ?? {};
      const inTok = u.input_tokens ?? 0;
      const outTok = u.output_tokens ?? 0;
      const readTok = u.cache_read_input_tokens ?? 0;
      const writeTok = u.cache_creation_input_tokens ?? (cc.ephemeral_1h_input_tokens ?? 0) + (cc.ephemeral_5m_input_tokens ?? 0);
      s.tokens.input += inTok;
      s.tokens.output += outTok;
      s.tokens.cacheRead += readTok;
      s.tokens.cacheWrite += writeTok;
      s.tokens.thinking += u.output_tokens_details?.thinking_tokens ?? 0;

      if (msg.model) {
        const mt = (s.modelTokens[msg.model] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
        mt.input += inTok;
        mt.output += outTok;
        mt.cacheRead += readTok;
        mt.cacheWrite += writeTok;
        mt.total += inTok + outTok + readTok + writeTok;
      }

      // First priced turn only: everything the model was sent before the
      // conversation itself. On a resumed session this carries earlier turns
      // too, which is why it is reported as a floor rather than an exact split.
      if (s.baselineTokens === null && !o.isSidechain) s.baselineTokens = inTok + readTok + writeTok;

      const c = turnCost(u, msg.model, rateOverrides);
      if (c === null) {
        // `<synthetic>` turns are locally generated, never billed.
        if (msg.model && msg.model !== "<synthetic>") s.unpricedModels.add(msg.model);
      } else {
        s.pricedTurns += 1;
        s.cost += c;
        s.models[msg.model] = (s.models[msg.model] ?? 0) + c;
      }
    }

    for (const b of msg.content ?? []) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "tool_use") {
        s.toolCalls[b.name] = (s.toolCalls[b.name] ?? 0) + 1;
        s.totalToolCalls += 1;
        if (b.name === "Skill" && b.input?.skill) s.skills.add(b.input.skill);
        if (/^mcp__/.test(b.name)) {
          const server = b.name.split("__")[1];
          if (server) s.mcpCalls[server] = (s.mcpCalls[server] ?? 0) + 1;
        }
      }
      if (b.type === "tool_result" && b.is_error) s.toolErrors += 1;
    }
  }

  s.startedAt ??= mtime;
  s.endedAt ??= mtime;
  s.day = s.endedAt.slice(0, 10);
  s.durationMins = (new Date(s.endedAt) - new Date(s.startedAt)) / 60000;
  s.cacheHitRate = (() => {
    const seen = s.tokens.cacheRead + s.tokens.cacheWrite + s.tokens.input;
    return seen ? s.tokens.cacheRead / seen : null;
  })();
  s.toolErrorRate = s.totalToolCalls ? s.toolErrors / s.totalToolCalls : 0;
  return s;
}

/**
 * Every session touched in the window. Filters on file mtime before parsing,
 * so a long history stays cheap to scan.
 */
export function loadSessions({ root = defaultRoot(), days = 30, rateOverrides } = {}) {
  const since = new Date(Date.now() - days * 86_400_000);
  const out = [];
  for (const f of sessionFiles(root)) {
    try {
      if (statSync(f.path).mtime < since) continue;
    } catch {
      continue;
    }
    const s = readSession(f, { rateOverrides });
    if (s) out.push(s);
  }
  return out.sort((a, b) => (a.endedAt < b.endedAt ? 1 : -1));
}

/**
 * MCP servers this machine is configured to attach, called or not. Discovery
 * lives in `mcp.mjs` so the nudge and `marmot mcp-audit` always agree on which
 * servers exist.
 */
export function configuredServers(root = defaultRoot(), cwd = null) {
  return Object.keys(readServerConfigs(root, cwd));
}

/** Spend per calendar day, oldest first. */
export function byDay(sessions) {
  const days = {};
  for (const s of sessions) {
    const d = (days[s.day] ??= { day: s.day, cost: 0, sessions: 0, prompts: 0, turns: 0 });
    d.cost += s.cost;
    d.sessions += 1;
    d.prompts += s.typedPrompts;
    d.turns += s.assistantTurns;
  }
  return Object.values(days).sort((a, b) => a.day.localeCompare(b.day));
}
