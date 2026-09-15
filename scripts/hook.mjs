#!/usr/bin/env node
/**
 * The nudge delivery path.
 *
 * SessionStart → the daily digest, once a day, on the first session of the day.
 * Stop         → live rules against the session you are in, at the end of an
 *                assistant turn. Never mid-tool-call, never blocking.
 *
 * Everything goes out as `systemMessage`, which the user sees and the model
 * does not. A nudge is for you; feeding it to Claude would just have it
 * apologise for its own token use.
 *
 * This runs on every turn end, so it is throttled: the current session is
 * always re-read (it is the one that changed), other sessions at most once
 * every few minutes.
 */

process.env.NO_COLOR = "1";

import { readFileSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { loadSessions, readSession, defaultRoot, byDay } from "../src/sessions.mjs";
import { loadConfig } from "../src/config.mjs";
import { evaluate, sessionRules, windowRules } from "../src/rules.mjs";
import { renderNudges } from "../src/render.mjs";
import { readState, writeState, shouldFire, markFired, withinQuietPeriod, markNudged } from "../src/state.mjs";
import { usd } from "../src/format.mjs";
import { alert, notifyStyle } from "../src/notify.mjs";
import { readPlan, refreshUsage, refreshUsageInBackground, worthRefreshing, readAttribution, enforcesLimits } from "../src/plan.mjs";
import { logging, append as logAppend, planTrace } from "../src/hooklog.mjs";
import { record as recordShown, delivery } from "../src/notifications.mjs";

const THROTTLE_MS = 5 * 60 * 1000;

const emit = (event, message) => {
  if (message && message.trim()) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, systemMessage: message.trim() } }));
  }
  process.exit(0);
};

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return {};
  }
}

const input = await readStdin();
const event = input.hook_event_name ?? "Stop";
const root = process.env.MARMOT_ROOT ?? defaultRoot();
const cfg = loadConfig(root);
const state = readState(root);
const today = new Date().toISOString().slice(0, 10);

// What this run saw and decided. Filled in as we go and written on the way
// out, from a single `exit` handler rather than at each of the seven places
// this process can leave — one of which is inside `emit()`, and all of which
// are the interesting ones when nothing appeared.
const startedAt = Date.now();
const trace = { event, pid: process.pid, outcome: "started", rules: [] };
process.on("exit", () => {
  if (!logging(cfg)) return;
  trace.ms = Date.now() - startedAt;
  logAppend(root, trace, { cfg });
});

if (event === "SessionStart") {
  if (cfg.digest?.cadence === "off" || state.digestShownOn === today) {
    trace.outcome = cfg.digest?.cadence === "off" ? "digest off in config" : "digest already shown today";
    process.exit(0);
  }
  const sessions = loadSessions({ root, days: 30, rateOverrides: cfg.rateOverrides });
  if (!sessions.length) process.exit(0);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const recent = sessions.filter((s) => s.day === yesterday);
  const nudges = evaluate(recent.length ? recent : sessions.slice(0, 10), cfg, {
    root,
    today,
    windowSessions: sessions,
    // Once a day, on the digest, it is worth the couple of seconds. The Stop
    // hook below runs at the end of every turn and must not pay that.
    plan: (() => {
      const p = readPlan(root);
      if (cfg.limits?.autoRefresh && !process.env.MARMOT_NO_REFRESH && p.plan && worthRefreshing(p, cfg.limits.staleAfterMins)) {
        const r = refreshUsage(root);
        if (r.refreshed) return r.plan;
      }
      return p;
    })(),
    attribution: readAttribution(root),
  });
  const days = byDay(sessions);
  const y = days.find((d) => d.day === yesterday);
  const head = y
    ? `Marmot · yesterday: ${usd(y.cost)} over ${y.sessions} session${y.sessions === 1 ? "" : "s"} and ${y.prompts} prompts.`
    : `Marmot · nothing recorded yesterday.`;
  const body = renderNudges(nudges, { compact: true });
  state.digestShownOn = today;
  writeState(state, root);
  trace.outcome = body.trim() ? "digest shown" : "digest: nothing flagged";
  // `evaluate` returns the two kinds separately; the digest reports both.
  trace.rules = [
    ...(nudges.sessionNudges ?? []).map((n) => ({ id: n.id, fired: true, sessions: n.hits?.length ?? 0 })),
    ...(nudges.windowNudges ?? []).map((n) => ({ id: n.key ?? n.id, fired: true })),
  ];
  const title = "Marmot · daily digest";
  const desktopBody = head.replace(/^Marmot · /, "");
  let did = null;
  if (body.trim()) {
    did = alert(cfg, { title, body: desktopBody, kind: "digest" });
    trace.notify = { style: did.style, via: did.desktop?.via ?? did.desktop?.cmd ?? null, bell: did.bell };
  }
  const message = body.trim() ? `${head}\n\n${body}\n\n  marmot report — the full window` : `${head}  Nothing flagged.`;
  // Catalogued whether or not a desktop notification went out: the digest lands
  // in your transcript either way, and that is something you were shown.
  recordShown(root, { kind: "digest", event, title, body: did ? desktopBody : null, message, rules: trace.rules.map((r) => r.id), delivery: delivery(did) }, { cfg });
  emit(event, message);
}

// --- Stop: live rules against the session in front of you --------------------

const tp = input.transcript_path;
if (!tp) {
  trace.outcome = "no transcript_path on the hook input";
  process.exit(0);
}

let current;
try {
  statSync(tp);
  current = readSession({ path: tp, id: basename(tp, ".jsonl"), project: basename(dirname(tp)) }, { rateOverrides: cfg.rateOverrides });
} catch (e) {
  trace.outcome = `could not read the transcript: ${e.message}`;
  process.exit(0);
}
if (!current) {
  trace.outcome = "transcript read, but no session in it";
  process.exit(0);
}

const live = new Set(cfg.live ?? []);
const lines = [];

// Read once, and give it to *both* kinds of rule. Session rules went without
// it for a while, and a rule that cannot see the plan cannot know the money is
// already spent — so `session-cost` announced a $25 cap to someone on Max,
// where the quota is the only ceiling that means anything.
const plan = readPlan(root);

// On Pro, Max and Team the limits are the only thing that speaks, so a snapshot
// nobody refreshes is a nudge that never comes — and Claude Code does not keep
// it fresh on its own. Ask for one without waiting, since this runs every turn,
// and no more than once every few minutes however stale it stays.
const REFRESH_GAP_MS = 10 * 60 * 1000;
if (cfg.limits?.enabled && cfg.limits?.autoRefresh && !process.env.MARMOT_NO_REFRESH && enforcesLimits(plan.plan) && worthRefreshing(plan, cfg.limits.staleAfterMins)) {
  if (Date.now() - (state.refreshStartedAt ?? 0) < REFRESH_GAP_MS) {
    trace.refresh = "limits stale; a refresh was already asked for recently";
  } else {
    state.refreshStartedAt = Date.now();
    trace.refresh = refreshUsageInBackground() ? "limits stale; refreshing in the background for the next turn" : "limits stale; could not start a refresh";
  }
}

trace.session = current.id;
trace.cwd = current.cwd ?? null;
trace.cost = Number(current.cost?.toFixed?.(2) ?? current.cost);
trace.turns = current.assistantTurns;
trace.prompts = current.typedPrompts;
// The plan is here because it is what decides whether a dollar cap means
// anything, and reading it wrong is invisible from the outside.
trace.plan = planTrace(plan);
trace.live = [...live];
trace.caps = { session: cfg.session?.costCap, daily: cfg.daily?.costCap };

for (const rule of sessionRules) {
  if (!live.has(rule.id)) continue;
  const hit = rule.check(current, cfg, { plan });
  if (!hit) {
    trace.rules.push({ id: rule.id, fired: false, why: "the rule did not match" });
    continue;
  }
  // A rule with marks keys each one, so crossing the next is news.
  const key = hit.key ?? rule.id;
  if (!shouldFire(state, current.id, key, current.cost)) {
    trace.rules.push({ id: key, fired: false, why: `already said for this session${rule.id.includes("cost") ? ", and not yet doubled" : ""}` });
    continue;
  }
  markFired(state, current.id, key, current.cost);
  trace.rules.push({ id: key, fired: true });
  lines.push({ id: key, label: hit.label ?? rule.label, detail: hit.detail, action: hit.action, urgent: hit.urgent === true });
}

// Today's total needs the other sessions too. They change slowly; re-read at
// most every few minutes so this stays cheap on a hook that fires every turn.
if (live.has("daily-cost") || live.has("daily-baseline") || live.has("limit-reached")) {
  const cache = state.dailyCache;
  const fresh = cache && cache.day === today && Date.now() - cache.at < THROTTLE_MS;
  let others = fresh ? cache.sessions : null;
  if (!others) {
    others = loadSessions({ root, days: cfg.daily.baselineDays + 1, rateOverrides: cfg.rateOverrides })
      .filter((s) => s.id !== current.id)
      .map((s) => ({ id: s.id, day: s.day, cost: s.cost, typedPrompts: s.typedPrompts, assistantTurns: s.assistantTurns }));
    state.dailyCache = { day: today, at: Date.now(), sessions: others };
  }
  const all = [...others, { id: current.id, day: today, cost: current.cost, typedPrompts: current.typedPrompts, assistantTurns: current.assistantTurns }];
  // The plan's own limits belong in the live path above all: "you are at 90% of
  // this week" is only actionable before the week is out.
  for (const w of windowRules(all, cfg, { root, today, includeMcp: false, plan })) {
    if (!live.has(w.id)) continue;
    const todayCost = all.filter((s) => s.day === today).reduce((a, s) => a + s.cost, 0);
    const key = w.key ?? w.id;
    if (!shouldFire(state, today, key, todayCost)) {
      trace.rules.push({ id: key, fired: false, why: "already said today, and not yet doubled" });
      continue;
    }
    markFired(state, today, key, todayCost);
    trace.rules.push({ id: key, fired: true });
    lines.push({ id: key, label: w.label, detail: w.detail, action: w.action, urgent: w.urgent === true });
  }
}

// When several have something to say, the one that can run out goes first: a
// limit, then money, then the shape of the session. Urgent above all of them.
const rank = (id) => (id.startsWith("limit-") ? 0 : /cost|baseline/.test(id) ? 1 : 2);
lines.sort((a, b) => Number(b.urgent) - Number(a.urgent) || rank(a.id) - rank(b.id));

if (!lines.length) {
  writeState(state, root);
  trace.outcome = "nothing to say";
  process.exit(0);
}

// One interruption at a time, and not again for a while. Everything held back
// is still waiting in the daily digest and in `marmot`, so nothing is lost —
// it just does not arrive as a third popup inside ten minutes.
if (withinQuietPeriod(state, cfg.interrupt?.minGapMins ?? 20)) {
  writeState(state, root);
  // Held back rather than dropped: it is still in the digest and in `marmot`.
  trace.outcome = `held: within ${cfg.interrupt?.minGapMins ?? 20} min of the last nudge`;
  trace.held = lines.map((l) => l.label);
  process.exit(0);
}

const show = lines.slice(0, Math.max(1, cfg.interrupt?.maxPerNudge ?? 1));
markNudged(state);
writeState(state, root);

const title = `Marmot · ${show[0].label}`;
// A banner gets the one line it has room for. A dialog has room for the whole
// nudge, so it carries what to do about it too — which is the half that makes
// it worth interrupting for.
const body =
  (notifyStyle(cfg, show[0].urgent) === "alert"
    ? `${show[0].detail}\n\n${show[0].action}`
    : show[0].detail) + (lines.length > 1 ? `\n\n${lines.length - 1} more in \`marmot\`.` : "");
const did = alert(cfg, { title, body, urgent: show[0].urgent });
trace.outcome = "nudged";
trace.nudge = show.map((l) => l.label);
trace.notify = { style: did.style, via: did.desktop?.via ?? did.desktop?.cmd ?? null, bell: did.bell };

const message =
  show.map((l) => `Marmot · ${l.label}\n  ${l.detail}\n  ${l.action}`).join("\n\n") +
  (lines.length > show.length ? `\n\n  ${lines.length - show.length} more in \`marmot\` and tomorrow's digest.` : "");

// The words as they were shown, beside what decided them. The hook log says why
// a rule fired; this says what reached you, and through which channel.
recordShown(
  root,
  {
    kind: "nudge",
    event,
    title,
    body,
    message,
    rules: show.map((l) => ({ id: l.id, label: l.label, urgent: l.urgent })),
    heldBack: lines.slice(show.length).map((l) => l.id),
    session: current.id,
    cwd: current.cwd ?? null,
    cost: trace.cost,
    plan: trace.plan,
    delivery: delivery(did),
  },
  { cfg },
);

emit(event, message);
