import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionRules, windowRules, evaluate, areasOf, longestGapMins } from "../src/rules.mjs";
import { DEFAULTS } from "../src/config.mjs";
import { fakeSession } from "./helpers.mjs";

const cfg = DEFAULTS;
const rule = (id) => sessionRules.find((r) => r.id === id);
const check = (id, over) => rule(id).check(fakeSession(over), cfg);

/* ── session-cost ──────────────────────────────────────────────────────── */

test("session-cost fires only past the cap", () => {
  assert.equal(check("session-cost", { cost: 25 }), null);
  const hit = check("session-cost", { cost: 26 });
  assert.ok(hit);
  assert.match(hit.detail, /\$26\.00/);
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
