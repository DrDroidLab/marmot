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

const SESSIONS = [
  { title: "Wire the billing webhook retry path", repo: "payments-api", branch: "fix/webhook-retry", prompts: 9, turns: 148, days: 0, hours: 2.4, opus: 1, err: 3 },
  { title: "Migrate the user table to partitioned storage", repo: "platform", branch: "feat/partition-users", prompts: 34, turns: 612, days: 1, hours: 9.1, opus: 1, err: 11 },
  { title: "Why is the nightly export timing out?", repo: "platform", branch: "main", prompts: 16, turns: 231, days: 2, hours: 3.7, opus: 1, err: 6 },
  { title: "Add pagination to the audit log endpoint", repo: "payments-api", branch: "feat/audit-pagination", prompts: 6, turns: 74, days: 3, hours: 1.1, opus: 0, err: 1 },
  { title: "Rewrite the onboarding docs", repo: "docs-site", branch: "docs/onboarding", prompts: 4, turns: 39, days: 4, hours: 0.6, opus: 1, err: 0 },
  { title: "Chase the flaky integration suite", repo: "platform", branch: "fix/flaky-e2e", prompts: 27, turns: 388, days: 5, hours: 6.2, opus: 1, err: 19 },
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
    out.push({
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
      permissionModes: ["default"], cacheHitRate: seen ? cr / seen : null,
      // Aliases so the rules engine can read a demo session like a real one.
      mcpCalls: mcpCounts, skills: Object.keys(skillCounts),
      toolErrorRate: calls ? errs / calls : 0, pricedTurns: spec.turns, unpricedModels: new Set(),
    });
  }
  return out;
}
