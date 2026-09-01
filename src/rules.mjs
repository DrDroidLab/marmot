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
import { usd, pct, num, tokens, mins } from "./format.mjs";
import { paysPerToken, usableLimits, limitPace } from "./plan.mjs";

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

/**
 * Whether an absolute dollar cap means anything on this plan.
 *
 * On a subscription the money is already spent, so "$511 today against a $50
 * cap" is not overspending — it is a Tuesday, and a rule that says otherwise
 * every single day gets muted along with the ones worth reading. Absolute
 * dollar caps apply to pay-as-you-go, and to an unknown plan, where the figure
 * really is the bill. Everything else on a subscription is judged against your
 * own normal or against the plan's own limits.
 */
const dollarsAreBilled = (plan) => !plan?.plan || paysPerToken(plan.plan);

/**
 * The areas of the tree a session worked in, oldest first.
 *
 * Three things this has to get right, each found by reading real output:
 * work outside the working directory (scratch files in /private/tmp, a stray
 * edit in another repo) is noise rather than an area; `backend` and
 * `backend/app` are one strand of work, not two; and an area touched once is a
 * passing glance. Without all three the rule reports six "separate" areas for a
 * session that only ever worked on one.
 */
export function areasOf(s, cfg) {
  const cwd = s.cwd;
  if (!cwd) return []; // nothing to measure paths against
  const groups = new Map();
  for (const d of Object.values(s.dirTouches ?? {})) {
    // `trackingPath` is written relative to the working directory. An absolute
    // one means the edit landed outside the repo — a scratch file, another
    // checkout — which is noise rather than an area of this session's work.
    let rel;
    if (d.dir.startsWith("/")) {
      if (!d.dir.startsWith(cwd)) continue;
      rel = d.dir.slice(cwd.length);
    } else {
      rel = d.dir;
    }
    rel = rel.replace(/^\/+/, "");
    const area = rel.split("/").filter(Boolean).slice(0, cfg.session.topicDepth).join("/") || ".";
    const g = groups.get(area) ?? { area, count: 0, firstTurn: Infinity, lastTurn: -Infinity };
    g.count += d.count;
    g.firstTurn = Math.min(g.firstTurn, d.firstTurn);
    g.lastTurn = Math.max(g.lastTurn, d.lastTurn);
    groups.set(area, g);
  }

  // Fold a nested area into its parent: editing backend/app is still backend.
  for (const [name, g] of [...groups]) {
    const parent = [...groups.keys()].find((k) => k !== name && name.startsWith(`${k}/`));
    if (!parent) continue;
    const p = groups.get(parent);
    p.count += g.count;
    p.firstTurn = Math.min(p.firstTurn, g.firstTurn);
    p.lastTurn = Math.max(p.lastTurn, g.lastTurn);
    groups.delete(name);
  }

  return [...groups.values()].sort((a, b) => a.firstTurn - b.firstTurn);
}

/**
 * The marks to speak at, for this plan. Per-plan first, then the shared
 * default, and always sorted so "the highest one passed" means what it says.
 */
export function limitSteps(cfg, plan) {
  const byPlan = cfg.limits?.byPlan ?? {};
  const chosen = plan && Object.prototype.hasOwnProperty.call(byPlan, plan) ? byPlan[plan] : cfg.limits?.steps;
  return (Array.isArray(chosen) ? chosen : [])
    .filter((n) => typeof n === "number" && n > 0)
    .sort((a, b) => a - b);
}

/** "in 2.1h", or "shortly", without pretending to more precision than we have. */
function resetWording(iso) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "soon";
  const m = (at - Date.now()) / 60_000;
  return m <= 0 ? "shortly" : `in ${mins(m)}`;
}

/** The longest pause between two prompts you typed, in minutes. */
export function longestGapMins(times = []) {
  let max = 0;
  for (let i = 1; i < times.length; i += 1) {
    const gap = (new Date(times[i]) - new Date(times[i - 1])) / 60000;
    if (Number.isFinite(gap) && gap > max) max = gap;
  }
  return max;
}

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
    check(s, cfg, ctx = {}) {
      if (!dollarsAreBilled(ctx.plan)) return null;
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
    id: "session-topics",
    label: "One session, resumed across days",
    check(s, cfg) {
      if (s.cost < cfg.session.costFloor) return null;
      if (s.typedPrompts < cfg.session.topicMinPrompts) return null;
      // A session that compacted has already dropped what it no longer needs.
      if (s.compactions > 0) return null;

      // The signal that actually holds on real sessions. Sequencing does not:
      // people work across a tree at once, so backend and frontend edited in
      // step is one task, not two. A long gap is different — you came back to
      // a context built for something you had already finished.
      const gap = longestGapMins(s.promptTimes);
      if (gap < cfg.session.topicGapMins) return null;

      const areas = areasOf(s, cfg).filter((a) => a.count >= cfg.session.topicMinTouches);
      if (areas.length < cfg.session.topicMinAreas) return null;

      const listed = areas.slice(0, 4).map((a) => a.area).join(", ");
      return {
        detail: `${s.typedPrompts} prompts and ${usd(s.cost)} in one session, with a ${mins(gap)} gap between prompts and work in ${areas.length} areas: ${listed}.`,
        action:
          "Everything from before the gap is still in context after it, and paid for on every turn since. When you come back to a different piece of work, a fresh session costs nothing to start.",
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
export function windowRules(sessions, cfg, { root, today = new Date().toISOString().slice(0, 10), includeMcp = true, configured: configuredOverride, mcpSizes = null, cwd = null, plan = null, attribution = null } = {}) {
  const out = [];
  const days = byDay(sessions);
  const todayRow = days.find((d) => d.day === today);

  if (todayRow && dollarsAreBilled(plan) && todayRow.cost > cfg.daily.costCap) {
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

  // Your plan's own limits. On a subscription this is the number that actually
  // bites — you have already paid the money, and what runs out is allowance.
  if (cfg.limits?.enabled && plan?.limits?.length) {
    const steps = limitSteps(cfg, plan.plan);
    // Only windows that are still the window they were measured in. A reading
    // whose window has reset says nothing about the one you are in now.
    for (const l of usableLimits(plan)) {
      // The highest mark this window has passed. Each speaks once, so 91% says
      // "90%" rather than repeating what 76% already said.
      const crossed = steps.filter((n) => l.percent >= n).sort((a, b) => b - a)[0];
      if (crossed === undefined) continue;
      const age = plan.ageMins !== null && plan.ageMins > (cfg.limits.staleAfterMins ?? 60) ? ` as of ${mins(plan.ageMins)} ago` : "";
      const resets = l.resetsAt ? ` It resets ${resetWording(l.resetsAt)}.` : "";
      out.push({
        id: "limit-reached",
        // Keyed by the mark, so crossing the next one is news and re-reading
        // the same one is not.
        key: `limit-reached:${l.kind}:${crossed}`,
        label: `${l.label === "weekly" ? "Weekly" : "Session"} limit ${l.percent}% used`,
        detail: `${l.percent}% of your ${l.label} limit is gone${age}${plan.plan ? ` on ${plan.plan}` : ""}.${resets}`,
        action:
          l.kind === "session"
            ? "The 5-hour window refills on its own. Heavy context is what fills it fastest, so a fresh session or a /compact buys back more than working slower does."
            : "Worth knowing before the week is out. The cheapest savings are usually idle MCP servers and sessions carrying context they finished with.",
        sessions: [],
      });
    }
  }

  // Burning a window faster than it passes. A percentage alone cannot tell you
  // whether it is a problem — 78% is fine on the last day of the week and
  // alarming on the first.
  if (cfg.limits?.enabled && plan?.limits?.length) {
    for (const l of usableLimits(plan)) {
      const p = limitPace(l);
      if (!p || !p.exhaustsBeforeReset) continue;
      if (p.pace < cfg.limits.paceRatio) continue;
      if (p.elapsedPct < cfg.limits.paceMinElapsed) continue;
      if (l.percent < cfg.limits.paceMinUsed) continue;
      out.push({
        id: "limit-pace",
        key: `limit-pace:${l.kind}:${Math.floor(p.pace * 2) / 2}`,
        label: `Spending your ${l.label} allowance faster than it refills`,
        detail: `${Math.round(p.elapsedPct)}% through the ${l.label} window with ${l.percent}% of it gone — ${p.pace.toFixed(1)}× the pace that would last. At this rate it runs out in about ${mins(p.exhaustsInMs / 60_000)}, ${mins((p.remainingMs - p.exhaustsInMs) / 60_000)} before it resets.`,
        action:
          "The levers, biggest first: detach MCP servers you are not calling, start a fresh session rather than carrying context you have finished with, and drop to Sonnet for work that does not need more.",
        sessions: [],
      });
    }
  }

  // Claude Code's own accounting of what is eating your limits. Quoting the
  // source beats inferring it, and it names the two habits Marmot can only
  // guess at from transcripts: very long sessions, and very large context.
  if (cfg.limits?.enabled && attribution?.windows?.length) {
    const w = attribution.windows[attribution.windows.length - 1]; // the widest window
    const loud = (w.behaviours ?? []).filter((b) => b.percent >= (cfg.limits.driverMinPercent ?? 60));
    for (const b of loud) {
      const long = /sessions?\s+active/i.test(b.text);
      out.push({
        id: "limit-drivers",
        key: `limit-drivers:${w.label}:${b.text.slice(0, 24)}:${Math.floor(b.percent / 10) * 10}`,
        label: "What is actually eating your limits",
        detail: `Claude Code attributes ${b.percent}% of your usage over the ${w.label.replace(/^Last\s+/i, "last ")} to usage that ${b.text.replace(/^of your usage\s*/i, "")}. That is across ${num(w.requests)} requests${w.sessions ? ` in ${w.sessions} sessions` : ""}.`,
        action: long
          ? "Sessions that stay open carry every earlier turn into every later one. Starting a fresh session at each new piece of work is the single biggest lever here."
          : "Large context is paid on every turn that carries it. /compact when the early part of a session stops being relevant, and detach MCP servers you are not calling.",
        sessions: [],
      });
    }
  }

  // A habit, rather than one session. The per-session rule already names each
  // one; this says the pattern out loud, with what it added up to.
  const lightPremium = sessions.filter((s) => {
    if (!s.models || s.cost < cfg.session.costFloor) return null;
    const share = s.cost ? premiumCost(s, cfg) / s.cost : 0;
    return share >= cfg.models.premiumShare && s.totalToolCalls < cfg.models.lightWorkToolCalls;
  });
  if (lightPremium.length >= cfg.models.lightWorkMinSessions) {
    const spend = lightPremium.reduce((a, s) => a + s.cost, 0);
    out.push({
      id: "premium-window",
      label: "A habit of premium models on small sessions",
      detail: `${lightPremium.length} of ${sessions.length} sessions ran on a premium model while making fewer than ${cfg.models.lightWorkToolCalls} tool calls each, ${usd(spend)} in total.`,
      action:
        "One light session on the best model is a choice; a standing habit is worth a default. Claude Sonnet 5 handles work this size, and you can escalate the moment it stalls.",
      sessions: lightPremium.map((s) => s.id),
    });
  }

  // Skipped when the caller passed lightweight records: an absent `mcpCalls`
  // would make every configured server look idle.
  if (cfg.mcp.enabled && includeMcp) {
    const configured = configuredOverride ?? configuredServers(root, cwd);
    const called = new Set(sessions.flatMap((s) => Object.keys(s.mcpCalls ?? {})));
    const idle = configured.filter((c) => !called.has(c));
    if (idle.length) {
      // `marmot mcp-audit` measures what each server's definitions cost. If it
      // has been run, quote the real figure rather than gesturing at it.
      const measured = idle.map((n) => mcpSizes?.servers?.[n]).filter((m) => m && !m.error && m.tokens);
      const idleTokens = measured.reduce((a, m) => a + m.tokens, 0);
      const baselines = sessions.map((s) => s.baselineTokens).filter((n) => typeof n === "number");
      const baseline = baselines.length ? baselines.sort((a, b) => a - b)[Math.floor(baselines.length / 2)] : null;

      let detail = `${idle.join(", ")} — configured, and not invoked once in this window.`;
      if (idleTokens) {
        detail += ` Their tool definitions are ~${num(idleTokens)} tokens, sent with every request`;
        detail += baseline ? ` — ${pct(idleTokens / baseline)} of your ${tokens(baseline)} median session prefix.` : ".";
      } else if (baseline) {
        detail += ` Your median session carries ${tokens(baseline)} of prefix before you type; every attached server's definitions ride inside it.`;
      }

      out.push({
        id: "mcp-idle",
        label: "MCP servers attached but never called",
        detail,
        action: idleTokens
          ? "Detaching what you do not use is a straight saving on every request."
          : "Every attached server's tool definitions are sent with each request. `marmot mcp-audit` measures exactly what each one costs.",
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
      const hit = rule.check(s, cfg, opts);
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
