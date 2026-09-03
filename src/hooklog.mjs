/**
 * A record of what the hooks did, and why.
 *
 * The hooks are the part of Marmot nobody can see working. They run in a
 * process Claude Code starts and reaps, their stdout is parsed rather than
 * shown, and when they stay quiet — which is most of the time, by design —
 * there is nothing at all to look at. So when a nudge fires that should not
 * have, or does not fire when it should, there is no way to tell whether the
 * rule was wrong, the threshold was wrong, or the hook never ran.
 *
 * That is not hypothetical: a "$25.00 cap" nudge reached a Max subscriber
 * because the hook passed no plan to its session rules. Every part in
 * isolation was correct and tested. What was missing was any way to see the
 * inputs the hook actually assembled — which this writes down.
 *
 * One JSON object per line, per hook run. Append-only, capped, and never
 * allowed to throw: a log that breaks the nudge it was describing is worse
 * than no log.
 *
 * `hookWiring()` answers the other half of the same question — not what the
 * hooks did, but whether they are installed at all, and from where.
 */

import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const logPath = (root) => join(root, "marmot-hook.log");

/** Rewrite when the file passes this, keeping the newest `keep` lines. */
const MAX_BYTES = 512 * 1024;

/**
 * On by default. The whole point is to be there *before* the thing you want to
 * debug happens — a log you have to turn on and reproduce into is a log that
 * is off when it matters.
 */
export function logging(cfg, env = process.env) {
  if (env?.MARMOT_NO_LOG) return false;
  return cfg?.log?.hooks !== false;
}

/** Append one record. Returns what it did, for the tests; never throws. */
export function append(root, entry, { cfg = null, now = Date.now() } = {}) {
  const p = logPath(root);
  try {
    const line = JSON.stringify({ at: new Date(now).toISOString(), ...entry });
    appendFileSync(p, `${line}\n`);
    // Trimming costs a full read, so it happens on size rather than every
    // write — this runs at the end of every assistant turn.
    if (statSync(p).size > MAX_BYTES) trim(root, cfg?.log?.keep ?? 500);
    return true;
  } catch {
    return false;
  }
}

/** Keep the newest `keep` lines. */
export function trim(root, keep = 500) {
  const p = logPath(root);
  try {
    const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
    if (lines.length <= keep) return lines.length;
    writeFileSync(p, `${lines.slice(-keep).join("\n")}\n`);
    return keep;
  } catch {
    return 0;
  }
}

/**
 * The newest records first. A malformed line is skipped rather than fatal —
 * two hooks can finish at the same moment, and a torn write should cost one
 * record rather than the whole history.
 */
export function readLog(root, { limit = 20 } = {}) {
  const p = logPath(root);
  if (!existsSync(p)) return { path: p, exists: false, entries: [], skipped: 0 };
  let skipped = 0;
  const entries = [];
  try {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        skipped += 1;
      }
    }
  } catch {
    return { path: p, exists: true, entries: [], skipped: 0, unreadable: true };
  }
  entries.reverse();
  return { path: p, exists: true, entries: limit ? entries.slice(0, limit) : entries, skipped, total: entries.length };
}

/**
 * The plan, reduced to what actually decides a nudge.
 *
 * These four are exactly what `dollarsAreBilled()` reads. Writing them down
 * next to the outcome is what turns "why did this fire" into one glance.
 */
export function planTrace(plan) {
  if (!plan) return null;
  return {
    name: plan.plan,
    limits: (plan.limits ?? []).filter((l) => l.active).map((l) => [l.kind, l.percent]),
    ageMins: plan.ageMins === null || plan.ageMins === undefined ? null : Math.round(plan.ageMins),
    stale: plan.stale === true,
  };
}


/**
 * Every settings file that can carry a hook, in the order Claude Code layers
 * them. Both `.local.json` files count: they are where a per-machine setup
 * usually lands, and a check that reads only `settings.json` reports "not
 * installed" for a machine whose hooks are working perfectly.
 */
export function settingsFiles(root, cwd = process.cwd()) {
  return [
    { scope: "user", path: join(root, "settings.json") },
    { scope: "user (local)", path: join(root, "settings.local.json") },
    { scope: "project", path: join(cwd, ".claude", "settings.json") },
    { scope: "project (local)", path: join(cwd, ".claude", "settings.local.json") },
  ];
}

/**
 * Marmot's hooks as actually configured on this machine: which event, which
 * file, and whether that file is still there.
 *
 * The stale-path case is the one worth catching. `init --hooks` writes an
 * absolute path to the *installed* copy, so a reinstall to a different prefix,
 * or a plugin that was removed, leaves an entry that looks right in the
 * settings file and silently never runs.
 */
export function hookWiring(root, { cwd = process.cwd(), self = null } = {}) {
  const out = [];
  for (const { scope, path } of settingsFiles(root, cwd)) {
    if (!existsSync(path)) continue;
    let settings;
    try {
      settings = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      out.push({ scope, settings: path, event: null, malformed: e.message });
      continue;
    }
    for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
      for (const g of groups ?? []) {
        for (const h of g.hooks ?? []) {
          const command = String(h.command ?? "");
          if (!command.toLowerCase().includes("marmot")) continue;
          // The script is the quoted path in `node "…/hook.mjs"`; an
          // unquoted or templated command has none to check.
          const file = (command.match(/"([^"]+)"/) ?? [])[1] ?? null;
          out.push({
            scope,
            settings: path,
            event,
            command,
            file,
            exists: file ? existsSync(file) : null,
            isRunningCopy: Boolean(file && self && file === self),
            timeout: h.timeout ?? null,
          });
        }
      }
    }
  }
  return out;
}

/** What is missing, for a one-line verdict. */
export function hooksMissing(wiring, expected = ["SessionStart", "Stop"]) {
  const live = new Set(wiring.filter((w) => w.event && w.exists !== false).map((w) => w.event));
  return expected.filter((e) => !live.has(e));
}
