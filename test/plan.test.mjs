import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readPlan, planName, paysPerToken, tightestLimit, usableLimits, limitsExpired, worthRefreshing, refreshUsage, limitPace, parseUsageOutput, readAttribution, attributionPath } from "../src/plan.mjs";
import { windowRules, limitSteps, sessionRules, evaluate } from "../src/rules.mjs";
import { DEFAULTS } from "../src/config.mjs";
import { tmpRoot } from "./helpers.mjs";

/** Writes `<root>.json`, which is where Claude Code keeps this. */
const writeAccount = (root, obj) => writeFileSync(`${root}.json`, JSON.stringify(obj));

const utilization = (over = {}) => ({
  fetchedAtMs: Date.now(),
  utilization: {
    limits: [
      { kind: "session", group: "session", percent: 12, severity: "normal", resets_at: new Date(Date.now() + 3_600_000).toISOString(), is_active: true },
      { kind: "weekly_all", group: "weekly", percent: 40, severity: "normal", resets_at: new Date(Date.now() + 200_000_000).toISOString(), is_active: true },
    ],
    spend: { used: { amount_minor: 250, currency: "USD", exponent: 2 }, limit: { amount_minor: 5000, currency: "USD", exponent: 2 }, percent: 5, enabled: true },
    ...over,
  },
});

test("the rate-limit tier is turned into a plan name", () => {
  assert.equal(planName({ tier: "default_claude_max_20x" }), "Max 20×");
  assert.equal(planName({ tier: "default_claude_max_5x" }), "Max 5×");
  assert.equal(planName({ tier: "default_claude_pro" }), "Pro");
  assert.equal(planName({ tier: "some_team_tier" }), "Team");
  assert.equal(planName({ tier: "enterprise_whatever" }), "Enterprise");
});

test("an unrecognised tier falls back to the organisation type, then billing", () => {
  assert.equal(planName({ tier: "brand_new_tier_2027", orgType: "claude_max" }), "Max");
  assert.equal(planName({ tier: null, orgType: null, billing: "stripe_subscription" }), "subscription");
  assert.equal(planName({ tier: null, orgType: null, billing: null, hasOauth: false }), "API");
  assert.equal(planName({ tier: null, orgType: null, billing: null, hasOauth: true }), null);
});

test("only pay-as-you-go bills per token", () => {
  assert.equal(paysPerToken("API"), true);
  for (const p of ["Max 20×", "Pro", "Team", "Enterprise", "subscription", null]) assert.equal(paysPerToken(p), false);
});

test("the plan and its limits are read from the account file", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const claude = join(root, ".claude");
  writeAccount(claude, {
    oauthAccount: { organizationRateLimitTier: "default_claude_max_20x", organizationType: "claude_max", billingType: "stripe_subscription" },
    cachedUsageUtilization: utilization(),
  });

  const p = readPlan(claude, { env: {} });
  assert.equal(p.plan, "Max 20×");
  assert.equal(p.limits.length, 2);
  assert.deepEqual(p.limits.map((l) => l.label), ["5-hour session", "weekly"]);
  assert.equal(p.limits[1].percent, 40);
  assert.equal(p.stale, false, "just fetched");
  assert.deepEqual(p.spend, { used: 2.5, limit: 50, currency: "USD", enabled: true, percent: 5 });
});

test("an API key wins over whatever account is signed in", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const claude = join(root, ".claude");
  writeAccount(claude, { oauthAccount: { organizationRateLimitTier: "default_claude_max_20x" } });
  // Those tokens are billed per token whatever the account says.
  assert.equal(readPlan(claude, { env: { ANTHROPIC_API_KEY: "sk-x" } }).plan, "API");
  assert.equal(readPlan(claude, { env: {} }).plan, "Max 20×");
});

test("a stale snapshot is reported as stale, with its age", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const claude = join(root, ".claude");
  const old = utilization();
  old.fetchedAtMs = Date.now() - 5 * 3_600_000;
  writeAccount(claude, { oauthAccount: {}, cachedUsageUtilization: old });

  const p = readPlan(claude, { env: {} });
  assert.equal(p.stale, true);
  assert.ok(p.ageMins > 290 && p.ageMins < 310, `age was ${p.ageMins}`);
});

test("the older named-window shape is still understood", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const claude = join(root, ".claude");
  writeAccount(claude, {
    oauthAccount: {},
    cachedUsageUtilization: { fetchedAtMs: Date.now(), utilization: { five_hour: { utilization: 7 }, seven_day: { utilization: 55 } } },
  });
  const p = readPlan(claude, { env: {} });
  assert.deepEqual(p.limits.map((l) => [l.label, l.percent]), [["5-hour session", 7], ["weekly", 55]]);
});

test("a missing or malformed account file costs the plan, not the report", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const claude = join(root, ".claude");
  assert.deepEqual(readPlan(claude, { env: {} }).limits, []);
  assert.equal(readPlan(claude, { env: {} }).plan, null);

  writeFileSync(`${claude}.json`, "{ not json");
  assert.equal(readPlan(claude, { env: {} }).plan, null);
});

test("tightestLimit picks the one closest to being reached", () => {
  assert.equal(tightestLimit([{ percent: 12 }, { percent: 88 }, { percent: 40 }]).percent, 88);
  assert.equal(tightestLimit([]), null);
});

/* ── the nudge ─────────────────────────────────────────────────────────── */

const planAt = (session, weekly) => ({
  plan: "Max 20×",
  ageMins: 2,
  limits: [
    { kind: "session", label: "5-hour session", percent: session, severity: "normal", resetsAt: new Date(Date.now() + 3_600_000).toISOString(), active: true },
    { kind: "weekly_all", label: "weekly", percent: weekly, severity: "normal", resetsAt: new Date(Date.now() + 200_000_000).toISOString(), active: true },
  ],
});

test("the marks come from the plan, and fall back to the shared default", () => {
  assert.deepEqual(limitSteps(DEFAULTS, "Max 20×"), [50, 75, 90]);
  assert.deepEqual(limitSteps(DEFAULTS, "API"), [], "no limit to run out of");
  assert.deepEqual(limitSteps(DEFAULTS, "A Plan From 2028"), [50, 75, 90], "unknown plans use the default");
  assert.deepEqual(limitSteps({ limits: { steps: [90, 50] } }, null), [50, 90], "sorted, so 'highest passed' means it");
  assert.deepEqual(limitSteps({}, null), []);
});

test("limit-reached speaks at the highest mark a window has passed", () => {
  const at = (pct) => ({
    plan: "Max 20×",
    ageMins: 2,
    limits: [{ kind: "weekly_all", label: "weekly", percent: pct, resetsAt: new Date(Date.now() + 200_000_000).toISOString(), active: true }],
  });
  const keyAt = (pct) => windowRules([], DEFAULTS, { today: "2026-09-01", includeMcp: false, plan: at(pct) }).find((w) => w.id === "limit-reached")?.key;

  assert.equal(keyAt(40), undefined, "below every mark");
  assert.equal(keyAt(50), "limit-reached:weekly_all:50", "exactly on a mark counts as passed");
  assert.equal(keyAt(74), "limit-reached:weekly_all:50");
  assert.equal(keyAt(76), "limit-reached:weekly_all:75");
  assert.equal(keyAt(100), "limit-reached:weekly_all:90", "past the last mark, it stays the last mark");

  // Only the last mark takes the screen. 50% and 75% are information you can
  // read when you look; 90% is the one with nothing after it.
  const urgentAt = (pct) => windowRules([], DEFAULTS, { today: "2026-09-01", includeMcp: false, plan: at(pct) }).find((w) => w.id === "limit-reached")?.urgent;
  assert.equal(urgentAt(50), false);
  assert.equal(urgentAt(76), false);
  assert.equal(urgentAt(90), true);
  assert.equal(urgentAt(100), true);
});

test("the key is what makes each mark speak once and the next one news", () => {
  // The state file dedupes on this key, so 76% is a new thing to say after 52%
  // while a second reading of 77% is not.
  const at = (pct) => ({ plan: "Max 20×", ageMins: 2, limits: [{ kind: "weekly_all", label: "weekly", percent: pct, resetsAt: null, active: true }] });
  const k = (pct) => windowRules([], DEFAULTS, { today: "2026-09-01", includeMcp: false, plan: at(pct) })[0].key;
  assert.equal(k(52), k(74), "same mark, same key, said once");
  assert.notEqual(k(74), k(76), "a new mark is a new key");
});

test("each window is judged on its own mark", () => {
  const plan = {
    plan: "Max 20×",
    ageMins: 2,
    limits: [
      { kind: "session", label: "5-hour session", percent: 95, resetsAt: new Date(Date.now() + 3_600_000).toISOString(), active: true },
      { kind: "weekly_all", label: "weekly", percent: 55, resetsAt: new Date(Date.now() + 200_000_000).toISOString(), active: true },
    ],
  };
  const hits = windowRules([], DEFAULTS, { today: "2026-09-01", includeMcp: false, plan }).filter((w) => w.id === "limit-reached");
  assert.deepEqual(hits.map((h) => h.key), ["limit-reached:session:90", "limit-reached:weekly_all:50"]);
  assert.match(hits[0].action, /5-hour window refills/);
  assert.match(hits[1].action, /before the week is out/);
});

test("the marks are yours to move, per plan", () => {
  const plan = { plan: "Pro", ageMins: 2, limits: [{ kind: "weekly_all", label: "weekly", percent: 30, resetsAt: null, active: true }] };
  assert.equal(windowRules([], DEFAULTS, { today: "2026-09-01", includeMcp: false, plan }).length, 0);

  const eager = { ...DEFAULTS, limits: { ...DEFAULTS.limits, byPlan: { ...DEFAULTS.limits.byPlan, Pro: [25, 50] } } };
  assert.equal(windowRules([], eager, { today: "2026-09-01", includeMcp: false, plan })[0].key, "limit-reached:weekly_all:25");

  const off = { ...DEFAULTS, limits: { ...DEFAULTS.limits, enabled: false } };
  assert.equal(windowRules([], off, { today: "2026-09-01", includeMcp: false, plan: { plan: "Pro", ageMins: 2, limits: [{ kind: "weekly_all", label: "weekly", percent: 99, active: true }] } }).length, 0);
});

test("a stale snapshot says so rather than reading as current", () => {
  const plan = { plan: "Max 20×", ageMins: 240, limits: [{ kind: "weekly_all", label: "weekly", percent: 91, resetsAt: null, active: true }] };
  const hit = windowRules([], DEFAULTS, { today: "2026-09-01", includeMcp: false, plan }).find((w) => w.id === "limit-reached");
  assert.match(hit.detail, /as of 4\.0h ago/);
  assert.match(hit.detail, /Max 20×/);
});

test("no plan means no limit nudges at all", () => {
  for (const plan of [null, { plan: null, limits: [] }]) {
    assert.equal(windowRules([], DEFAULTS, { today: "2026-09-01", includeMcp: false, plan }).length, 0);
  }
});

/* ── dollars only mean something when you are billed per token ─────────── */

const bigDay = [
  { id: "a", day: "2026-09-01", cost: 300, models: { "claude-opus-5": 300 }, typedPrompts: 40, assistantTurns: 500, totalToolCalls: 400, toolErrors: 0, toolErrorRate: 0, cacheHitRate: 0.98, compactions: 0, mcpCalls: {}, skills: [], filesTouched: new Set(), dirTouches: {}, promptTimes: [], baselineTokens: 30000 },
  { id: "b", day: "2026-09-01", cost: 211, models: { "claude-opus-5": 211 }, typedPrompts: 30, assistantTurns: 400, totalToolCalls: 300, toolErrors: 0, toolErrorRate: 0, cacheHitRate: 0.98, compactions: 0, mcpCalls: {}, skills: [], filesTouched: new Set(), dirTouches: {}, promptTimes: [], baselineTokens: 30000 },
];
const opts = (plan) => ({ today: "2026-09-01", includeMcp: false, plan });

/** A plan that reports quota, which is what makes dollars the wrong ceiling. */
const withQuota = (name = "Max 20×") => ({
  plan: name,
  ageMins: 2,
  limits: [{ kind: "weekly_all", label: "weekly", percent: 10, resetsAt: new Date(Date.now() + 200_000_000).toISOString(), active: true }],
});

test("a subscription is not nudged about dollars it was never charged", () => {
  // $511 in a day on Max 20x is a Tuesday, not overspending. A rule that says
  // otherwise every day gets muted along with the ones worth reading.
  const max = withQuota();
  assert.equal(windowRules(bigDay, DEFAULTS, opts(max)).find((w) => w.id === "daily-cost"), undefined);

  const sessionCost = sessionRules.find((r) => r.id === "session-cost");
  assert.equal(sessionCost.check(bigDay[0], DEFAULTS, { plan: max }), null);
});

test("pay-as-you-go still gets both, because there the figure is the bill", () => {
  const api = { plan: "API", ageMins: 2, limits: [] };
  assert.ok(windowRules(bigDay, DEFAULTS, opts(api)).find((w) => w.id === "daily-cost"));
  assert.ok(sessionRules.find((r) => r.id === "session-cost").check(bigDay[0], DEFAULTS, { plan: api }));
});

test("an undetected plan is treated as billed, which is the safe way round", () => {
  // Better to mention a cost that turns out not to be charged than to stay
  // silent about one that is.
  for (const plan of [null, { plan: null, limits: [] }]) {
    assert.ok(windowRules(bigDay, DEFAULTS, opts(plan)).find((w) => w.id === "daily-cost"));
  }
});

test("a subscription still hears about waste, which is the point", () => {
  const max = withQuota();
  const wasteful = {
    ...bigDay[0],
    typedPrompts: 60,
    cacheHitRate: 0.2,
    toolErrors: 90,
    toolErrorRate: 0.3,
  };
  const ids = sessionRules.map((r) => [r.id, r.check(wasteful, DEFAULTS, { plan: max })]).filter(([, hit]) => hit).map(([id]) => id);
  // The waste rules became diagnoses; what a subscription still gets as its own
  // nudge is the shape of the session, and never the dollar cap.
  assert.ok(!ids.includes("session-cost"), "not the dollar cap");
});

test("evaluate passes the plan down to the session rules", () => {
  const max = withQuota();
  const onMax = evaluate(bigDay, DEFAULTS, { ...opts(max) });
  const onApi = evaluate(bigDay, DEFAULTS, { ...opts({ plan: "API", limits: [] }) });
  assert.equal(onMax.sessionNudges.find((g) => g.id === "session-cost"), undefined);
  assert.ok(onApi.sessionNudges.find((g) => g.id === "session-cost"));
});

/* ── expired windows, and refreshing them ──────────────────────────────── */

const withResets = (sessionResetsIn, weeklyResetsIn) => ({
  fetchedAtMs: Date.now(),
  utilization: {
    limits: [
      { kind: "session", percent: 5, resets_at: new Date(Date.now() + sessionResetsIn).toISOString(), is_active: true },
      { kind: "weekly_all", percent: 19, resets_at: new Date(Date.now() + weeklyResetsIn).toISOString(), is_active: true },
    ],
  },
});

test("a reading whose window has reset is expired, not merely stale", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const claude = join(root, ".claude");
  // Both windows rolled over hours ago: 5% describes a window nobody is in.
  writeAccount(claude, { oauthAccount: {}, cachedUsageUtilization: withResets(-3 * 3_600_000, -1 * 3_600_000) });

  const p = readPlan(claude, { env: {} });
  assert.deepEqual(p.limits.map((l) => l.expired), [true, true]);
  assert.deepEqual(usableLimits(p), [], "nothing here is worth acting on");
  assert.equal(limitsExpired(p), true);
});

test("a live window is usable, and its reading stands", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const claude = join(root, ".claude");
  writeAccount(claude, { oauthAccount: {}, cachedUsageUtilization: withResets(2 * 3_600_000, 4 * 86_400_000) });

  const p = readPlan(claude, { env: {} });
  assert.equal(limitsExpired(p), false);
  assert.equal(usableLimits(p).length, 2);
});

test("an expired reading never fires a nudge, however high it looks", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const claude = join(root, ".claude");
  const dead = withResets(-3_600_000, -3_600_000);
  dead.utilization.limits[1].percent = 95; // would be well past every mark
  writeAccount(claude, { oauthAccount: { organizationRateLimitTier: "default_claude_max_20x" }, cachedUsageUtilization: dead });

  const plan = readPlan(claude, { env: {} });
  const out = windowRules([], DEFAULTS, { today: "2026-09-01", includeMcp: false, plan });
  assert.equal(out.filter((w) => w.id === "limit-reached").length, 0, "a dead window says nothing about the live one");
});

test("worthRefreshing is true exactly when the cache cannot answer", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const claude = join(root, ".claude");

  writeAccount(claude, { oauthAccount: {}, cachedUsageUtilization: withResets(2 * 3_600_000, 4 * 86_400_000) });
  assert.equal(worthRefreshing(readPlan(claude, { env: {} })), false, "live and recent");

  writeAccount(claude, { oauthAccount: {}, cachedUsageUtilization: withResets(-3_600_000, -3_600_000) });
  assert.equal(worthRefreshing(readPlan(claude, { env: {} })), true, "windows have reset");

  const old = withResets(2 * 3_600_000, 4 * 86_400_000);
  old.fetchedAtMs = Date.now() - 5 * 3_600_000;
  writeAccount(claude, { oauthAccount: {}, cachedUsageUtilization: old });
  assert.equal(worthRefreshing(readPlan(claude, { env: {} })), true, "hours old");

  writeAccount(claude, { oauthAccount: {} });
  assert.equal(worthRefreshing(readPlan(claude, { env: {} })), true, "no snapshot at all");
});

test("refreshUsage asks Claude Code, and never throws when it cannot", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const claude = join(root, ".claude");
  writeAccount(claude, { oauthAccount: {}, cachedUsageUtilization: withResets(-3_600_000, -3_600_000) });

  // The command it runs is Claude Code's own, which is client-side and free.
  let called = null;
  refreshUsage(claude, { env: {}, run: (cmd, args) => { called = [cmd, ...args]; } });
  assert.deepEqual(called, ["claude", "-p", "/usage"]);

  const failed = refreshUsage(claude, { env: {}, run: () => { throw new Error("no claude on PATH"); } });
  assert.equal(failed.refreshed, false);
  assert.match(failed.reason, /could not run/);
});

test("refreshUsage reports whether the snapshot actually moved", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const claude = join(root, ".claude");
  writeAccount(claude, { oauthAccount: {}, cachedUsageUtilization: withResets(-3_600_000, -3_600_000) });

  // A run that changes nothing is not a refresh, and must not be reported as one.
  assert.equal(refreshUsage(claude, { env: {}, run: () => {} }).refreshed, false);

  // One that writes a newer snapshot is. The timestamp has to differ, or two
  // writes inside the same millisecond look like no change at all.
  const moved = refreshUsage(claude, {
    env: {},
    run: () => {
      const fresh = withResets(2 * 3_600_000, 4 * 86_400_000);
      fresh.fetchedAtMs = Date.now() + 5_000;
      writeAccount(claude, { oauthAccount: {}, cachedUsageUtilization: fresh });
    },
  });
  assert.equal(moved.refreshed, true);
  assert.equal(limitsExpired(moved.plan), false);
});

/* ── pace: a percentage means nothing without the clock beside it ──────── */

const weekly = (percent, daysLeft) => ({
  kind: "weekly_all",
  label: "weekly",
  percent,
  resetsAt: new Date(Date.now() + daysLeft * 86_400_000).toISOString(),
  active: true,
});

test("pace is share used over share elapsed", () => {
  // Half the week gone, half the allowance gone: exactly on track.
  const onTrack = limitPace(weekly(50, 3.5));
  assert.ok(Math.abs(onTrack.pace - 1) < 0.05, `pace was ${onTrack.pace}`);
  assert.equal(onTrack.exhaustsBeforeReset, false);

  // Same 50%, but only a fifth of the week gone: running out early.
  const fast = limitPace(weekly(50, 5.6));
  assert.ok(fast.pace > 2, `pace was ${fast.pace}`);
  assert.equal(fast.exhaustsBeforeReset, true);
});

test("pace needs a window length and a reset time it can trust", () => {
  assert.equal(limitPace({ kind: "unknown_window", percent: 50, resetsAt: new Date(Date.now() + 1000).toISOString() }), null);
  assert.equal(limitPace({ kind: "weekly_all", percent: 50, resetsAt: null }), null);
  assert.equal(limitPace(weekly(50, -1)), null, "a window that has passed has no pace");
  assert.equal(limitPace(weekly(50, 7)), null, "nothing has elapsed yet");
});

test("limit-pace fires when a window runs out before it resets", () => {
  const plan = { plan: "Max 20×", ageMins: 1, limits: [weekly(78, 4)] };
  const hit = windowRules([], DEFAULTS, { today: "2026-09-01", includeMcp: false, plan }).find((w) => w.id === "limit-pace");
  // Always urgent: it is the only nudge with a deadline inside it — the window
  // runs out before it resets, and only while it is still running can you act.
  assert.equal(hit.urgent, true);
  assert.ok(hit);
  assert.match(hit.detail, /through the weekly window with 78% of it gone/);
  assert.match(hit.detail, /the pace that would last/);
  assert.match(hit.detail, /before it resets/);
  assert.match(hit.action, /detach MCP servers/);
});

test("limit-pace carries all three guards", () => {
  const fire = (limit, cfg = DEFAULTS) =>
    windowRules([], cfg, { today: "2026-09-01", includeMcp: false, plan: { plan: "Max 20×", ageMins: 1, limits: [limit] } }).find((w) => w.id === "limit-pace");

  assert.equal(fire(weekly(50, 3.5)), undefined, "on pace is not a problem");
  assert.equal(fire(weekly(30, 6)), undefined, "too early in the window for a ratio to mean anything");
  assert.equal(fire(weekly(10, 6.2)), undefined, "below the floor, however steep the ratio");
  assert.ok(fire(weekly(78, 4)), "past all three");
});

test("limit-pace says nothing when you are nearly out but on track", () => {
  // 95% used with hours left is not a pace problem — limit-reached covers it,
  // and two nudges about the same thing is how both get muted.
  const plan = { plan: "Max 20×", ageMins: 1, limits: [weekly(95, 0.2)] };
  const out = windowRules([], DEFAULTS, { today: "2026-09-01", includeMcp: false, plan });
  assert.equal(out.find((w) => w.id === "limit-pace"), undefined);
  assert.ok(out.find((w) => w.id === "limit-reached"), "but the mark still speaks");
});

test("limit-pace re-speaks only when the pace itself worsens", () => {
  const key = (pct, days) =>
    windowRules([], DEFAULTS, { today: "2026-09-01", includeMcp: false, plan: { plan: "Max 20×", ageMins: 1, limits: [weekly(pct, days)] } }).find((w) => w.id === "limit-pace")?.key;
  assert.equal(key(78, 4), key(79, 4), "the same pace is the same news");
  assert.notEqual(key(78, 4), key(90, 4), "a steeper one is not");
});

test("an expired window has no pace either", () => {
  const plan = { plan: "Max 20×", ageMins: 1, limits: [{ ...weekly(90, 4), expired: true }] };
  assert.equal(windowRules([], DEFAULTS, { today: "2026-09-01", includeMcp: false, plan }).length, 0);
});

/* ── Claude Code's own attribution ─────────────────────────────────────── */

// Captured verbatim from `claude -p "/usage"`.
const USAGE_OUTPUT = `You are currently using your subscription to power your Claude Code usage

Current session: 3% used · resets Sep 2 at 4:29am (Asia/Calcutta)
Current week (all models): 0% used · resets Sep 8 at 10:29pm (Asia/Calcutta)
Current week (Fable): 0% used

What's contributing to your limits usage?
Approximate, based on local sessions on this machine — does not include other devices or claude.ai.

Last 24h · 976 requests · 13 sessions
  92% of your usage was at >150k context
  Top skills: /claude-api 2%, /dataviz 2%
  Top plugins: marmot 1%

Last 7d · 2,590 requests · 19 sessions
  96% of your usage was at >150k context
  80% of your usage came from sessions active for 8+ hours
  Top skills: /claude-api 1%
  Top MCP servers: sprinto 1%
`;

test("the attribution block is parsed into windows, behaviours and contributors", () => {
  const a = parseUsageOutput(USAGE_OUTPUT);
  assert.equal(a.windows.length, 2);

  const [day, week] = a.windows;
  assert.equal(day.label, "Last 24h");
  assert.equal(day.requests, 976);
  assert.equal(day.sessions, 13);
  assert.deepEqual(day.top.skills, [{ name: "claude-api", percent: 2 }, { name: "dataviz", percent: 2 }]);
  assert.deepEqual(day.top.plugins, [{ name: "marmot", percent: 1 }]);

  assert.equal(week.requests, 2590, "thousands separators are handled");
  assert.deepEqual(week.behaviours.map((b) => b.percent), [96, 80]);
  assert.match(week.behaviours[1].text, /sessions active for 8\+ hours/);
  assert.deepEqual(week.top["mcp-servers"], [{ name: "sprinto", percent: 1 }]);
});

test("a format change costs the section, not the report", () => {
  // Human-formatted text with no stability guarantee, so every line is optional
  // and anything unrecognised is skipped.
  assert.equal(parseUsageOutput(""), null);
  assert.equal(parseUsageOutput("something else entirely"), null);
  assert.equal(parseUsageOutput(null), null);

  const partial = parseUsageOutput("Last 7d · 100 requests\n  nonsense line\n  55% of your usage was odd");
  assert.equal(partial.windows[0].requests, 100);
  assert.equal(partial.windows[0].sessions, null, "sessions are optional");
  assert.deepEqual(partial.windows[0].behaviours, [{ percent: 55, text: "of your usage was odd" }]);
});

test("a saved attribution is read back, and a broken one is null", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  assert.equal(readAttribution(root), null);

  writeFileSync(attributionPath(root), JSON.stringify(parseUsageOutput(USAGE_OUTPUT)));
  assert.equal(readAttribution(root).windows.length, 2);

  writeFileSync(attributionPath(root), JSON.stringify({ windows: [] }));
  assert.equal(readAttribution(root), null, "no windows is not an attribution");

  writeFileSync(attributionPath(root), "{ broken");
  assert.equal(readAttribution(root), null);
});

test("a plan with no quota falls back to a dollar ceiling", () => {
  // Enterprise usually reports no percentages. Staying quiet there would leave
  // no budget at all, so money becomes the only ceiling available.
  const noQuota = { plan: "Enterprise", ageMins: 2, limits: [] };
  assert.ok(windowRules(bigDay, DEFAULTS, opts(noQuota)).find((w) => w.id === "daily-cost"));

  // And a plan whose quota reading has expired is in the same position.
  const expired = { plan: "Max 20×", ageMins: 2, limits: [{ kind: "weekly_all", label: "weekly", percent: 10, expired: true }] };
  assert.ok(windowRules(bigDay, DEFAULTS, opts(expired)).find((w) => w.id === "daily-cost"));

  // But while the quota is readable, the quota is the ceiling.
  assert.equal(windowRules(bigDay, DEFAULTS, opts(withQuota())).find((w) => w.id === "daily-cost"), undefined);
});
