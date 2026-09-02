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

/**
 * Every transcript on disk.
 *
 * A session's own file sits at `projects/<project>/<id>.jsonl`. What a subagent
 * did is **not in it** — it goes to `projects/<project>/<id>/subagents/*.jsonl`,
 * a directory deeper. Missing those means missing the spend entirely, which for
 * anyone leaning on subagents is most of the bill.
 */
export function* sessionFiles(root, { subagents = false } = {}) {
  const dir = join(root, "projects");
  if (!existsSync(dir)) return;
  for (const project of readdirSync(dir)) {
    let entries = [];
    try {
      entries = readdirSync(join(dir, project), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith(".jsonl")) {
        yield { project, path: join(dir, project, e.name), id: basename(e.name, ".jsonl") };
        continue;
      }
      if (!subagents || !e.isDirectory()) continue;
      const sub = join(dir, project, e.name, "subagents");
      if (!existsSync(sub)) continue;
      let agents = [];
      try {
        agents = readdirSync(sub);
      } catch {
        continue;
      }
      for (const f of agents) {
        if (!f.endsWith(".jsonl")) continue;
        // The directory is the session that spawned it, which is who pays.
        yield { project, path: join(sub, f), id: basename(f, ".jsonl"), parentId: e.name };
      }
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
  // tool_use id → tool name, so an error can be attributed to what failed.
  const toolNames = new Map();
  let quietRun = { model: null, turns: 0 };
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
    // What subagents cost, separately. A session where most of the spend
    // happened inside sidechains is a different problem from a long one.
    sidechain: { turns: 0, tokens: 0, cost: 0 },
    // The context carried into a turn — which is what "each turn re-sends 140K
    // of history" measures. `last` is where the session is now, `peak` the
    // worst it got.
    history: { last: 0, peak: 0 },
    // The longest run of consecutive turns on one model that produced almost
    // nothing. Whether that model was an expensive choice is for the rules to
    // say; the reader only measures the run.
    longestQuietRun: { model: null, turns: 0, outputCap: 1000 },
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
    toolErrorsByName: {},
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
      if (o.isSidechain) {
        s.sidechainTurns += 1;
        s.sidechain.turns += 1;
      }
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

      // Carried context is the cache read: everything the model was handed
      // again to answer this turn.
      const carried = readTok + inTok;
      s.history.last = carried;
      if (carried > s.history.peak) s.history.peak = carried;

      if (o.isSidechain) {
        s.sidechain.tokens += inTok + outTok + readTok + writeTok;
      }

      // A run is broken by a different model or by a turn that did real work.
      if (msg.model === quietRun.model && outTok < s.longestQuietRun.outputCap) quietRun.turns += 1;
      else quietRun = { model: msg.model ?? null, turns: outTok < s.longestQuietRun.outputCap ? 1 : 0 };
      if (quietRun.turns > s.longestQuietRun.turns) s.longestQuietRun = { ...s.longestQuietRun, ...quietRun };

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
        if (o.isSidechain) s.sidechain.cost += c;
      }
    }

    for (const b of msg.content ?? []) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "tool_use") {
        // Remembered so a failure arriving later can be blamed on the right
        // tool: "3% failed" does not tell you which one to fix.
        if (b.id) toolNames.set(b.id, b.name);
        s.toolCalls[b.name] = (s.toolCalls[b.name] ?? 0) + 1;
        s.totalToolCalls += 1;
        if (b.name === "Skill" && b.input?.skill) s.skills.add(b.input.skill);
        if (/^mcp__/.test(b.name)) {
          const server = b.name.split("__")[1];
          if (server) s.mcpCalls[server] = (s.mcpCalls[server] ?? 0) + 1;
        }
      }
      if (b.type === "tool_result" && b.is_error) {
        s.toolErrors += 1;
        const name = toolNames.get(b.tool_use_id);
        if (name) s.toolErrorsByName[name] = (s.toolErrorsByName[name] ?? 0) + 1;
      }
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
  const byId = new Map();
  const agents = [];

  for (const f of sessionFiles(root, { subagents: true })) {
    try {
      if (statSync(f.path).mtime < since) continue;
    } catch {
      continue;
    }
    const s = readSession(f, { rateOverrides });
    if (!s) continue;
    if (f.parentId) {
      agents.push({ parentId: f.parentId, s });
      continue;
    }
    byId.set(s.id, s);
    out.push(s);
  }

  // A subagent's spend belongs to the session that spawned it: it is that
  // session's cost, and it is *also* what makes it a subagent-heavy session.
  for (const { parentId, s } of agents) {
    const parent = byId.get(parentId);
    if (!parent) continue;
    parent.cost += s.cost;
    parent.assistantTurns += s.assistantTurns;
    parent.pricedTurns += s.pricedTurns;
    parent.totalToolCalls += s.totalToolCalls;
    parent.toolErrors += s.toolErrors;
    for (const k of ["input", "output", "cacheRead", "cacheWrite", "thinking"]) parent.tokens[k] += s.tokens[k];
    for (const [m, c] of Object.entries(s.models)) parent.models[m] = (parent.models[m] ?? 0) + c;
    for (const [m, t] of Object.entries(s.modelTokens)) {
      const into = (parent.modelTokens[m] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
      for (const k of Object.keys(into)) into[k] += t[k] ?? 0;
    }
    for (const [n, c] of Object.entries(s.toolCalls)) parent.toolCalls[n] = (parent.toolCalls[n] ?? 0) + c;
    for (const [n, c] of Object.entries(s.toolErrorsByName)) parent.toolErrorsByName[n] = (parent.toolErrorsByName[n] ?? 0) + c;
    for (const [srv, n] of Object.entries(s.mcpCalls)) parent.mcpCalls[srv] = (parent.mcpCalls[srv] ?? 0) + n;
    for (const k of s.skills) parent.skills.add(k);

    parent.sidechainTurns += s.assistantTurns;
    parent.sidechain.turns += s.assistantTurns;
    parent.sidechain.cost += s.cost;
    parent.sidechain.tokens += s.tokens.input + s.tokens.output + s.tokens.cacheRead + s.tokens.cacheWrite;
  }
  for (const s of out) {
    s.toolErrorRate = s.totalToolCalls ? s.toolErrors / s.totalToolCalls : 0;
    const seen = s.tokens.cacheRead + s.tokens.cacheWrite + s.tokens.input;
    s.cacheHitRate = seen ? s.tokens.cacheRead / seen : null;
  }

  return out.sort((a, b) => (a.endedAt < b.endedAt ? 1 : -1));
}

/** When each MCP server was last actually called, as a day string. */
export function mcpLastUsed(sessions = []) {
  const last = {};
  for (const s of sessions) {
    for (const srv of Object.keys(s.mcpCalls ?? {})) {
      if (!last[srv] || s.day > last[srv]) last[srv] = s.day;
    }
  }
  return last;
}

/** Whole days since each server was last called, from a `mcpLastUsed` map. */
export function daysSince(lastUsed, now = Date.now()) {
  const out = {};
  for (const [srv, day] of Object.entries(lastUsed)) {
    const t = Date.parse(`${day}T00:00:00Z`);
    if (Number.isFinite(t)) out[srv] = Math.max(0, Math.floor((now - t) / 86_400_000));
  }
  return out;
}

/**
 * MCP servers this machine is configured to attach, called or not. Discovery
 * lives in `mcp.mjs` so the nudge and `marmot mcp-audit` always agree on which
 * servers exist.
 */
export function configuredServers(root = defaultRoot(), cwds = null) {
  return Object.keys(readServerConfigs(root, cwds));
}

/** Every working directory the window's sessions ran in, newest first. */
export const sessionDirs = (sessions = []) => [...new Set(sessions.map((s) => s.cwd).filter(Boolean))];

/**
 * One row per working directory, dearest first.
 *
 * Each directory is its own Claude Code setup — its own MCP servers, its own
 * project skills, often its own habits. The nudges are deliberately computed
 * across all of them, because a limit is spent from one pool whichever repo
 * emptied it.
 */
export function byProject(sessions, { servers = {} } = {}) {
  const rows = {};
  for (const s of sessions) {
    const dir = s.cwd ?? "(unknown)";
    const r = (rows[dir] ??= { dir, cost: 0, sessions: 0, prompts: 0, turns: 0, tokens: 0, scoped: [] });
    r.cost += s.cost;
    r.sessions += 1;
    r.prompts += s.typedPrompts;
    r.turns += s.assistantTurns;
    r.tokens += s.tokens.input + s.tokens.output + s.tokens.cacheRead + s.tokens.cacheWrite;
  }
  // Servers attached only for this directory, which is the part of a setup that
  // is invisible from anywhere else.
  for (const [name, cfg] of Object.entries(servers)) {
    if (cfg?._scope && cfg._scope !== "global" && rows[cfg._scope]) rows[cfg._scope].scoped.push(name);
  }
  return Object.values(rows).sort((a, b) => b.cost - a.cost);
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
