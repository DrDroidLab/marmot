/**
 * The nudge rules.
 *
 * Every rule returns the same shape, and it is the same shape the rest of the
 * product uses: a count, what it was, what to do instead, and the sessions
 * behind it. A nudge you cannot trace to the sessions that caused it produces
 * suspicion rather than a change of habit.
 *
 * All rules are deterministic and local. No model is called to decide whether
 * to nudge you.
 */

import { configuredServers, byDay } from "./sessions.mjs";
import { usd, pct } from "./format.mjs";

const premiumCost = (s, cfg) =>
  Object.entries(s.models)
    .filter(([m]) => cfg.models.premium.some((p) => m.startsWith(p)))
    .reduce((a, [, c]) => a + c, 0);

/**
 * Documentation, tests or prose — matched on path *segments*, not substrings.
 * A raw `includes("test")` calls `.../tests/paths.py` a test file and anything
 * under `~/Documents/` a document, which is how this rule starts lying.
 */
const isLightPath = (p, cfg) => {
  const low = p.toLowerCase();
  if (cfg.models.lightWorkExtensions.some((e) => low.endsWith(e))) return true;
  const segments = low.split("/").filter(Boolean);
  const base = segments[segments.length - 1] ?? "";
  if (segments.slice(0, -1).some((seg) => cfg.models.lightWorkDirs.includes(seg))) return true;
  return cfg.models.lightWorkFilePatterns.some((rx) => new RegExp(rx).test(base));
};

/** Rules that judge one session on its own. */
export const sessionRules = [
  {
    id: "session-turns",
    label: "Long session without a reset",
    check(s, cfg) {
      if (s.typedPrompts <= cfg.session.turnCap) return null;
      if (cfg.session.turnCapRequiresNoCompaction && s.compactions > 0) return null;
      if (s.cost < cfg.session.costFloor) return null;
      return {
        detail: `${s.typedPrompts} prompts in one session with no context reset, costing ${usd(s.cost)}.`,
        action:
          "Long sessions carry every earlier turn into every later one. Start a fresh session for the next distinct task, or /compact to drop what is no longer relevant.",
      };
    },
  },
  {
    id: "session-cost",
    label: "Session past the cost cap",
    check(s, cfg) {
      if (s.cost <= cfg.session.costCap) return null;
      return {
        detail: `This session has reached ${usd(s.cost)} against a ${usd(cfg.session.costCap)} cap, over ${s.assistantTurns} model turns.`,
        action: "Worth a look at whether the remaining work needs this session's accumulated context, or a clean one.",
      };
    },
  },
  {
    id: "premium-light-work",
    label: "Premium model on light work",
    check(s, cfg) {
      if (s.cost < cfg.session.costFloor) return null;
      const share = s.cost ? premiumCost(s, cfg) / s.cost : 0;
      if (share < cfg.models.premiumShare) return null;
      // Size guard. `filesTouched` records what a session *edited*, never what
      // it read, so "only edited markdown" says nothing about a session that
      // read fifty source files first. A 900-tool-call session is not light
      // work whatever landed on disk at the end of it.
      if (s.totalToolCalls >= cfg.models.lightWorkMaxToolCalls) return null;
      const files = [...s.filesTouched];
      const lightByFiles = files.length > 0 && files.every((f) => isLightPath(f, cfg));
      const lightByTools = s.totalToolCalls < cfg.models.lightWorkToolCalls;
      if (!lightByFiles && !lightByTools) return null;
      const why = lightByFiles
        ? `every file it touched was documentation, tests or markdown (${files.length})`
        : `it made ${s.totalToolCalls} tool calls`;
      return {
        detail: `${pct(share)} of this session's ${usd(s.cost)} ran on a premium model, and ${why}.`,
        action: "Work this light usually runs well on Claude Sonnet 5 — escalate only when it stalls.",
      };
    },
  },
  {
    id: "cache-hit",
    label: "Low cache hit rate",
    check(s, cfg) {
      if (s.assistantTurns < cfg.cache.minTurns) return null;
      if (s.cacheHitRate === null || s.cacheHitRate >= cfg.cache.minHitRate) return null;
      return {
        detail: `Only ${pct(s.cacheHitRate)} of this session's input tokens were served from cache, across ${s.assistantTurns} turns.`,
        action:
          "A low hit rate usually means context is being rebuilt rather than continued — restarting instead of resuming, or a prompt whose opening changes every turn.",
      };
    },
  },
  {
    id: "tool-errors",
    label: "High tool error rate",
    check(s, cfg) {
      if (s.totalToolCalls < cfg.toolErrors.minCalls) return null;
      if (s.toolErrorRate <= cfg.toolErrors.maxRate) return null;
      return {
        detail: `${s.toolErrors} of ${s.totalToolCalls} tool calls failed (${pct(s.toolErrorRate)}).`,
        action: "Failed calls are paid for twice — once to fail, once to retry. Usually a wrong path, a missing binary, or a permission that keeps being denied.",
      };
    },
  },
];

/** Rules that need the whole window rather than one session. */
export function windowRules(sessions, cfg, { root, today = new Date().toISOString().slice(0, 10), includeMcp = true, configured: configuredOverride } = {}) {
  const out = [];
  const days = byDay(sessions);
  const todayRow = days.find((d) => d.day === today);

  if (todayRow && todayRow.cost > cfg.daily.costCap) {
    out.push({
      id: "daily-cost",
      label: "Day past the cost cap",
      detail: `${usd(todayRow.cost)} so far today across ${todayRow.sessions} session${todayRow.sessions === 1 ? "" : "s"}, against a ${usd(cfg.daily.costCap)} cap.`,
      action: "Nothing is wrong with a heavy day. This is the cap you set, saying you have reached it.",
      sessions: sessions.filter((s) => s.day === today).map((s) => s.id),
    });
  }

  // Against your own trailing average rather than a fixed number, because the
  // right absolute figure differs by an order of magnitude between engineers.
  const prior = days.filter((d) => d.day < today).slice(-cfg.daily.baselineDays);
  if (todayRow && prior.length >= cfg.daily.baselineMinDays && todayRow.cost >= cfg.daily.baselineMinCost) {
    const mean = prior.reduce((a, d) => a + d.cost, 0) / prior.length;
    const sd = Math.sqrt(prior.reduce((a, d) => a + (d.cost - mean) ** 2, 0) / prior.length);
    const bound = mean + cfg.daily.baselineSigma * sd;
    if (sd > 0 && todayRow.cost > bound) {
      out.push({
        id: "daily-baseline",
        label: "Well above your own baseline",
        detail: `${usd(todayRow.cost)} today against a ${prior.length}-day average of ${usd(mean)}. That is past ${cfg.daily.baselineSigma}σ.`,
        action: "Not a verdict — a heavy day is often a hard day. Worth knowing it is unlike your normal.",
        sessions: sessions.filter((s) => s.day === today).map((s) => s.id),
      });
    }
  }

  // Skipped when the caller passed lightweight records: an absent `mcpCalls`
  // would make every configured server look idle.
  if (cfg.mcp.enabled && includeMcp) {
    const configured = configuredOverride ?? configuredServers(root);
    const called = new Set(sessions.flatMap((s) => Object.keys(s.mcpCalls ?? {})));
    const idle = configured.filter((c) => !called.has(c));
    if (idle.length) {
      out.push({
        id: "mcp-idle",
        label: "MCP servers attached but never called",
        detail: `${idle.join(", ")} — configured, and not invoked once in this window.`,
        action: "Every attached server's tool definitions are sent with each request. Detaching what you do not use is a straight saving.",
        sessions: [],
      });
    }
  }

  return out;
}

/** Every nudge for a set of sessions, session-level rules grouped by rule. */
export function evaluate(sessions, cfg, opts = {}) {
  const grouped = new Map();
  for (const s of sessions) {
    for (const rule of sessionRules) {
      if (opts.only && !opts.only.includes(rule.id)) continue;
      const hit = rule.check(s, cfg);
      if (!hit) continue;
      const g = grouped.get(rule.id) ?? { id: rule.id, label: rule.label, hits: [] };
      g.hits.push({ session: s, ...hit });
      grouped.set(rule.id, g);
    }
  }
  // Window rules may need a wider set than the sessions being judged: the
  // digest reports on yesterday, but "this MCP server was never called" is only
  // true against the whole window.
  const wide = opts.windowSessions ?? sessions;
  const windows = opts.only
    ? windowRules(wide, cfg, opts).filter((w) => opts.only.includes(w.id))
    : windowRules(wide, cfg, opts);
  return { sessionNudges: [...grouped.values()], windowNudges: windows };
}
