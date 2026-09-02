/**
 * What has already been said.
 *
 * A nudge that repeats every turn is noise, and noise gets muted. This tracks
 * the last digest date and which rules have already fired for which session, so
 * each rule speaks once per session. Cost rules are the exception: they re-fire
 * at each doubling, because "you passed $25" and "you are now at $200" are
 * different facts.
 *
 * Lives at ~/.claude/marmot-state.json. Delete it to hear everything again.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { defaultRoot } from "./sessions.mjs";

const statePath = (root = defaultRoot()) => join(root, "marmot-state.json");

export function readState(root) {
  const p = statePath(root);
  if (!existsSync(p)) return { digestShownOn: null, fired: {}, lastNudgeAt: null };
  try {
    const s = JSON.parse(readFileSync(p, "utf8"));
    return { digestShownOn: s.digestShownOn ?? null, fired: s.fired ?? {}, lastNudgeAt: s.lastNudgeAt ?? null };
  } catch {
    return { digestShownOn: null, fired: {}, lastNudgeAt: null };
  }
}

export function writeState(state, root) {
  const p = statePath(root);
  try {
    mkdirSync(dirname(p), { recursive: true });
    // Keep only the last 200 sessions; this file should never grow unbounded.
    const keys = Object.keys(state.fired);
    if (keys.length > 200) {
      state.fired = Object.fromEntries(keys.slice(-200).map((k) => [k, state.fired[k]]));
    }
    writeFileSync(p, JSON.stringify(state, null, 2));
  } catch {
    /* an unwritable state file costs dedupe, not the nudge */
  }
}

/**
 * Whether enough quiet has passed since the last live nudge.
 *
 * Crossing 50% and 75% of a window inside the same minute is two true things
 * and one interruption too many; the second waits. Kept in the state file so it
 * holds across the many short-lived hook processes a session spawns.
 */
export function withinQuietPeriod(state, minGapMins = 20, now = Date.now()) {
  const last = state.lastNudgeAt;
  return typeof last === "number" && now - last < minGapMins * 60_000;
}

export function markNudged(state, now = Date.now()) {
  state.lastNudgeAt = now;
}

/** True when this rule has something new to say about this session. */
export function shouldFire(state, sessionId, ruleId, cost = 0) {
  const key = `${sessionId}:${ruleId}`;
  const prev = state.fired[key];
  if (prev === undefined) return true;
  // Cost rules speak again at each doubling.
  if (ruleId.includes("cost") || ruleId.includes("baseline")) return cost >= prev * 2;
  return false;
}

export function markFired(state, sessionId, ruleId, cost = 0) {
  state.fired[`${sessionId}:${ruleId}`] = Math.max(cost, 0.01);
}
