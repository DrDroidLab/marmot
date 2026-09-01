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
  live: ["session-cost", "daily-cost", "daily-baseline", "session-turns", "limit-reached"],
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

    // Whether one long session was really several. Judged from the directories
    // it edited and the gaps between prompts — never from prompt text, and
    // never by asking a model.
    topicMinPrompts: 15,
    // Two areas is enough once a day has passed between them.
    topicMinAreas: 2,
    // An area touched once is a passing glance, not a strand of work.
    topicMinTouches: 2,
    // Depth of the path that makes an "area". At 1, falcon/app and falcon/lib
    // are one project rather than two strands; raise it to 2 on a repo where
    // everything lives under a single src/.
    topicDepth: 1,
    // A day. Shorter gaps are lunch, not a change of subject.
    topicGapMins: 1440,
  },

  // Your plan's own limits, read from the snapshot Claude Code caches. On a
  // subscription these matter far more than a modelled dollar figure: the
  // dollars are already paid, and what you are actually spending is allowance.
  limits: {
    enabled: true,
    // Marks on the way to a limit, as a percentage of it. Crossing each one
    // speaks once, so you hear "half gone" long before "nearly out" — a single
    // cap can only ever tell you the second.
    //
    // The windows are Claude's own: a rolling 5-hour session window, a weekly
    // one, and a weekly one scoped to a single model. There is no daily limit.
    steps: [50, 75, 90],
    // Per plan, because the same percentage means a different amount of room.
    // An empty array silences a plan; API usage has no limit to run out of.
    byPlan: {
      "Pro": [50, 75, 90],
      "Max 5×": [50, 75, 90],
      "Max 20×": [50, 75, 90],
      "Team": [50, 75, 90],
      "Enterprise": [50, 75, 90],
      "API": [],
    },
    // A cached percentage older than this is reported with its age attached
    // rather than as current.
    staleAfterMins: 60,
    // Spending a window faster than it passes. The three guards, as everywhere:
    // a ratio gap (how far ahead of pace), a minimum sample (enough of the
    // window gone for the ratio to mean anything) and a floor (enough of the
    // allowance used to be worth a word).
    // Claude Code's own attribution of what is driving your limit usage. It
    // says things like "80% of your usage came from sessions active for 8+
    // hours" — quoting that beats inferring it, so the bar is high enough that
    // it is worth repeating.
    driverMinPercent: 60,

    paceRatio: 1.5,
    paceMinElapsed: 15,
    paceMinUsed: 20,

    // When the snapshot is stale or its window has reset, ask Claude Code to
    // refresh it: `claude -p /usage` is handled client-side, costs no tokens
    // and creates no session. Set false to only ever read what is cached.
    autoRefresh: true,
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
    // One light session on a premium model is a choice; a habit of them is a
    // pattern worth naming once, across the window.
    lightWorkMinSessions: 5,
  },

  // How a nudge reaches you, beyond the line in the transcript. Both on to
  // start with; a nudge you scroll past is a nudge that did not happen.
  notify: {
    desktop: true,
    bell: true,
    // Which app posts the notification, when the one running Marmot cannot.
    // macOS only lists apps that have registered themselves, and an app that
    // is not listed cannot be allowed — so point this at one that is (a bundle
    // id like "com.googlecode.iterm2", or an app name like "Script Editor").
    // `marmot doctor` says which channel is in force.
    app: null,
    // The notification's own sound, used when `bell` is on. A terminal BEL
    // needs a controlling terminal and a terminal that rings; this does not.
    // Any macOS sound name works — Ping, Glass, Submarine, Funk.
    sound: "Ping",
    // Keep the notification up until you dismiss it, where the platform allows
    // it: critical urgency on Linux, a long-lived balloon on Windows. macOS
    // gives `display notification` no say — there it is the Alert style you set
    // for the posting app, and `marmot doctor` says where.
    persist: true,
  },

  // Each run writes a new page, so the browser can never show you a cached
  // older one. This is how many are kept before the oldest are removed.
  browse: { keep: 5 },

  cache: { minHitRate: 0.7, minTurns: 20 },
  toolErrors: { maxRate: 0.1, minCalls: 20 },
  mcp: {
    enabled: true,
    // The report measures your MCP servers itself when it has no recent
    // figures, because a nudge that cannot say what a server costs is only
    // half a nudge. Measuring starts each server, so the result is cached and
    // re-used for a week. Set autoAudit false to only ever measure on demand.
    autoAudit: true,
    auditMaxAgeDays: 7,
    // Shorter than the explicit `mcp-audit`: this one is in your way.
    auditTimeoutSecs: 10,
  },

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
