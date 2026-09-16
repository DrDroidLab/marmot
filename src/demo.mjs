/**
 * Synthetic sessions, so the thing can be seen before it is trusted.
 *
 * `marmot browse --demo` and `marmot report --demo` run against these instead
 * of your machine. That gives a stranger a way to look at the output before
 * pointing it at their own transcripts, and it gives this repo screenshots that
 * leak nobody's prompts.
 *
 * Deterministic: the same seed produces the same sessions every time, so a
 * screenshot regenerated in a year still matches the README.
 */

const rng = (seed) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

/**
 * Four weeks of work, so a 14-day chart is full, a 30-day one has shape, and
 * the session list is worth scrolling. Heavy days sit next to quiet ones, and
 * two weekends are empty, because a demo that is flat teaches nothing.
 */
const SESSIONS = [
  { title: "Wire the billing webhook retry path", repo: "payments-api", branch: "fix/webhook-retry", prompts: 9, turns: 148, days: 0, hours: 2.4, opus: 1, err: 3 },
  { title: "Why is the nightly export timing out?", repo: "platform", branch: "main", prompts: 16, turns: 231, days: 1, hours: 3.7, opus: 1, err: 6 },
  { title: "Migrate the user table to partitioned storage", repo: "platform", branch: "feat/partition-users", prompts: 34, turns: 612, days: 2, hours: 9.1, opus: 1, err: 11 },
  { title: "Add pagination to the audit log endpoint", repo: "payments-api", branch: "feat/audit-pagination", prompts: 6, turns: 74, days: 3, hours: 1.1, opus: 0, err: 1 },
  { title: "Chase the flaky integration suite", repo: "platform", branch: "fix/flaky-e2e", prompts: 27, turns: 388, days: 4, hours: 6.2, opus: 1, err: 19 },
  { title: "Rewrite the onboarding docs", repo: "docs-site", branch: "docs/onboarding", prompts: 4, turns: 39, days: 5, hours: 0.6, opus: 1, err: 0 },
  { title: "Tune the search index refresh", repo: "platform", branch: "perf/search-refresh", prompts: 12, turns: 174, days: 8, hours: 2.9, opus: 1, err: 4 },
  { title: "Port the ledger tests off the old fixture", repo: "payments-api", branch: "test/ledger-fixtures", prompts: 21, turns: 296, days: 9, hours: 4.8, opus: 0, err: 7 },
  { title: "Trace the duplicate refund webhook", repo: "payments-api", branch: "fix/duplicate-refund", prompts: 18, turns: 262, days: 11, hours: 4.1, opus: 1, err: 9 },
  { title: "Draft the Q4 architecture note", repo: "docs-site", branch: "docs/q4-architecture", prompts: 7, turns: 61, days: 12, hours: 1.4, opus: 1, err: 0 },
  { title: "Split the billing worker queue", repo: "platform", branch: "feat/split-queue", prompts: 29, turns: 441, days: 15, hours: 7.3, opus: 1, err: 13 },
  { title: "Cut the cold-start time on the API", repo: "payments-api", branch: "perf/cold-start", prompts: 14, turns: 203, days: 16, hours: 3.2, opus: 1, err: 5 },
  { title: "Move the audit log to append-only storage", repo: "platform", branch: "feat/append-only-audit", prompts: 23, turns: 337, days: 18, hours: 5.6, opus: 1, err: 8 },
  { title: "Fix the CSV export encoding", repo: "payments-api", branch: "fix/csv-encoding", prompts: 5, turns: 58, days: 19, hours: 0.9, opus: 0, err: 2 },
  { title: "Add retries to the settlement job", repo: "platform", branch: "feat/settlement-retries", prompts: 17, turns: 244, days: 22, hours: 4.4, opus: 1, err: 6 },
  { title: "Document the webhook contract", repo: "docs-site", branch: "docs/webhook-contract", prompts: 8, turns: 72, days: 25, hours: 1.6, opus: 0, err: 1 },
];

const TOOLS = ["Bash", "Read", "Edit", "Grep", "Write", "Glob", "WebFetch"];
const SKILLS = ["code-review", "dataviz", "run"];
const MCP = ["github", "sentry", "postgres"];
const PROMPTS = [
  "the retry path drops the event when the third attempt 502s. can you find where and fix it",
  "why is this still failing on CI but passing locally",
  "add a test that covers the partial-failure case",
  "this is taking too long — can we do it without a full table scan?",
  "ok ship it. run the suite first",
];
const REPLIES = [
  "Found it — the retry wrapper swallows the error when `attempt === max`, so the event never reaches the dead-letter queue.",
  "The local run uses the seeded fixture; CI builds the table from the migration, which is missing the index.",
  "Added the case and it fails against current main, which is what we want before the fix.",
];

/**
 * Sizes for the demo's skills. Real skill sizes are measured from the SKILL.md
 * files on disk; a demo run reads nothing from this machine, so it carries its
 * own plausible figures rather than reporting every skill as unmeasurable.
 */
export const demoSkillSizes = {
  "code-review": { name: "code-review", always: 22, onLoad: 1840 },
  dataviz: { name: "dataviz", always: 31, onLoad: 4120 },
  run: { name: "run", always: 18, onLoad: 960 },
};

/**
 * What a demo run pretends to have measured about this machine: the servers it
 * would have found configured, what their definitions weigh, and Claude Code's
 * own attribution. Without these the diagnoses have no figure to quote, and a
 * demo shows a menu with nothing under Recommendations — which is the one thing
 * a demo is for.
 */
export const demoConfiguredServers = ["github", "sentry", "postgres", "datadog"];

export const demoMcpSizes = {
  measuredAt: new Date().toISOString(),
  servers: {
    github: { count: 26, tokens: 4_020 },
    sentry: { count: 14, tokens: 2_310 },
    postgres: { count: 9, tokens: 1_280 },
    datadog: { count: 22, tokens: 3_600 },
  },
};

export const demoAttribution = {
  parsedAt: new Date().toISOString(),
  windows: [
    { label: "Last 24h", requests: 268, sessions: 2, behaviours: [{ percent: 71, text: "of your usage was at >150k context" }], top: {} },
    {
      label: "Last 7d",
      requests: 1_204,
      sessions: 6,
      behaviours: [
        { percent: 82, text: "of your usage came from sessions active for 8+ hours" },
        { percent: 64, text: "of your usage was at >150k context" },
      ],
      top: { skills: [{ name: "dataviz", percent: 3 }], "mcp-servers": [{ name: "github", percent: 2 }] },
    },
  ],
};

export function demoSessions() {
  const r = rng(20260901);
  const out = [];
  for (const [n, spec] of SESSIONS.entries()) {
    const end = new Date(Date.now() - spec.days * 86_400_000 - 3 * 3_600_000);
    const start = new Date(end.getTime() - spec.hours * 3_600_000);
    const model = spec.opus ? "claude-opus-5" : "claude-sonnet-5";
    const events = [];
    const toolCounts = {}, skillCounts = {}, mcpCounts = {};
    let cost = 0, cr = 0, cw = 0, inp = 0, outp = 0, think = 0, calls = 0, errs = 0;

    for (let p = 0; p < spec.prompts; p++) {
      const at = new Date(start.getTime() + ((end - start) * (p + r() * 0.4)) / spec.prompts).toISOString();
      events.push({ kind: "prompt", at, text: PROMPTS[Math.floor(r() * PROMPTS.length)], truncated: 0 });
      const perPrompt = Math.max(1, Math.round(spec.turns / spec.prompts));
      for (let t = 0; t < perPrompt; t++) {
        const tokIn = Math.round(20000 + r() * 90000);
        const tokOut = Math.round(200 + r() * 2600);
        const thisCr = Math.round(tokIn * 0.94), thisCw = Math.round(tokIn * 0.05);
        const rate = model === "claude-opus-5" ? [5, 25] : [2, 10];
        const c = ((tokIn - thisCr - thisCw) * rate[0] + thisCr * rate[0] * 0.1 + thisCw * rate[0] * 2 + tokOut * rate[1]) / 1e6;
        cost += c; cr += thisCr; cw += thisCw; inp += tokIn - thisCr - thisCw; outp += tokOut;
        const th = r() > 0.5 ? Math.round(tokOut * 0.6) : 0; think += th;
        const tools = [];
        const nTools = Math.round(r() * 3);
        for (let k = 0; k < nTools; k++) {
          const useMcp = r() > 0.9, useSkill = r() > 0.95;
          const name = useMcp ? `mcp__${MCP[Math.floor(r() * MCP.length)]}__query` : useSkill ? "Skill" : TOOLS[Math.floor(r() * TOOLS.length)];
          const server = useMcp ? name.split("__")[1] : null;
          const skill = useSkill ? SKILLS[Math.floor(r() * SKILLS.length)] : null;
          const isError = errs < spec.err && r() > 0.93;
          if (isError) errs++;
          calls++;
          toolCounts[name] = (toolCounts[name] ?? 0) + 1;
          if (server) mcpCounts[server] = (mcpCounts[server] ?? 0) + 1;
          if (skill) skillCounts[skill] = (skillCounts[skill] ?? 0) + 1;
          tools.push({ name, server, skill, isError, text: skill ?? (server ? "select … limit 50" : `src/${spec.repo}/handler.ts`), truncated: 0 });
        }
        events.push({
          kind: "assistant", at, model, sidechain: false, cost: c, stop: "end_turn", thinking: th,
          tok: { in: tokIn - thisCr - thisCw, out: tokOut, cr: thisCr, cw: thisCw },
          tools, text: t === 0 ? REPLIES[Math.floor(r() * REPLIES.length)] : "", truncated: 0,
        });
      }
    }

    const seen = cr + cw + inp;
    // Spend by local day, the way the reader records it, so a demo draws the
    // same chart shape as a real machine rather than one bar per session.
    const daily = {};
    const dayKey = (d) => {
      const pad = (v) => String(v).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };
    const spread = Math.max(1, Math.ceil(spec.hours / 8));
    for (let i = 0; i < spread; i += 1) {
      const at = new Date(end.getTime() - i * 86_400_000);
      const share = i === 0 ? 1 / spread + (spread > 1 ? 0.15 : 0) : (1 - 0.15) / spread;
      daily[dayKey(at)] = {
        cost: cost * share,
        tokens: Math.round((inp + outp + cr + cw) * share),
        models: { [model]: { cost: cost * share, tokens: Math.round((inp + outp + cr + cw) * share) } },
      };
    }
    // The fields the diagnoses read. Long sessions carry history and lean on
    // subagents; the flaky-suite session is the one whose tools keep failing.
    const worstTool = spec.err >= 6 ? "Bash" : null;
    out.push({
      daily,
      history: { last: Math.round(20_000 + spec.turns * 620), peak: Math.round(24_000 + spec.turns * 700) },
      sidechain: spec.turns > 300 ? { turns: Math.round(spec.turns * 0.18), tokens: Math.round((cr + inp) * 0.22), cost: cost * 0.31 } : { turns: 0, tokens: 0, cost: 0 },
      longestQuietRun: spec.opus && spec.turns > 200 ? { model, turns: 14, outputCap: 1000 } : { model: null, turns: 0, outputCap: 1000 },
      modelTurns: { [model]: spec.turns },
      toolErrorsByName: worstTool ? { [worstTool]: spec.err } : {},
      toolCalls: toolCounts,
      id: `demo${n}0000-0000-4000-8000-00000000000${n}`,
      project: spec.repo, path: `(demo)`, mtime: end.toISOString(),
      cwd: `/Users/you/code/${spec.repo}`, gitBranch: spec.branch, version: "2.1.0",
      startedAt: start.toISOString(), endedAt: end.toISOString(), title: spec.title,
      day: end.toISOString().slice(0, 10), durationMins: (end - start) / 60000,
      events, cost, typedPrompts: spec.prompts, assistantTurns: spec.turns, sidechainTurns: 0,
      compactions: spec.turns > 400 ? 2 : 0,
      tokens: { input: inp, output: outp, cacheRead: cr, cacheWrite: cw, thinking: think },
      toolCounts, skillCounts, mcpCounts, toolErrors: errs, totalToolCalls: calls,
      models: { [model]: cost }, filesTouched: [`src/${spec.repo}/handler.ts`, `src/${spec.repo}/handler.test.ts`],
      modelTokens: { [model]: { input: inp, output: outp, cacheRead: cr, cacheWrite: cw, total: inp + outp + cr + cw } },
      // A plausible prefix: system prompt, skills and tool definitions.
      baselineTokens: 21_000 + Math.round(r() * 12_000),
      dirTouches: { [`src/${spec.repo}`]: { dir: `src/${spec.repo}`, count: 2, firstTurn: 1, lastTurn: spec.turns } },
      promptTimes: [],
      permissionModes: ["default"], cacheHitRate: seen ? cr / seen : null,
      // Aliases so the rules engine can read a demo session like a real one.
      mcpCalls: mcpCounts, skills: Object.keys(skillCounts),
      toolErrorRate: calls ? errs / calls : 0, pricedTurns: spec.turns, unpricedModels: new Set(),
    });
  }
  return out;
}
