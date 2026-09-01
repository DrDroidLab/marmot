import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionRules, windowRules, evaluate, areasOf, longestGapMins } from "../src/rules.mjs";
import { DEFAULTS } from "../src/config.mjs";
import { fakeSession } from "./helpers.mjs";

const cfg = DEFAULTS;
const rule = (id) => sessionRules.find((r) => r.id === id);
const check = (id, over) => rule(id).check(fakeSession(over), cfg);

/* ── session-turns ─────────────────────────────────────────────────────── */

test("session-turns fires on a long session that never compacted", () => {
  const hit = check("session-turns", { typedPrompts: 25, compactions: 0, cost: 10 });
  assert.ok(hit);
  assert.match(hit.detail, /25 prompts/);
  assert.match(hit.action, /fresh session|compact/);
});

test("session-turns stays quiet when the session did compact", () => {
  // Length alone is not the problem; length without a context reset is.
  assert.equal(check("session-turns", { typedPrompts: 25, compactions: 1, cost: 10 }), null);
});

test("session-turns respects the sample and dollar guards", () => {
  assert.equal(check("session-turns", { typedPrompts: 20, cost: 10 }), null, "at the cap, not past it");
  assert.equal(check("session-turns", { typedPrompts: 25, cost: 0.5 }), null, "below the dollar floor");
});

/* ── session-cost ──────────────────────────────────────────────────────── */

test("session-cost fires only past the cap", () => {
  assert.equal(check("session-cost", { cost: 25 }), null);
  const hit = check("session-cost", { cost: 26 });
  assert.ok(hit);
  assert.match(hit.detail, /\$26\.00/);
});

/* ── premium-light-work ────────────────────────────────────────────────── */

const light = (over) => check("premium-light-work", over);

test("premium-light-work fires when a premium model did very little", () => {
  const hit = light({ cost: 10, models: { "claude-opus-5": 10 }, totalToolCalls: 5 });
  assert.ok(hit);
  assert.match(hit.detail, /5 tool calls/);
  assert.match(hit.action, /Sonnet/);
});

test("premium-light-work fires when every file touched was docs or tests", () => {
  const hit = light({
    cost: 10,
    models: { "claude-opus-5": 10 },
    totalToolCalls: 30,
    filesTouched: new Set(["/repo/README.md", "/repo/docs/guide.md", "/repo/tests/test_foo.py", "/repo/src/a.test.ts"]),
  });
  assert.ok(hit);
  assert.match(hit.detail, /documentation, tests or markdown \(4\)/);
});

test("premium-light-work matches path segments, not substrings", () => {
  // The trap: a raw includes("test") calls /latest/ a test dir, and
  // includes("doc") calls ~/Documents/ documentation.
  const notLight = light({
    cost: 10,
    models: { "claude-opus-5": 10 },
    totalToolCalls: 30,
    filesTouched: new Set(["/repo/latest/main.py", "/Users/me/Documents/app/server.rb"]),
  });
  assert.equal(notLight, null);
});

test("premium-light-work ignores a session that touched real source", () => {
  assert.equal(
    light({ cost: 10, models: { "claude-opus-5": 10 }, totalToolCalls: 30, filesTouched: new Set(["/repo/README.md", "/repo/src/server.ts"]) }),
    null,
  );
});

test("premium-light-work has a size ceiling whatever landed on disk", () => {
  // A 900-call session is not light work even if only markdown was written.
  assert.equal(light({ cost: 50, models: { "claude-opus-5": 50 }, totalToolCalls: 900, filesTouched: new Set(["/repo/README.md"]) }), null);
});

test("premium-light-work respects the premium share and dollar floor", () => {
  assert.equal(light({ cost: 10, models: { "claude-sonnet-5": 10 }, totalToolCalls: 5 }), null, "not a premium session");
  assert.equal(light({ cost: 0.5, models: { "claude-opus-5": 0.5 }, totalToolCalls: 5 }), null, "below the floor");
  // 60% premium is under the 70% share threshold.
  assert.equal(light({ cost: 10, models: { "claude-opus-5": 6, "claude-sonnet-5": 4 }, totalToolCalls: 5 }), null);
});

test("premium-light-work says nothing about a session that touched no files and worked hard", () => {
  assert.equal(light({ cost: 10, models: { "claude-opus-5": 10 }, totalToolCalls: 30, filesTouched: new Set() }), null);
});

/* ── cache-hit ─────────────────────────────────────────────────────────── */

test("cache-hit fires on a low rate over enough turns", () => {
  const hit = check("cache-hit", { assistantTurns: 50, cacheHitRate: 0.4 });
  assert.ok(hit);
  assert.match(hit.detail, /40%/);
});

test("cache-hit needs the minimum sample and a rate below the floor", () => {
  assert.equal(check("cache-hit", { assistantTurns: 10, cacheHitRate: 0.1 }), null, "too few turns");
  assert.equal(check("cache-hit", { assistantTurns: 50, cacheHitRate: 0.9 }), null, "healthy");
  assert.equal(check("cache-hit", { assistantTurns: 50, cacheHitRate: null }), null, "unknown is not low");
});

/* ── tool-errors ───────────────────────────────────────────────────────── */

test("tool-errors fires past the rate over enough calls", () => {
  const hit = check("tool-errors", { totalToolCalls: 100, toolErrors: 30, toolErrorRate: 0.3 });
  assert.ok(hit);
  assert.match(hit.detail, /30 of 100/);
});

test("tool-errors needs the minimum sample", () => {
  assert.equal(check("tool-errors", { totalToolCalls: 5, toolErrors: 5, toolErrorRate: 1 }), null);
  assert.equal(check("tool-errors", { totalToolCalls: 100, toolErrors: 5, toolErrorRate: 0.05 }), null);
});

/* ── every rule carries all three guards ───────────────────────────────── */

test("no rule fires on an ordinary small session", () => {
  // The regression this guards: without a ratio gap, a minimum sample and a
  // dollar floor, these checks fired on nearly every session and got muted.
  const ordinary = fakeSession({ typedPrompts: 8, cost: 2, assistantTurns: 30, totalToolCalls: 25, toolErrors: 1, toolErrorRate: 0.04, cacheHitRate: 0.95 });
  for (const r of sessionRules) assert.equal(r.check(ordinary, cfg), null, `${r.id} should be quiet`);
});

test("no rule fires on a trivial session, whatever its ratios look like", () => {
  const trivial = fakeSession({ typedPrompts: 30, cost: 0.2, assistantTurns: 3, totalToolCalls: 2, toolErrors: 1, toolErrorRate: 0.5, cacheHitRate: 0.1, models: { "claude-opus-5": 0.2 } });
  for (const r of sessionRules) assert.equal(r.check(trivial, cfg), null, `${r.id} should be quiet`);
});

test("every rule returns the same shape", () => {
  const loud = fakeSession({ typedPrompts: 60, cost: 200, assistantTurns: 300, totalToolCalls: 5, toolErrors: 3, toolErrorRate: 0.6, cacheHitRate: 0.2, models: { "claude-opus-5": 200 } });
  for (const r of sessionRules) {
    const hit = r.check(loud, cfg);
    if (!hit) continue;
    assert.equal(typeof hit.detail, "string", `${r.id} detail`);
    assert.equal(typeof hit.action, "string", `${r.id} action`);
    assert.ok(hit.detail.length && hit.action.length);
  }
});

/* ── session-topics ────────────────────────────────────────────────────── */

const dirs = (spec) => Object.fromEntries(Object.entries(spec).map(([dir, v]) => [dir, { dir, ...v }]));
const daysApart = (n) => ["2026-09-01T09:00:00.000Z", new Date(Date.parse("2026-09-01T09:00:00.000Z") + n * 86_400_000).toISOString()];

test("areasOf groups by top-level directory, relative to the working directory", () => {
  const s = fakeSession({
    cwd: "/repo",
    dirTouches: dirs({ "backend/app": { count: 4, firstTurn: 1, lastTurn: 40 }, "backend/lib": { count: 2, firstTurn: 5, lastTurn: 30 }, frontend: { count: 3, firstTurn: 50, lastTurn: 90 } }),
  });
  const areas = areasOf(s, cfg);
  assert.deepEqual(areas.map((a) => a.area), ["backend", "frontend"]);
  assert.equal(areas[0].count, 6, "backend/app and backend/lib are one project");
  assert.equal(areas[0].lastTurn, 40);
});

test("areasOf ignores edits outside the working directory", () => {
  // Scratch files and other checkouts are recorded as absolute paths. They are
  // noise, not an area of this session's work.
  const s = fakeSession({
    cwd: "/repo",
    dirTouches: dirs({ backend: { count: 3, firstTurn: 1, lastTurn: 10 }, "/private/tmp": { count: 5, firstTurn: 2, lastTurn: 8 }, "/Users/me/other": { count: 4, firstTurn: 3, lastTurn: 9 } }),
  });
  assert.deepEqual(areasOf(s, cfg).map((a) => a.area), ["backend"]);
});

test("areasOf on a session with no working directory judges nothing", () => {
  assert.deepEqual(areasOf(fakeSession({ cwd: null, dirTouches: dirs({ a: { count: 9, firstTurn: 1, lastTurn: 2 } }) }), cfg), []);
});

test("longestGapMins finds the biggest pause, and copes with junk", () => {
  assert.equal(longestGapMins(["2026-09-01T10:00:00Z", "2026-09-01T10:30:00Z", "2026-09-03T10:30:00Z"]), 2880);
  assert.equal(longestGapMins([]), 0);
  assert.equal(longestGapMins(["2026-09-01T10:00:00Z"]), 0);
  assert.equal(longestGapMins(["not a date", "also not"]), 0);
});

const topics = (over) => check("session-topics", over);

test("session-topics fires on a long session resumed days later in another area", () => {
  const hit = topics({
    typedPrompts: 30,
    cost: 80,
    compactions: 0,
    cwd: "/repo",
    promptTimes: daysApart(3),
    dirTouches: dirs({ backend: { count: 4, firstTurn: 1, lastTurn: 40 }, frontend: { count: 3, firstTurn: 50, lastTurn: 90 } }),
  });
  assert.ok(hit);
  assert.match(hit.detail, /3\.0d gap/);
  assert.match(hit.detail, /2 areas: backend, frontend/);
  assert.match(hit.action, /still in context/);
});

test("session-topics stays quiet without a real gap", () => {
  // Same session, resumed after lunch rather than after a day.
  assert.equal(
    topics({
      typedPrompts: 30,
      cost: 80,
      cwd: "/repo",
      promptTimes: ["2026-09-01T10:00:00Z", "2026-09-01T11:00:00Z"],
      dirTouches: dirs({ backend: { count: 4, firstTurn: 1, lastTurn: 40 }, frontend: { count: 3, firstTurn: 50, lastTurn: 90 } }),
    }),
    null,
  );
});

test("session-topics stays quiet when the gap led back to the same work", () => {
  assert.equal(
    topics({
      typedPrompts: 30,
      cost: 80,
      cwd: "/repo",
      promptTimes: daysApart(3),
      dirTouches: dirs({ backend: { count: 9, firstTurn: 1, lastTurn: 90 } }),
    }),
    null,
    "one area is one piece of work, however long you took over it",
  );
});

test("session-topics carries the three guards", () => {
  const base = {
    typedPrompts: 30,
    cost: 80,
    cwd: "/repo",
    promptTimes: daysApart(3),
    dirTouches: dirs({ backend: { count: 4, firstTurn: 1, lastTurn: 40 }, frontend: { count: 3, firstTurn: 50, lastTurn: 90 } }),
  };
  assert.equal(topics({ ...base, typedPrompts: 5 }), null, "too few prompts");
  assert.equal(topics({ ...base, cost: 0.2 }), null, "below the dollar floor");
  assert.equal(topics({ ...base, compactions: 2 }), null, "it already reset its context");
});

test("session-topics ignores an area only glanced at", () => {
  assert.equal(
    topics({
      typedPrompts: 30,
      cost: 80,
      cwd: "/repo",
      promptTimes: daysApart(3),
      dirTouches: dirs({ backend: { count: 9, firstTurn: 1, lastTurn: 90 }, docs: { count: 1, firstTurn: 44, lastTurn: 44 } }),
    }),
    null,
  );
});

/* ── window rules ──────────────────────────────────────────────────────── */

const day = (d, cost) => fakeSession({ id: `s-${d}-${cost}`, day: d, cost });

test("daily-cost fires on today's total, not the window's", () => {
  const sessions = [day("2026-09-01", 40), day("2026-09-01", 20), day("2026-08-31", 500)];
  const out = windowRules(sessions, cfg, { today: "2026-09-01", includeMcp: false });
  const hit = out.find((w) => w.id === "daily-cost");
  assert.ok(hit);
  assert.match(hit.detail, /\$60\.00 so far today across 2 sessions/);
  assert.deepEqual(hit.sessions.length, 2);
});

test("daily-cost pluralises a single session correctly", () => {
  const out = windowRules([day("2026-09-01", 60)], cfg, { today: "2026-09-01", includeMcp: false });
  assert.match(out.find((w) => w.id === "daily-cost").detail, /across 1 session,/);
});

test("daily-cost stays quiet under the cap and on a day with no sessions", () => {
  assert.equal(windowRules([day("2026-09-01", 10)], cfg, { today: "2026-09-01", includeMcp: false }).length, 0);
  assert.equal(windowRules([day("2026-08-31", 500)], cfg, { today: "2026-09-01", includeMcp: false }).length, 0);
});

test("daily-baseline fires when today is well past your own trailing average", () => {
  const sessions = [];
  for (let i = 1; i <= 10; i += 1) sessions.push(day(`2026-08-${String(i).padStart(2, "0")}`, 10 + (i % 2)));
  sessions.push(day("2026-09-01", 300));
  const out = windowRules(sessions, cfg, { today: "2026-09-01", includeMcp: false });
  const hit = out.find((w) => w.id === "daily-baseline");
  assert.ok(hit);
  assert.match(hit.detail, /against a 10-day average/);
  assert.match(hit.detail, /2\.5σ/);
});

test("daily-baseline needs enough prior days and a dollar floor", () => {
  const few = [day("2026-08-30", 10), day("2026-08-31", 10), day("2026-09-01", 300)];
  assert.equal(windowRules(few, cfg, { today: "2026-09-01", includeMcp: false }).find((w) => w.id === "daily-baseline"), undefined);

  const cheapToday = [];
  for (let i = 1; i <= 10; i += 1) cheapToday.push(day(`2026-08-${String(i).padStart(2, "0")}`, 0.1));
  cheapToday.push(day("2026-09-01", 5));
  assert.equal(
    windowRules(cheapToday, cfg, { today: "2026-09-01", includeMcp: false }).find((w) => w.id === "daily-baseline"),
    undefined,
    "a $5 day is not worth a word, however unusual",
  );
});

test("daily-baseline does not fire on a flat history with no variance", () => {
  // sd === 0 would make every above-average day infinitely unusual.
  const sessions = [];
  for (let i = 1; i <= 10; i += 1) sessions.push(day(`2026-08-${String(i).padStart(2, "0")}`, 10));
  sessions.push(day("2026-09-01", 11));
  assert.equal(windowRules(sessions, cfg, { today: "2026-09-01", includeMcp: false }).find((w) => w.id === "daily-baseline"), undefined);
});

test("mcp-idle names servers configured but never called", () => {
  const sessions = [fakeSession({ mcpCalls: { github: 4 } })];
  const out = windowRules(sessions, cfg, { today: "2026-09-01", configured: ["github", "sentry", "postgres"] });
  const hit = out.find((w) => w.id === "mcp-idle");
  assert.ok(hit);
  assert.match(hit.detail, /sentry, postgres/);
  assert.doesNotMatch(hit.detail, /github/);
});

test("mcp-idle is quiet when every configured server was used", () => {
  const sessions = [fakeSession({ mcpCalls: { github: 1, sentry: 2 } })];
  assert.equal(windowRules(sessions, cfg, { today: "2026-09-01", configured: ["github", "sentry"] }).find((w) => w.id === "mcp-idle"), undefined);
});

test("mcp-idle is skipped for lightweight records that carry no mcpCalls", () => {
  // Without the guard, an absent field makes every configured server look idle.
  const out = windowRules([{ day: "2026-09-01", cost: 1 }], cfg, { today: "2026-09-01", includeMcp: false, configured: ["github"] });
  assert.equal(out.find((w) => w.id === "mcp-idle"), undefined);
});

test("premium-window names a habit rather than one session", () => {
  const light = (id) => fakeSession({ id, day: "2026-08-20", cost: 5, models: { "claude-opus-5": 5 }, totalToolCalls: 4 });
  const sessions = [light("a"), light("b"), light("c"), light("d"), light("e"), fakeSession({ id: "big", cost: 50, totalToolCalls: 500 })];
  const hit = windowRules(sessions, cfg, { today: "2026-09-01", includeMcp: false }).find((w) => w.id === "premium-window");
  assert.ok(hit);
  assert.match(hit.detail, /5 of 6 sessions/);
  assert.match(hit.detail, /\$25\.00 in total/);
  assert.equal(hit.sessions.length, 5, "the sessions behind it are traceable");
});

test("premium-window needs a habit, not one or two sessions", () => {
  const light = (id) => fakeSession({ id, cost: 5, models: { "claude-opus-5": 5 }, totalToolCalls: 4 });
  assert.equal(windowRules([light("a"), light("b")], cfg, { today: "2026-09-01", includeMcp: false }).find((w) => w.id === "premium-window"), undefined);
});

test("premium-window ignores sessions that did real work", () => {
  const heavy = (id) => fakeSession({ id, cost: 20, models: { "claude-opus-5": 20 }, totalToolCalls: 200 });
  const sessions = [heavy("a"), heavy("b"), heavy("c"), heavy("d"), heavy("e"), heavy("f")];
  assert.equal(windowRules(sessions, cfg, { today: "2026-09-01", includeMcp: false }).find((w) => w.id === "premium-window"), undefined);
});

test("mcp-idle quotes measured tokens once an audit has been run", () => {
  const sessions = [fakeSession({ mcpCalls: { github: 4 }, baselineTokens: 40_000 })];
  const hit = windowRules(sessions, cfg, {
    today: "2026-09-01",
    configured: ["github", "sentry"],
    mcpSizes: { servers: { sentry: { count: 14, tokens: 4000 } } },
  }).find((w) => w.id === "mcp-idle");
  assert.ok(hit);
  assert.match(hit.detail, /~4,000 tokens/);
  assert.match(hit.detail, /10% of your 40\.0K median session prefix/);
  assert.match(hit.action, /straight saving/);
});

test("mcp-idle falls back to the baseline when nothing has been measured", () => {
  const sessions = [fakeSession({ mcpCalls: {}, baselineTokens: 35_000 })];
  const hit = windowRules(sessions, cfg, { today: "2026-09-01", configured: ["sentry"] }).find((w) => w.id === "mcp-idle");
  assert.ok(hit);
  assert.match(hit.detail, /35\.0K of prefix/);
  assert.match(hit.action, /mcp-audit/, "and says how to get the real number");
});

test("mcp-idle says the plain thing when there is no baseline either", () => {
  const sessions = [fakeSession({ mcpCalls: {}, baselineTokens: null })];
  const hit = windowRules(sessions, cfg, { today: "2026-09-01", configured: ["sentry"] }).find((w) => w.id === "mcp-idle");
  assert.ok(hit);
  assert.match(hit.detail, /not invoked once/);
});

/* ── evaluate ──────────────────────────────────────────────────────────── */

test("evaluate groups session hits by rule and carries the sessions behind them", () => {
  const sessions = [
    fakeSession({ id: "a", cost: 100 }),
    fakeSession({ id: "b", cost: 200 }),
    fakeSession({ id: "c", cost: 1 }),
  ];
  const { sessionNudges } = evaluate(sessions, cfg, { today: "2026-09-01", includeMcp: false });
  const costRule = sessionNudges.find((g) => g.id === "session-cost");
  assert.equal(costRule.hits.length, 2);
  assert.deepEqual(costRule.hits.map((h) => h.session.id), ["a", "b"]);
  assert.equal(typeof costRule.label, "string");
});

test("evaluate honours the `only` filter for both rule kinds", () => {
  const sessions = [fakeSession({ id: "a", cost: 100, typedPrompts: 40, day: "2026-09-01" })];
  const { sessionNudges, windowNudges } = evaluate(sessions, cfg, { today: "2026-09-01", only: ["session-cost"], configured: ["idle-server"] });
  assert.deepEqual(sessionNudges.map((g) => g.id), ["session-cost"]);
  assert.deepEqual(windowNudges, [], "mcp-idle was not asked for");
});

test("evaluate can judge one session while window rules see the whole window", () => {
  // The digest reports on yesterday, but "never called" is only true against
  // the full window.
  const yesterday = [fakeSession({ id: "y", day: "2026-08-31", mcpCalls: {} })];
  const wide = [...yesterday, fakeSession({ id: "t", day: "2026-09-01", mcpCalls: { github: 1 } })];
  const { windowNudges } = evaluate(yesterday, cfg, { today: "2026-09-01", windowSessions: wide, configured: ["github"] });
  assert.equal(windowNudges.find((w) => w.id === "mcp-idle"), undefined, "github was called, just not yesterday");
});

test("evaluate returns empty results for no sessions", () => {
  const { sessionNudges, windowNudges } = evaluate([], cfg, { today: "2026-09-01", includeMcp: false });
  assert.deepEqual(sessionNudges, []);
  assert.deepEqual(windowNudges, []);
});
