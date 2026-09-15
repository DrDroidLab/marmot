/**
 * What the menu bar app shows, and what it should say out loud.
 *
 * Two payloads, both plain JSON, so the app never re-implements a reader or a
 * rule — Swift draws, this decides:
 *
 *   buildStatus  everything the dropdown needs, read-only and cheap enough to
 *                run every minute. It never refreshes the limit snapshot (that
 *                is `claude -p /usage`, ~20s) and never starts an MCP server —
 *                it quotes the saved audit if there is one.
 *   tick         the nudges that became true since the last tick, marked fired
 *                in the same state file the hooks use, so a limit mark crossed
 *                between turns is said once whichever of the two notices it.
 *
 * Numbers mean exactly what they mean in `marmot report`: the same readers,
 * the same `totals()`, the same rules and diagnoses.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadSessions, configuredServers, sessionDirs, mcpLastUsed, daysSince } from "./sessions.mjs";
import { readPlan, usableLimits, limitPace, readAttribution, paysPerToken } from "./plan.mjs";
import { evaluate, windowRules } from "./rules.mjs";
import { allDiagnoses } from "./diagnose.mjs";
import { totals } from "./render.mjs";
import { readLog, append as logAppend, hookWiring, hooksMissing } from "./hooklog.mjs";
import { readAudit } from "./mcp.mjs";
import { readState, writeState, shouldFire, markFired, withinQuietPeriod, markNudged } from "./state.mjs";
import { drainInbox, writeHeartbeat } from "./inbox.mjs";
import { mins } from "./format.mjs";

const tokenSum = (s) => s.tokens.input + s.tokens.output + s.tokens.cacheRead + s.tokens.cacheWrite;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/** One entry per day of the window, oldest first, zero where nothing ran. */
export function dailySeries(sessions, days, now = Date.now()) {
  const by = new Map();
  for (const s of sessions) {
    const d = by.get(s.day) ?? { cost: 0, tokens: 0 };
    d.cost += s.cost;
    d.tokens += tokenSum(s);
    by.set(s.day, d);
  }
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = dayOf(now - i * 86_400_000);
    const d = by.get(day) ?? { cost: 0, tokens: 0 };
    out.push({ day, cost: d.cost, tokens: d.tokens });
  }
  return out;
}

function limitRows(plan, now) {
  const usable = new Set(usableLimits(plan));
  return (plan?.limits ?? []).map((l) => {
    const p = limitPace(l, now);
    return {
      kind: l.kind,
      label: l.label,
      percent: l.percent,
      resetsAt: l.resetsAt,
      expired: l.expired,
      usable: usable.has(l),
      pace: p
        ? {
            pace: p.pace,
            elapsedPct: p.elapsedPct,
            exhaustsBeforeReset: p.exhaustsBeforeReset,
            exhaustsInMins: p.exhaustsInMs === null ? null : p.exhaustsInMs / 60_000,
          }
        : null,
    };
  });
}

/** The same context `marmot report` gives the diagnoses, for one session. */
function diagnoseContext(session, sessions, cfg, { attribution, configured, sizes }) {
  const called = {};
  for (const s of sessions) for (const [srv, n] of Object.entries(s.mcpCalls ?? {})) called[srv] = (called[srv] ?? 0) + n;
  const baselines = sessions.map((s) => s.baselineTokens).filter((n) => typeof n === "number").sort((a, b) => a - b);
  return {
    session,
    sessionTokens: session ? tokenSum(session) : 0,
    premium: cfg.models.premium,
    attribution,
    mcp: {
      configured,
      called,
      sizes,
      daysSince: daysSince(mcpLastUsed(sessions)),
      baseline: baselines.length ? baselines[Math.floor(baselines.length / 2)] : null,
    },
  };
}

/** What to do about a Claude Code attribution line, by what it names. */
function attributionAction(text) {
  if (/sessions?\s+active/i.test(text)) return "Starting a fresh session at each new piece of work is the single biggest lever.";
  if (/context/i.test(text)) return "Large context is paid on every turn that carries it. /compact when the early part stops being relevant.";
  if (/subagent/i.test(text)) return "Each subagent carries its own context. Fewer, or narrower, is the lever here.";
  return "Worth a look in `marmot` for where it comes from.";
}

/**
 * The advice worth a line in the menu, best first.
 *
 * The diagnoses, scored exactly as the report scores them, plus every behaviour
 * Claude Code's own `/usage` attributes — the menu has room for more than the
 * one a notification can carry, and quoting the source beats inferring it.
 */
export function recommendations(ctx, attribution, { limit = 10 } = {}) {
  const out = allDiagnoses(ctx)
    .filter((d) => d.id !== "attributed")
    .map((d) => ({ id: d.id, line: d.line, action: d.action, score: d.score, source: "diagnosis" }));
  const w = attribution?.windows?.[attribution.windows.length - 1];
  for (const [i, b] of (w?.behaviours ?? []).entries()) {
    const text = b.text.replace(/^of your usage\s*/i, "");
    out.push({
      id: `claude-code:${i}`,
      line: `${b.percent}% of your usage ${text} (${w.label.toLowerCase()})`,
      action: attributionAction(text),
      score: (b.percent / 100) * 0.55,
      source: "claude-code",
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

function pluginEnabled(root) {
  try {
    const s = JSON.parse(readFileSync(join(root, "settings.json"), "utf8"));
    return Object.entries(s.enabledPlugins ?? {}).some(([k, v]) => v === true && k.startsWith("marmot@"));
  } catch {
    return false;
  }
}

/** Everything the dropdown and the settings window read. */
export function buildStatus({ root, cfg, days = 30, now = Date.now(), sessions = null, plan = null, demo = false }) {
  const all = sessions ?? loadSessions({ root, days, rateOverrides: cfg.rateOverrides });
  const p = plan ?? readPlan(root, { now });
  const attribution = demo ? null : readAttribution(root);
  const t = totals(all);
  const today = dayOf(now);
  const todays = all.filter((s) => s.day === today);

  const dirs = demo ? [] : sessionDirs(all);
  const configured = demo ? [] : configuredServers(root, dirs);
  const sizes = demo ? null : readAudit(root);
  // The session in front of you, when it is big enough to say anything about;
  // otherwise the dearest in the window, which is what the report explains.
  const recent = all[0] && all[0].cost >= (cfg.session?.costFloor ?? 1) ? all[0] : all.slice().sort((a, b) => b.cost - a.cost)[0] ?? null;
  const ctx = diagnoseContext(recent, all, cfg, { attribution, configured, sizes });

  const nudges = evaluate(all, cfg, { root, plan: p, attribution, diagnose: ctx, configured, mcpSizes: sizes });
  const standing = [
    ...nudges.windowNudges.map((n) => ({ id: n.id, key: n.key ?? n.id, label: n.label, detail: n.detail, action: n.action, urgent: n.urgent === true })),
    ...nudges.sessionNudges.map((g) => ({
      id: g.id,
      key: g.id,
      label: `${g.label} · ${g.hits.length} session${g.hits.length === 1 ? "" : "s"}`,
      detail: g.hits[0]?.detail ?? "",
      action: g.hits[0]?.action ?? "",
      urgent: false,
    })),
  ];

  const log = demo ? { entries: [] } : readLog(root, { limit: 60 });
  const recentNudges = log.entries
    .filter((e) => e.outcome === "nudged" || e.outcome === "digest shown")
    .slice(0, 10)
    .map((e) => ({ at: e.at ?? null, event: e.event ?? null, labels: e.nudge ?? (e.outcome === "digest shown" ? ["Daily digest"] : []) }));

  const wiring = demo ? [] : hookWiring(root, { cwd: homedir() });
  const missing = hooksMissing(wiring);
  const { _path, _exists, ...config } = cfg;

  const modelTokens = t.modelTokens ?? {};
  return {
    version: 1,
    generatedAt: new Date(now).toISOString(),
    demo,
    plan: { name: p.plan ?? null, paysPerToken: paysPerToken(p.plan), fetchedAt: p.fetchedAt ?? null, ageMins: p.ageMins ?? null, stale: p.stale !== false },
    limits: limitRows(p, now),
    spend: p.spend ?? null,
    today: {
      day: today,
      cost: todays.reduce((a, s) => a + s.cost, 0),
      tokens: todays.reduce((a, s) => a + tokenSum(s), 0),
      sessions: todays.length,
      prompts: todays.reduce((a, s) => a + s.typedPrompts, 0),
    },
    window: { days, cost: t.cost, tokens: t.tok, sessions: t.sessions, prompts: t.prompts, cacheHitRate: t.cacheHitRate },
    daily: dailySeries(all, days, now),
    models: Object.entries(t.models)
      .sort((a, b) => b[1] - a[1])
      .map(([model, cost]) => ({ model, cost, tokens: modelTokens[model] ?? 0, share: t.cost ? cost / t.cost : 0 })),
    recommendations: recommendations(ctx, attribution),
    nudges: standing,
    recent: recentNudges,
    hooks: { installed: wiring.some((w) => w.event) && missing.length === 0, missing, plugin: demo ? false : pluginEnabled(root) },
    paths: { config: _path ?? null, configExists: _exists === true, root },
    config,
  };
}

const resetWording = (iso, now) => {
  const at = Date.parse(iso ?? "");
  if (!Number.isFinite(at)) return "soon";
  const m = (at - now) / 60_000;
  return m <= 0 ? "shortly" : `in ${mins(m)}`;
};

/**
 * The nudges to post now, for a caller that runs between turns.
 *
 * Window rules only — a session rule needs the session a hook is handed. It
 * shares `marmot-state.json` with the Stop hook, keyed by the same day and
 * mark, so the app and the hook never both announce 75%. The quiet gap holds
 * as it does in the hook, except for an urgent nudge: the last mark before a
 * limit, or the limit itself, is not something to sit on for twenty minutes.
 *
 * `app` also means "I am the menu bar app": the heartbeat is written, which is
 * what tells the hooks to hand their nudges over rather than open a dialog, and
 * whatever they queued is drained into this tick's result.
 */
export function tick({ root, cfg, app = false, now = Date.now() }) {
  if (app) writeHeartbeat(root, { now });
  const notifications = app
    ? drainInbox(root).map((m) => ({ id: m.id ?? null, key: m.key ?? null, title: m.title ?? "Marmot", body: m.body ?? "", urgent: m.urgent === true, kind: m.kind ?? "nudge", source: "hook", at: m.at ?? new Date(now).toISOString() }))
    : [];

  const today = dayOf(now);
  const plan = readPlan(root, { now });
  const sessions = loadSessions({ root, days: (cfg.daily?.baselineDays ?? 14) + 1, rateOverrides: cfg.rateOverrides });
  const todayCost = sessions.filter((s) => s.day === today).reduce((a, s) => a + s.cost, 0);
  const live = new Set(cfg.live ?? []);

  const candidates = windowRules(sessions, cfg, { root, today, includeMcp: false, plan }).filter((w) => live.has(w.id));
  if (cfg.notify?.depleted !== false && cfg.limits?.enabled !== false) {
    for (const l of usableLimits(plan)) {
      if (l.percent < 100) continue;
      candidates.push({
        id: "limit-depleted",
        key: `limit-depleted:${l.kind}:${l.resetsAt ?? today}`,
        label: `Your ${l.label} limit is used up`,
        detail: `100% of your ${l.label} limit is gone${plan.plan ? ` on ${plan.plan}` : ""}. It resets ${resetWording(l.resetsAt, now)}.`,
        action: "Claude Code pauses until then, or draws on usage credits if you have them turned on.",
        urgent: true,
      });
    }
  }

  const state = readState(root);
  const fresh = candidates.filter((w) => shouldFire(state, today, w.key ?? w.id, todayCost));
  for (const w of fresh) markFired(state, today, w.key ?? w.id, todayCost);

  const quiet = withinQuietPeriod(state, cfg.interrupt?.minGapMins ?? 20, now);
  const eligible = quiet ? fresh.filter((w) => w.urgent) : fresh;
  const show = eligible.slice(0, Math.max(1, cfg.interrupt?.maxPerNudge ?? 1));
  if (show.length) markNudged(state, now);
  writeState(state, root);

  for (const w of show) {
    notifications.push({
      id: w.id,
      key: w.key ?? w.id,
      title: `Marmot · ${w.label}`,
      body: `${w.detail}\n\n${w.action}`,
      urgent: w.urgent === true,
      kind: "nudge",
      source: "tick",
      at: new Date(now).toISOString(),
    });
  }

  if (show.length && cfg.log?.hooks !== false && !process.env.MARMOT_NO_LOG) {
    logAppend(root, { event: "Tick", outcome: "nudged", nudge: show.map((w) => w.label), rules: fresh.map((w) => ({ id: w.key ?? w.id, fired: show.includes(w) })) }, { cfg, now });
  }

  return { version: 1, notifications, held: fresh.length - show.length };
}
