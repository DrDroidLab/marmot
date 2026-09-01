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
import { readState, writeState, shouldFire, markFired } from "../src/state.mjs";
import { usd } from "../src/format.mjs";
import { alert } from "../src/notify.mjs";
import { readPlan } from "../src/plan.mjs";

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

if (event === "SessionStart") {
  if (cfg.digest?.cadence === "off" || state.digestShownOn === today) process.exit(0);
  const sessions = loadSessions({ root, days: 30, rateOverrides: cfg.rateOverrides });
  if (!sessions.length) process.exit(0);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const recent = sessions.filter((s) => s.day === yesterday);
  const nudges = evaluate(recent.length ? recent : sessions.slice(0, 10), cfg, {
    root,
    today,
    windowSessions: sessions,
    plan: readPlan(root),
  });
  const days = byDay(sessions);
  const y = days.find((d) => d.day === yesterday);
  const head = y
    ? `Marmot · yesterday: ${usd(y.cost)} over ${y.sessions} session${y.sessions === 1 ? "" : "s"} and ${y.prompts} prompts.`
    : `Marmot · nothing recorded yesterday.`;
  const body = renderNudges(nudges, { compact: true });
  state.digestShownOn = today;
  writeState(state, root);
  if (body.trim()) alert(cfg, { title: "Marmot · daily digest", body: head.replace(/^Marmot · /, "") });
  emit(event, body.trim() ? `${head}\n\n${body}\n\n  marmot report — the full window` : `${head}  Nothing flagged.`);
}

// --- Stop: live rules against the session in front of you --------------------

const tp = input.transcript_path;
if (!tp) process.exit(0);

let current;
try {
  statSync(tp);
  current = readSession({ path: tp, id: basename(tp, ".jsonl"), project: basename(dirname(tp)) }, { rateOverrides: cfg.rateOverrides });
} catch {
  process.exit(0);
}
if (!current) process.exit(0);

const live = new Set(cfg.live ?? []);
const lines = [];

for (const rule of sessionRules) {
  if (!live.has(rule.id)) continue;
  const hit = rule.check(current, cfg);
  if (!hit) continue;
  if (!shouldFire(state, current.id, rule.id, current.cost)) continue;
  markFired(state, current.id, rule.id, current.cost);
  lines.push({ label: rule.label, detail: hit.detail, action: hit.action });
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
  for (const w of windowRules(all, cfg, { root, today, includeMcp: false, plan: readPlan(root) })) {
    if (!live.has(w.id)) continue;
    const todayCost = all.filter((s) => s.day === today).reduce((a, s) => a + s.cost, 0);
    const key = w.key ?? w.id;
    if (!shouldFire(state, today, key, todayCost)) continue;
    markFired(state, today, key, todayCost);
    lines.push({ label: w.label, detail: w.detail, action: w.action });
  }
}

writeState(state, root);
if (!lines.length) process.exit(0);

alert(cfg, {
  title: `Marmot · ${lines[0].label}`,
  body: lines.length > 1 ? `${lines[0].detail} (+${lines.length - 1} more)` : lines[0].detail,
});

emit(
  event,
  lines.map((l) => `Marmot · ${l.label}\n  ${l.detail}\n  ${l.action}`).join("\n\n"),
);
