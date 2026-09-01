import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readPlan, planName, paysPerToken, tightestLimit } from "../src/plan.mjs";
import { windowRules, limitSteps } from "../src/rules.mjs";
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
