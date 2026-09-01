/**
 * Thresholds, and where they live.
 *
 * Defaults are deliberately quiet. Every rule carries the three guards the
 * product uses everywhere else — a ratio gap, a minimum sample, and a dollar
 * floor — because without all three the same checks fire on almost every
 * session and the whole thing gets muted in a week.
 *
 * Overrides go in `~/.claude/marmot.json`. Nothing is written there unless
 * you run `marmot init`, and the file is yours: no service reads it.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { defaultRoot } from "./sessions.mjs";

export const DEFAULTS = {
  // Rules that may interrupt you mid-session, at the end of an assistant turn.
  // Everything else is saved for the digest — a nudge you cannot act on right
  // now is an interruption, not a nudge.
  live: ["session-cost", "daily-cost", "daily-baseline", "session-turns"],
  digest: { cadence: "daily" },

  session: {
    // Typed prompts, not assistant turns and not tool results.
    turnCap: 20,
    // Only fires when the session never compacted: length alone is not a
    // problem, length without a context reset is.
    turnCapRequiresNoCompaction: true,
    costCap: 25,
    // Below this a session is too small to be worth a word about.
    costFloor: 1,
  },

  daily: {
    costCap: 50,
    baselineSigma: 2.5,
    baselineDays: 14,
    baselineMinDays: 5,
    baselineMinCost: 10,
  },

  models: {
    premium: ["claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-fable-5", "claude-mythos-5"],
    premiumShare: 0.7,
    // "Light work" is the qualifier that makes this rule mean something. A
    // premium model on hard work is the model doing its job.
    lightWorkToolCalls: 10,
    // Ceiling for the whole rule: past this a session is not light work by any
    // reading, whichever files it happened to write at the end.
    lightWorkMaxToolCalls: 40,
    lightWorkExtensions: [".md", ".mdx", ".txt", ".rst"],
    lightWorkDirs: ["test", "tests", "spec", "specs", "__tests__", "doc", "docs"],
    lightWorkFilePatterns: ["^test_", "_test\\.[a-z]+$", "\\.(test|spec)\\.[a-z]+$"],
  },

  cache: { minHitRate: 0.7, minTurns: 20 },
  toolErrors: { maxRate: 0.1, minCalls: 20 },
  mcp: { enabled: true },

  // USD per million tokens, merged over the published table. Set this if you
  // are on negotiated rates and want the shadow price to match your contract.
  rateOverrides: {},
};

function deepMerge(base, over) {
  if (!over || typeof over !== "object" || Array.isArray(over)) return over ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? deepMerge(base[k] ?? {}, v) : v;
  }
  return out;
}

export const configPath = (root = defaultRoot()) => join(root, "marmot.json");

export function loadConfig(root = defaultRoot()) {
  const p = configPath(root);
  if (!existsSync(p)) return { ...DEFAULTS, _path: p, _exists: false };
  try {
    return { ...deepMerge(DEFAULTS, JSON.parse(readFileSync(p, "utf8"))), _path: p, _exists: true };
  } catch (e) {
    process.stderr.write(`marmot: ignoring malformed ${p} (${e.message})\n`);
    return { ...DEFAULTS, _path: p, _exists: false };
  }
}
