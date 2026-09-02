/**
 * Why the burn is happening, in one sentence.
 *
 * A threshold tells you *where you are*; it never tells you what to do. These
 * answer the second question, and exactly one of them is chosen each time — at
 * any moment several are true at once, and a notification carrying four of them
 * is a notification nobody reads.
 *
 * So every diagnosis has to be comparable to every other:
 *
 *   share       how much of the burn it explains, 0 to 1
 *   confidence  measured (1.0), derived (0.7), or inferred (0.4)
 *   leverage    how cheaply it can be acted on — a setting beats a habit
 *
 * `score = share × confidence × leverage`, highest wins. Leverage is what stops
 * this being a popularity contest: "your sessions run long" may explain more of
 * the burn than "four servers are idle", but one is a habit to change and the
 * other is four lines in a config file. At similar share, the ten-second fix
 * should win.
 *
 * Nothing here invents a number. A diagnosis with no figure to quote returns
 * null, because an explanation that cannot say how much is worse than no
 * explanation at all — it teaches people the middle sentence can be skipped.
 */

import { tokens, num, pct, mins, usd } from "./format.mjs";

/** Measured by the source, derived by us, or inferred from a proxy. */
export const CONFIDENCE = { measured: 1, derived: 0.7, inferred: 0.4 };

/** How cheap the fix is: a switch, a command, or a change of habit. */
export const LEVERAGE = { setting: 1, command: 0.8, habit: 0.55 };

const clamp01 = (n) => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);

/**
 * Servers whose definitions ride on every request and have not been called.
 *
 * The strongest of these when it applies: the cost is paid on *every* request
 * rather than once, and the fix is deleting lines from a config file.
 */
function idleServers(ctx) {
  const { configured = [], called = {}, sizes = null, daysSince = {}, baseline = null } = ctx.mcp ?? {};
  const idle = configured.filter((s) => !called[s]);
  if (!idle.length) return null;

  const measured = idle.map((n) => ({ name: n, tokens: sizes?.servers?.[n]?.tokens ?? null })).filter((m) => m.tokens);
  const total = measured.reduce((a, m) => a + m.tokens, 0);
  // Without measured sizes there is no number to quote, and "you have idle
  // servers" is not worth interrupting anyone for.
  if (!total || !baseline) return null;

  const stale = idle.map((n) => daysSince[n]).filter((d) => Number.isFinite(d));
  const longest = stale.length ? Math.max(...stale) : null;
  const named = measured.slice(0, 4).map((m) => m.name);

  return {
    id: "idle-mcp",
    share: clamp01(total / baseline),
    confidence: CONFIDENCE.measured,
    leverage: LEVERAGE.setting,
    line:
      `${measured.length} MCP server${measured.length === 1 ? "" : "s"}` +
      (longest !== null ? ` unused for ${longest} day${longest === 1 ? "" : "s"}` : " never called") +
      ` add ${tokens(total)} tokens per request: ${named.join(", ")}.`,
    action: "Detaching what you do not use is a straight saving on every request.",
  };
}

/** Work done inside subagents, which is spend that never shows in a prompt. */
function subagents(ctx) {
  const s = ctx.session;
  const spent = s?.sidechain?.cost ?? 0;
  if (!spent || !s.cost) return null;
  const share = clamp01(spent / s.cost);
  const tokenShare = ctx.sessionTokens ? clamp01((s.sidechain.tokens ?? 0) / ctx.sessionTokens) : share;
  return {
    id: "subagents",
    share,
    confidence: CONFIDENCE.measured,
    leverage: LEVERAGE.setting,
    line: `Subagents did ${pct(tokenShare)} of the work in this session, ${usd(spent)} of it.`,
    action: "Each subagent carries its own context. Fewer, or narrower, is the lever here.",
  };
}

/** Context re-sent on every turn — the honest version of "long session". */
function carriedHistory(ctx) {
  const s = ctx.session;
  const carried = s?.history?.last ?? 0;
  if (!carried || !s.assistantTurns) return null;
  // Cache reads bill at a tenth, but they are still most of a long session's
  // input, and they grow with every turn that is not reset.
  const share = clamp01(s.tokens.cacheRead / Math.max(1, s.tokens.cacheRead + s.tokens.output + s.tokens.input));
  if (carried < (ctx.historyFloor ?? 50_000)) return null;
  return {
    id: "carried-history",
    share,
    confidence: CONFIDENCE.derived,
    leverage: LEVERAGE.command,
    line: `Each turn re-sends ${tokens(carried)} tokens of history, over ${num(s.typedPrompts)} prompts${s.durationMins ? ` and ${mins(s.durationMins)}` : ""}.`,
    action: "Run /compact, or start a new session for the next distinct piece of work.",
  };
}

/** A premium model on a run of turns that produced almost nothing. */
function quietPremiumRun(ctx) {
  const s = ctx.session;
  const run = s?.longestQuietRun;
  if (!run?.model || !run.turns) return null;
  if (!(ctx.premium ?? []).some((p) => run.model.startsWith(p))) return null;
  if (run.turns < (ctx.quietRunFloor ?? 8)) return null;
  // What the run itself cost, at that model's own average for this session —
  // a derived figure, not the model's share of the whole, which would call 25
  // quiet turns out of 1,200 a crisis.
  const modelCost = s.models?.[run.model] ?? 0;
  const modelTurns = s.modelTurns?.[run.model] ?? 0;
  const runCost = modelTurns ? (modelCost / modelTurns) * run.turns : 0;
  return {
    id: "quiet-premium",
    share: clamp01(s.cost ? runCost / s.cost : 0),
    confidence: CONFIDENCE.derived,
    leverage: LEVERAGE.setting,
    line: `${run.model.replace(/^claude-/, "")} ran ${run.turns} turns in a row producing under ${tokens(run.outputCap)} tokens each, about ${usd(runCost)} of work.`,
    action: "Work that small usually runs well on Sonnet — escalate when it stalls.",
  };
}

/** Claude Code's own accounting, which beats anything we infer. */
function ownAttribution(ctx) {
  const w = ctx.attribution?.windows?.[ctx.attribution.windows.length - 1];
  const top = (w?.behaviours ?? []).slice().sort((a, b) => b.percent - a.percent)[0];
  if (!top) return null;
  return {
    id: "attributed",
    share: clamp01(top.percent / 100),
    confidence: CONFIDENCE.measured,
    // It names a habit rather than a switch, which is the honest weighting.
    leverage: LEVERAGE.habit,
    line: `Claude Code attributes ${top.percent}% of your recent usage to work that ${top.text.replace(/^of your usage\s*/i, "")}.`,
    action: /sessions?\s+active/i.test(top.text)
      ? "Starting a fresh session at each new piece of work is the single biggest lever."
      : "Large context is paid on every turn that carries it. /compact when the early part stops being relevant.",
  };
}

/** Calls that failed, and were therefore paid for twice. */
function failingTools(ctx) {
  const errs = ctx.session?.toolErrorsByName ?? ctx.toolErrorsByName ?? {};
  const calls = ctx.session?.toolCalls ?? ctx.toolCallsByName ?? {};
  const worst = Object.entries(errs)
    .map(([name, e]) => ({ name, errors: e, calls: calls[name] ?? e, rate: e / (calls[name] ?? e) }))
    .filter((t) => t.errors >= 3 && t.rate >= 0.5)
    .sort((a, b) => b.errors - a.errors)[0];
  if (!worst) return null;
  return {
    id: "failing-tools",
    // Small in tokens, but it is waste with a fix rather than a trade-off.
    share: clamp01(worst.errors / Math.max(1, Object.values(calls).reduce((a, c) => a + c, 0))) + 0.05,
    confidence: CONFIDENCE.measured,
    leverage: LEVERAGE.command,
    line: `${worst.name} failed ${worst.errors} of its ${worst.calls} calls.`,
    action: "A tool failing this often is a wrong path or a missing permission, not bad luck — and every failure is paid for twice.",
  };
}

export const DIAGNOSES = [idleServers, subagents, carriedHistory, quietPremiumRun, ownAttribution, failingTools];

/**
 * The single best explanation, or null when nothing clears the floor.
 *
 * A threshold nudge still fires without one — knowing you are at 75% is worth
 * saying on its own. It just goes out without a middle sentence rather than
 * with an invented one.
 */
export function bestDiagnosis(ctx, { floor = 0.08 } = {}) {
  const scored = [];
  for (const fn of DIAGNOSES) {
    let d = null;
    try {
      d = fn(ctx);
    } catch {
      continue; // one bad diagnosis must not cost the nudge
    }
    if (!d) continue;
    d.score = d.share * d.confidence * d.leverage;
    scored.push(d);
  }
  scored.sort((a, b) => b.score - a.score);
  return scored[0] && scored[0].score >= floor ? scored[0] : null;
}

/** Everything that applied, dearest first — for the report, not the popup. */
export function allDiagnoses(ctx) {
  return DIAGNOSES.map((fn) => {
    try {
      const d = fn(ctx);
      if (d) d.score = d.share * d.confidence * d.leverage;
      return d;
    } catch {
      return null;
    }
  })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
}
