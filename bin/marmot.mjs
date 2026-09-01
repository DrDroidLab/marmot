#!/usr/bin/env node
/**
 * marmot — your own token consumption, read from the records Claude Code
 * already writes to this machine.
 *
 * Nothing is uploaded. No account, no key, no server. Works on Pro, Max and
 * Team plans, where none of the organisation APIs exist.
 *
 *   npx marmot              last 30 days
 *   npx marmot --days 7     last week
 *   npx marmot nudges       just what is worth knowing
 *   npx marmot init         write the threshold file (and offer a statusline)
 */

import { loadSessions, defaultRoot } from "../src/sessions.mjs";
import { loadConfig, DEFAULTS, configPath } from "../src/config.mjs";
import { evaluate } from "../src/rules.mjs";
import { renderReport, renderNudges, renderSessionList, totals } from "../src/render.mjs";
import { usd, num, pct, tokens, dim, bold, warn, good } from "../src/format.mjs";
import { writeFileSync, existsSync, readFileSync, statSync } from "node:fs";

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const has = (n) => argv.includes(`--${n}`);
const cmd = argv.find((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1]?.startsWith("--") !== true) ?? "report";

const ROOT = flag("root", defaultRoot());

/** A slash command that failed to substitute its argument must not become NaN. */
const posInt = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};
const DAYS = posInt(flag("days", 30), 30);

if (has("help") || cmd === "help") {
  process.stdout.write(`
  marmot — your own Claude Code token consumption, read locally.

  Commands
    report            Spend, sessions, models and nudges (default)
    browse            Build a local web page of your sessions and open it
    nudges            Only the nudges
    sessions          Every session in the window, one per line
    init              Write ${configPath(ROOT)} with the default thresholds
    config            Open that thresholds file (creating it if it is missing)
    mcp-audit         Ask each configured MCP server for its tools, and measure
                      what their definitions cost on every request
    doctor            What is readable on this machine, and what is not

  Flags
    --days <n>        Window, default 30
    --root <dir>      Claude Code home, default ~/.claude
    --json            Machine-readable output
    --demo            Run against synthetic sessions, not your own
    --statusline      With init: also install the statusline

  report only
    --sessions        List every session in the window under the report
    --no-browse       Do not build and open the session browser page
    --no-audit        Do not measure MCP servers, even with no recent figures
    --no-refresh      Do not refresh plan limits, even when the window has reset

  config only
    --print           Also print the file to the terminal
    --no-open         Show the path, do not open it

  mcp-audit only
    --timeout <s>     Per server, default 20
    --tools           List every tool, not just the totals

  browse only
    --limit <n>       Most recent N sessions, default 25
    --session <id>    Just this one
    --out <file>      Where to write, default ~/.claude/marmot/
    --no-text         Leave prompt and response text out of the page
    --no-open         Write it, do not open it

  Nothing here uploads. The report reads only counts, identifiers and tool
  names; browse reads your prompts and replies, into a local file.
`);
  process.exit(0);
}

const cfg = loadConfig(ROOT);

if (cmd === "init") {
  if (existsSync(cfg._path) && !has("force")) {
    process.stdout.write(`${cfg._path} already exists. Re-run with --force to overwrite.\n`);
  } else {
    const { _path, _exists, ...body } = { ...DEFAULTS };
    writeFileSync(cfg._path, JSON.stringify(body, null, 2) + "\n");
    process.stdout.write(`Wrote ${cfg._path}\n  Every threshold is in there. Edit freely — nothing else reads this file.\n`);
  }
  if (has("statusline")) {
    const sp = `${ROOT}/settings.json`;
    let settings = {};
    try {
      settings = JSON.parse(readFileSync(sp, "utf8"));
    } catch {
      /* absent or malformed; we write a fresh object below */
    }
    if (settings.statusLine && !has("force")) {
      process.stdout.write(`\n${sp} already defines a statusLine. Leaving it alone; re-run with --force to replace it.\n`);
    } else {
      const here = new URL("../scripts/statusline.mjs", import.meta.url).pathname;
      settings.statusLine = { type: "command", command: `node ${here}`, padding: 0 };
      writeFileSync(sp, JSON.stringify(settings, null, 2) + "\n");
      process.stdout.write(`\nInstalled the statusline in ${sp}. It shows this session's cost, prompts and cache hit rate.\n`);
    }
  }
  process.exit(0);
}

if (cmd === "config") {
  // The thresholds file is optional — everything runs on the defaults without
  // it. Create it on the way in, so "open the config" gives you something to
  // edit rather than an empty buffer.
  let created = false;
  if (!existsSync(cfg._path)) {
    const { _path, _exists, ...body } = { ...DEFAULTS };
    writeFileSync(cfg._path, JSON.stringify(body, null, 2) + "\n");
    created = true;
  }
  process.stdout.write(`${cfg._path}${created ? "  (created, with the defaults)" : ""}\n`);
  if (has("print")) process.stdout.write(`\n${readFileSync(cfg._path, "utf8")}`);

  if (!has("no-open")) {
    const { openInEditor } = await import("../src/open.mjs");
    const opened = openInEditor(cfg._path, { isTty: Boolean(process.stdout.isTTY) });
    if (!opened.wait) process.stdout.write(dim(`Opening in ${opened.source}.\n`));
  }
  process.exit(0);
}

if (cmd === "mcp-audit") {
  const { readServerConfigs, auditServers, auditPath } = await import("../src/mcp.mjs");
  const configs = readServerConfigs(ROOT, process.cwd());
  const names = Object.keys(configs);
  if (!names.length) {
    process.stdout.write(`No MCP servers configured in ${ROOT}/mcp.json, ${ROOT}/settings.json or ./.mcp.json\n`);
    process.exit(0);
  }

  const timeoutMs = posInt(flag("timeout", 20), 20) * 1000;
  process.stdout.write(
    `\n  Asking ${names.length} server${names.length === 1 ? "" : "s"} for their tools. This starts each one, so it takes a moment.\n\n`,
  );

  const rows = await auditServers(configs, {
    timeoutMs,
    onResult: (r) =>
      process.stdout.write(
        r.error ? `  ${dim("·")} ${r.name.padEnd(24)} ${dim(r.error)}\n` : `  ${good("✔")} ${r.name.padEnd(24)} ${dim(`${r.count} tools`)}\n`,
      ),
  });

  // What the window says about whether any of it was used.
  const seen = loadSessions({ root: ROOT, days: DAYS, rateOverrides: cfg.rateOverrides });
  const called = {};
  for (const s of seen) for (const [srv, n] of Object.entries(s.mcpCalls ?? {})) called[srv] = (called[srv] ?? 0) + n;

  const measured = rows.filter((r) => !r.error);
  const idle = measured.filter((r) => !called[r.name]);
  const wasted = idle.reduce((a, r) => a + r.tokens, 0);
  const total = measured.reduce((a, r) => a + r.tokens, 0);

  process.stdout.write(`\n  ${bold("Server".padEnd(24))}${bold("Tools".padStart(6))}${bold("Tokens".padStart(10))}${bold(`Calls (${DAYS}d)`.padStart(14))}\n`);
  for (const r of rows) {
    if (r.error) {
      process.stdout.write(`  ${r.name.padEnd(24)}${dim(r.error.padStart(30))}\n`);
      continue;
    }
    const calls = called[r.name] ?? 0;
    const line = `  ${r.name.padEnd(24)}${String(r.count).padStart(6)}${`~${tokens(r.tokens)}`.padStart(10)}${String(calls).padStart(14)}`;
    process.stdout.write(calls ? `${line}\n` : `${warn(line)}  ${warn("▲")}\n`);
  }

  if (has("tools")) {
    for (const r of measured) {
      process.stdout.write(`\n  ${bold(r.name)}\n`);
      for (const t of r.tools) process.stdout.write(`    ${t.name.padEnd(38)}${dim(`~${tokens(t.tokens)}`)}\n`);
    }
  }

  process.stdout.write(
    `\n  ${num(total)} tokens of tool definitions ride on every request.\n` +
      (idle.length
        ? `  ${warn(`~${num(wasted)} of them (${pct(total ? wasted / total : 0)}) belong to ${idle.length} server${idle.length === 1 ? "" : "s"} you have not called in ${DAYS} days:`)}\n` +
          `  ${warn(idle.map((r) => r.name).join(", "))}\n`
        : `  Every measured server was called in the last ${DAYS} days.\n`),
  );

  const out = { measuredAt: new Date().toISOString(), servers: Object.fromEntries(rows.map((r) => [r.name, { count: r.count, tokens: r.tokens, error: r.error }])) };
  try {
    writeFileSync(auditPath(ROOT), JSON.stringify(out, null, 2) + "\n");
    process.stdout.write(dim(`\n  Saved to ${auditPath(ROOT)} — the report will quote these figures from now on.\n\n`));
  } catch {
    process.stdout.write("\n");
  }
  process.exit(0);
}

/**
 * The browser page. Reachable as `marmot browse`, and built by the report
 * itself unless `--no-browse` says otherwise.
 * Returns false when there was nothing to render; the caller decides whether
 * that is an error.
 */
async function runBrowse() {
  const { readSessionDetail } = await import("../src/detail.mjs");
  const { buildHtml } = await import("../src/html.mjs");
  const { sessionFiles } = await import("../src/sessions.mjs");
  const { mkdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { execFile } = await import("node:child_process");

  if (has("demo")) {
    const { demoSessions } = await import("../src/demo.mjs");
    const out = flag("out", join(ROOT, "marmot", "demo.html"));
    mkdirSync(join(ROOT, "marmot"), { recursive: true });
    const demo = demoSessions();
    const { demoSkillSizes } = await import("../src/demo.mjs");
    const { skillCosts } = await import("../src/skills.mjs");
    const demoSummary = {
      totals: totals(demo),
      nudges: evaluate(demo, cfg, { root: ROOT, configured: ["github", "sentry", "postgres", "datadog"] }),
      skills: skillCosts(totals(demo).skills, demoSkillSizes),
      mcp: { datadog: { count: 22, tokens: 3600 } },
      configured: ["github", "sentry", "postgres", "datadog"],
    };
    const html = buildHtml(demo, { days: 7, root: "(demo data — not your machine)", redacted: false, summary: demoSummary });
    writeFileSync(out, html);
    process.stdout.write(`Wrote ${out}  (6 synthetic sessions)\n`);
    if (!has("no-open")) {
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      execFile(opener, [out], () => {});
    }
    return true;
  }

  const only = flag("session", null);
  const limit = posInt(flag("limit", 25), 25);
  const redacted = has("no-text");
  const caps = redacted ? { prompt: 0, assistant: 0, tool: 300 } : undefined;

  // Pick the files first, newest last-modified first, so --limit means "the
  // sessions you actually worked in" rather than an arbitrary directory order.
  const since = new Date(Date.now() - DAYS * 86_400_000);
  const picked = [...sessionFiles(ROOT)]
    .map((f) => {
      try {
        return { ...f, mtime: statSync(f.path).mtime };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((f) => (only ? f.id === only || f.id.startsWith(only) : f.mtime >= since))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, only ? 1 : limit);

  if (!picked.length) {
    process.stderr.write(only ? `No session matching ${only}.\n` : `No sessions under ${ROOT}/projects in the last ${DAYS} days.\n`);
    return false;
  }

  const detailed = [];
  for (const f of picked) {
    const d = readSessionDetail(f.path, { rateOverrides: cfg.rateOverrides, caps });
    if (d) detailed.push(d);
  }

  // The page shows the same figures as the report, computed the same way over
  // the same records — a detail record is a superset of a session record, so
  // `totals` and the rules read it without knowing which reader produced it.
  const { configuredServers } = await import("../src/sessions.mjs");
  const sizes = await mcpSizes();
  const summary = {
    totals: totals(detailed),
    plan: has("demo") ? null : await readPlanFresh(),
    nudges: evaluate(detailed, cfg, {
      root: ROOT,
      cwd: process.cwd(),
      mcpSizes: sizes,
      plan: has("demo") ? null : (await import("../src/plan.mjs")).readPlan(ROOT),
      configured: has("demo") ? ["github", "sentry", "postgres", "datadog"] : undefined,
    }),
    skills: (await import("../src/skills.mjs")).skillCosts(
      totals(detailed).skills,
      has("demo") ? (await import("../src/demo.mjs")).demoSkillSizes : (await import("../src/skills.mjs")).skillSizes({ root: ROOT, cwd: process.cwd() }),
    ),
    mcp: sizes?.servers ?? {},
    configured: has("demo") ? ["github", "sentry", "postgres", "datadog"] : configuredServers(ROOT, process.cwd()),
  };

  const outDir = join(ROOT, "marmot");
  mkdirSync(outDir, { recursive: true });
  // Timestamped to the minute. A fixed name per day let the browser serve its
  // cached copy of an earlier run, which is a report that quietly stops moving.
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const out = flag("out", join(outDir, `sessions-${stamp}.html`));
  const html = buildHtml(detailed, { days: DAYS, root: ROOT, redacted, summary });
  writeFileSync(out, html);

  const mb = (Buffer.byteLength(html) / 1024 / 1024).toFixed(1);
  process.stdout.write(`Wrote ${out}  (${detailed.length} sessions, ${mb} MB)\n`);
  if (!redacted) {
    process.stdout.write(`This page contains your prompts and Claude's replies. It is a local file and nothing uploaded it.\n  --no-text leaves the text out.\n`);
  }
  if (!has("no-open")) {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    execFile(opener, [out], () => {});
  }
  return true;
}

if (cmd === "browse") {
  process.exit((await runBrowse()) ? 0 : 1);
}

const sessions = has("demo")
  ? (await import("../src/demo.mjs")).demoSessions()
  : loadSessions({ root: ROOT, days: DAYS, rateOverrides: cfg.rateOverrides });

if (!sessions.length) {
  process.stderr.write(
    `No sessions under ${ROOT}/projects in the last ${DAYS} days.\n` +
      `If Claude Code lives elsewhere on this machine, pass --root.\n`,
  );
  process.exit(1);
}

const DEMO = has("demo");
/**
 * What each MCP server's definitions cost. Read from the saved audit, and
 * measured now when there is nothing recent — a nudge that cannot say what a
 * server costs is only half a nudge. Measuring starts each server, so it is
 * cached for a week and announces itself while it runs.
 */
async function mcpSizes() {
  if (has("demo")) return { servers: { datadog: { count: 22, tokens: 3600 } } };
  const { readAudit, readServerConfigs, auditServers, auditPath } = await import("../src/mcp.mjs");

  const saved = readAudit(ROOT);
  const ageDays = saved?.measuredAt ? (Date.now() - Date.parse(saved.measuredAt)) / 86_400_000 : Infinity;
  if (saved && ageDays < cfg.mcp.auditMaxAgeDays) return saved;
  if (!cfg.mcp.enabled || !cfg.mcp.autoAudit || has("no-audit")) return saved;

  const configs = readServerConfigs(ROOT, process.cwd());
  const names = Object.keys(configs);
  if (!names.length) return saved;

  process.stdout.write(
    dim(`\n  Measuring ${names.length} MCP server${names.length === 1 ? "" : "s"} — this starts each one, and is cached for ${cfg.mcp.auditMaxAgeDays} days.\n`),
  );
  const rows = await auditServers(configs, {
    timeoutMs: cfg.mcp.auditTimeoutSecs * 1000,
    onResult: (r) =>
      process.stdout.write(r.error ? dim(`    · ${r.name.padEnd(22)} ${r.error}\n`) : dim(`    ✔ ${r.name.padEnd(22)} ${r.count} tools, ~${tokens(r.tokens)}\n`)),
  });
  process.stdout.write("\n");

  const out = { measuredAt: new Date().toISOString(), servers: Object.fromEntries(rows.map((r) => [r.name, { count: r.count, tokens: r.tokens, error: r.error }])) };
  try {
    writeFileSync(auditPath(ROOT), JSON.stringify(out, null, 2) + "\n");
  } catch {
    /* an unwritable cache costs a re-measure, not the report */
  }
  return out;
}

const MCP_SIZES = await mcpSizes();

/**
 * The plan, with its limits actually current. A reading whose window has reset
 * says nothing about the window you are in, so it is worth the couple of
 * seconds to ask Claude Code to refresh — it costs no tokens.
 */
async function readPlanFresh() {
  const { readPlan, refreshUsage, worthRefreshing } = await import("../src/plan.mjs");
  let plan = readPlan(ROOT);
  if (!cfg.limits?.enabled || !cfg.limits?.autoRefresh || has("no-refresh")) return plan;
  if (!plan.plan || !worthRefreshing(plan, cfg.limits.staleAfterMins)) return plan;

  process.stdout.write(dim("\n  Refreshing your plan limits — this asks Claude Code, and costs no tokens.\n"));
  const r = refreshUsage(ROOT);
  if (r.refreshed) return r.plan;
  process.stdout.write(dim(`  Could not refresh; reporting what is cached.\n`));
  return plan;
}

const PLAN = DEMO
  ? { plan: "Max 5×", limits: [{ kind: "session", label: "5-hour session", percent: 34, severity: "normal", resetsAt: new Date(Date.now() + 4200_000).toISOString(), active: true }, { kind: "weekly_all", label: "weekly", percent: 61, severity: "normal", resetsAt: new Date(Date.now() + 260_000_000).toISOString(), active: true }], spend: null, fetchedAt: Date.now(), ageMins: 3, stale: false }
  : await readPlanFresh();

const ATTRIBUTION = DEMO ? null : (await import("../src/plan.mjs")).readAttribution(ROOT);

const nudges = evaluate(sessions, cfg, {
  root: ROOT,
  plan: PLAN,
  attribution: ATTRIBUTION,
  cwd: DEMO ? null : process.cwd(),
  mcpSizes: MCP_SIZES,
  // Demo runs must not read this machine's MCP config, or the demo reports on you.
  configured: DEMO ? ["github", "sentry", "postgres", "datadog"] : undefined,
});

if (cmd === "doctor") {
  const t = totals(sessions);
  const unpriced = new Set(sessions.flatMap((s) => [...s.unpricedModels]));
  const noPrompts = sessions.filter((s) => s.typedPrompts === 0).length;

  // A notification that is accepted and silently dropped is worse than none,
  // so say plainly whether one would actually arrive.
  const { deliverability } = await import("../src/notify.mjs");
  const d = deliverability({ app: cfg.notify?.app ?? null });
  const notify = !cfg.notify?.desktop
    ? "off in your config"
    : d.status === "silenced"
      ? `muted · ${d.detail}`
      : d.status === "unsupported"
        ? d.detail
        : `on · ${d.detail}${cfg.notify?.bell ? ", with a sound" : ""}`;

  process.stdout.write(`
  Root            ${ROOT}
  Plan            ${(await import("../src/plan.mjs")).readPlan(ROOT).plan ?? "not detected — dollar figures are modelled at API rates"}
  Sessions        ${num(sessions.length)} in ${DAYS} days
  Thresholds      ${cfg._exists ? cfg._path : "defaults (no config file — run `marmot init` to write one)"}
  Priced turns    ${num(sessions.reduce((a, s) => a + s.pricedTurns, 0))} of ${num(t.turns)}
  Unpriced models ${unpriced.size ? [...unpriced].join(", ") : "none"}
  Sessions with 0 typed prompts  ${noPrompts}${noPrompts ? "  (resumed or agent-driven; not a fault)" : ""}
  Notifications   ${notify}${d.channel === "macos" ? `\n                  If none arrive: check Focus is off, then allow notifications for\n                  that app in System Settings. notify.app posts as a different one.` : ""}

  Not readable here: lines added/removed (needs the diff), agent-active vs your
  own time (needs OpenTelemetry), and anyone else's sessions — this is one machine.
`);
  process.exit(0);
}

if (has("json")) {
  process.stdout.write(
    JSON.stringify(
      {
        window: { days: DAYS, root: ROOT },
        totals: totals(sessions),
        nudges: {
          window: nudges.windowNudges,
          session: nudges.sessionNudges.map((g) => ({
            id: g.id,
            label: g.label,
            hits: g.hits.map((h) => ({ sessionId: h.session.id, day: h.session.day, cost: h.session.cost, detail: h.detail })),
          })),
        },
        sessions: sessions.map((s) => ({
          id: s.id, day: s.day, cwd: s.cwd, gitBranch: s.gitBranch,
          cost: s.cost, typedPrompts: s.typedPrompts, assistantTurns: s.assistantTurns,
          toolCalls: s.totalToolCalls, toolErrors: s.toolErrors,
          cacheHitRate: s.cacheHitRate, compactions: s.compactions,
          durationMins: s.durationMins, models: s.models,
          skills: [...s.skills], mcpCalls: s.mcpCalls,
        })),
      },
      null,
      2,
    ) + "\n",
  );
  process.exit(0);
}

if (cmd === "nudges") {
  process.stdout.write("\n" + renderNudges(nudges, { heading: true }) + "\n\n");
  process.exit(0);
}

if (cmd === "sessions") {
  process.stdout.write(`\n${renderSessionList(sessions)}\n\n`);
  process.exit(0);
}

// Measured from the SKILL.md files on this machine. Demo runs read nothing.
const SKILL_SIZES = DEMO
  ? (await import("../src/demo.mjs")).demoSkillSizes
  : (await import("../src/skills.mjs")).skillSizes({ root: ROOT, cwd: process.cwd() });
const CONFIGURED = DEMO ? ["github", "sentry", "postgres", "datadog"] : (await import("../src/sessions.mjs")).configuredServers(ROOT, process.cwd());
process.stdout.write(renderReport(sessions, cfg, { days: DAYS, nudges, demo: DEMO, skillSizes: SKILL_SIZES, mcpSizes: MCP_SIZES, configuredServers: CONFIGURED, plan: PLAN, attribution: ATTRIBUTION }));

// `--sessions` adds every session under the report; the page follows unless
// `--no-browse`. One command, the numbers and somewhere to dig in.
if (has("sessions")) process.stdout.write(`\n${renderSessionList(sessions, { heading: true })}\n\n`);

// The page is the better place to read all of this, so it is built and opened
// unless you say otherwise. `--no-browse` keeps the run to the terminal.
if (!has("no-browse") && !has("json")) {
  process.stdout.write("\n");
  await runBrowse();
}
