import { test } from "node:test";
import assert from "node:assert/strict";
import { bestDiagnosis, allDiagnoses, CONFIDENCE, LEVERAGE } from "../src/diagnose.mjs";

const session = (over = {}) => ({
  cost: 100,
  assistantTurns: 200,
  typedPrompts: 20,
  durationMins: 120,
  tokens: { input: 1000, output: 50_000, cacheRead: 900_000, cacheWrite: 10_000 },
  models: { "claude-opus-5": 100 },
  modelTurns: { "claude-opus-5": 200 },
  sidechain: { turns: 0, tokens: 0, cost: 0 },
  history: { last: 0, peak: 0 },
  longestQuietRun: { model: null, turns: 0, outputCap: 1000 },
  toolCalls: {},
  toolErrorsByName: {},
  ...over,
});

const ctx = (over = {}) => ({
  sessionTokens: 961_000,
  premium: ["claude-opus-5"],
  attribution: null,
  mcp: { configured: [], called: {}, sizes: null, daysSince: {}, baseline: 40_000 },
  ...over,
  // After the spread, or an override of one session field would replace the
  // whole session with just that field.
  session: session(over.session),
});

test("idle servers quote measured tokens and how long they have been idle", () => {
  const d = allDiagnoses(
    ctx({
      mcp: {
        configured: ["github", "sentry", "used"],
        called: { used: 12 },
        sizes: { servers: { github: { tokens: 4000 }, sentry: { tokens: 2000 } } },
        daysSince: { github: 12, sentry: 3 },
        baseline: 40_000,
      },
    }),
  ).find((x) => x.id === "idle-mcp");

  assert.ok(d);
  assert.match(d.line, /2 MCP servers unused for 12 days/, "the longest idle time is the one worth saying");
  assert.match(d.line, /6\.0K tokens per request/);
  assert.match(d.line, /github, sentry/);
  assert.equal(d.share, 6000 / 40_000);
  assert.equal(d.confidence, CONFIDENCE.measured);
  assert.equal(d.leverage, LEVERAGE.setting);
});

test("idle servers with no measured size say nothing", () => {
  // "You have idle servers" without a number is not worth interrupting anyone
  // for, and inventing the number is worse.
  const d = allDiagnoses(ctx({ mcp: { configured: ["a"], called: {}, sizes: null, daysSince: {}, baseline: 40_000 } }));
  assert.equal(d.find((x) => x.id === "idle-mcp"), undefined);
});

test("subagents are measured as a share of the session", () => {
  const d = allDiagnoses(ctx({ session: { sidechain: { turns: 9, tokens: 560_000, cost: 58 } } })).find((x) => x.id === "subagents");
  assert.ok(d);
  assert.equal(d.share, 0.58);
  assert.match(d.line, /Subagents did 58% of the work/);
  assert.match(d.line, /\$58\.00/);
});

test("carried history needs enough of it to be worth saying", () => {
  const small = allDiagnoses(ctx({ session: { history: { last: 12_000, peak: 12_000 } } }));
  assert.equal(small.find((x) => x.id === "carried-history"), undefined, "12K is a normal prompt, not a problem");

  const big = allDiagnoses(ctx({ session: { history: { last: 140_000, peak: 200_000 } } })).find((x) => x.id === "carried-history");
  assert.ok(big);
  assert.match(big.line, /re-sends 140\.0K tokens of history/);
  assert.match(big.line, /over 20 prompts/);
});

test("a quiet premium run is priced by what that run cost, not by turn count", () => {
  // 22 turns out of 1,200 is not a crisis; 22 out of 40 is most of the session.
  // Scoring on the model's share of turns would call both the same.
  const big = allDiagnoses(
    ctx({ session: { cost: 400, assistantTurns: 1200, modelTurns: { "claude-opus-5": 1200 }, models: { "claude-opus-5": 400 }, longestQuietRun: { model: "claude-opus-5", turns: 22, outputCap: 1000 } } }),
  ).find((x) => x.id === "quiet-premium");
  const small = allDiagnoses(
    ctx({ session: { cost: 5, assistantTurns: 40, modelTurns: { "claude-opus-5": 40 }, models: { "claude-opus-5": 5 }, longestQuietRun: { model: "claude-opus-5", turns: 22, outputCap: 1000 } } }),
  ).find((x) => x.id === "quiet-premium");

  assert.ok(small.share > big.share * 10, `small ${small.share} should dwarf big ${big.share}`);
  assert.match(small.line, /ran 22 turns in a row/);
  assert.match(small.line, /of work/);
});

test("a quiet run on a cheap model is not a finding", () => {
  const d = allDiagnoses(
    ctx({ session: { modelTurns: { "claude-sonnet-5": 40 }, models: { "claude-sonnet-5": 5 }, longestQuietRun: { model: "claude-sonnet-5", turns: 30, outputCap: 1000 } } }),
  );
  assert.equal(d.find((x) => x.id === "quiet-premium"), undefined);
});

test("Claude Code's own attribution is measured, but names a habit", () => {
  const d = allDiagnoses(
    ctx({ attribution: { windows: [{ label: "Last 7d", requests: 100, behaviours: [{ percent: 80, text: "of your usage came from sessions active for 8+ hours" }] }] } }),
  ).find((x) => x.id === "attributed");
  assert.equal(d.confidence, CONFIDENCE.measured, "it is the source's own accounting");
  assert.equal(d.leverage, LEVERAGE.habit, "but changing it is a habit, not a switch");
  assert.match(d.action, /fresh session/);
});

test("a tool failing most of its calls is a finding whatever its size", () => {
  const d = allDiagnoses(ctx({ session: { toolCalls: { Bash: 900, "mcp__db__query": 6 }, toolErrorsByName: { "mcp__db__query": 6 } } })).find((x) => x.id === "failing-tools");
  assert.ok(d);
  assert.match(d.line, /failed 6 of its 6 calls/);

  const rare = allDiagnoses(ctx({ session: { toolCalls: { Bash: 900 }, toolErrorsByName: { Bash: 2 } } }));
  assert.equal(rare.find((x) => x.id === "failing-tools"), undefined, "two failures in 900 is a rate, not a fault");
});

test("leverage decides between two causes of similar size", () => {
  // A config change and a change of habit explaining the same share: the one
  // that takes ten seconds should win.
  const both = allDiagnoses(
    ctx({
      mcp: { configured: ["a"], called: {}, sizes: { servers: { a: { tokens: 20_000 } } }, daysSince: { a: 9 }, baseline: 40_000 },
      attribution: { windows: [{ label: "Last 7d", requests: 10, behaviours: [{ percent: 50, text: "of your usage came from sessions active for 8+ hours" }] }] },
    }),
  );
  const idle = both.find((x) => x.id === "idle-mcp");
  const habit = both.find((x) => x.id === "attributed");
  assert.equal(idle.share, habit.share, "same share");
  assert.ok(idle.score > habit.score, "but the setting outranks the habit");
});

test("nothing convincing means no cause, not a weak one", () => {
  assert.equal(bestDiagnosis(ctx()), null);
  // And the floor is where that line sits.
  const weak = ctx({ mcp: { configured: ["a"], called: {}, sizes: { servers: { a: { tokens: 500 } } }, daysSince: { a: 1 }, baseline: 40_000 } });
  assert.equal(bestDiagnosis(weak), null, "1% of the prefix is not worth a sentence");
  assert.ok(bestDiagnosis(weak, { floor: 0.001 }), "unless you lower the bar");
});

test("one broken diagnosis does not cost the nudge", () => {
  // Everything here reads undocumented shapes; a throw must lose one sentence,
  // never the notification.
  const broken = { get session() { throw new Error("boom"); } };
  assert.doesNotThrow(() => allDiagnoses(broken));
  assert.doesNotThrow(() => bestDiagnosis(broken));
});
