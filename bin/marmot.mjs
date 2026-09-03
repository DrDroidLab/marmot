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
import { usd, num, pct, tokens, mins, dim, bold, warn, good } from "../src/format.mjs";
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
    init              Write ${configPath(ROOT)} with the default thresholds.
                      --hooks installs the nudges, --statusline the statusline
    config            Open that thresholds file (creating it if it is missing)
    config set k=v    Change a threshold without opening an editor
    mcp-audit         Ask each configured MCP server for its tools, and measure
                      what their definitions cost on every request
    remind            Show or set when a nudge fires: --at 50,75,90, --cap 100
    test-notification Send one, and say what it did and where to look
    logs              What the hooks did and why, newest first. --tail, --json
    doctor            What is readable on this machine, and what is not

  Flags
    --days <n>        Window, default 30
    --root <dir>      Claude Code home, default ~/.claude
    --json            Machine-readable output
    --demo            Run against synthetic sessions, not your own
    --hooks           With init: install the nudge hooks, no plugin needed
    --dry-run         With --hooks: print what would change, write nothing
    --remove          With --hooks: take Marmot's hooks back out
    --statusline      With init: also install the statusline

  report only
    --sessions        List every session in the window under the report
    --browse          Build and open the page even when output is piped
    --no-browse       Never build or open it
    --no-audit        Do not measure MCP servers, even with no recent figures
    --no-refresh      Do not refresh plan limits, even when the window has reset

  config only
    --print           Also print the file to the terminal
    --no-open         Show the path, do not open it

  mcp-audit only
    --timeout <s>     Per server, default 20
    --tools           List every tool, not just the totals

  browse only
    --limit <n>       Full timelines for the most recent N, default 25.
                      Every session in the window is counted either way
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
  // Hooks are ordinary settings entries. The plugin is a convenient way to get
  // them, not the only one — installed here they work from a global CLI, which
  // is a far shorter road than the marketplace dance.
  if (has("hooks")) {
    const sp = `${ROOT}/settings.json`;
    const raw = existsSync(sp) ? readFileSync(sp, "utf8") : null;
    let settings = {};
    if (raw !== null) {
      try {
        settings = JSON.parse(raw);
      } catch {
        // Refuse rather than overwrite: a file we cannot parse is one whose
        // contents we would be destroying.
        process.stdout.write(`\n${sp} is not valid JSON, so it is left alone. Fix or move it, then re-run.\n`);
        process.exit(1);
      }
    }

    const self = new URL("../scripts/hook.mjs", import.meta.url).pathname;
    const entry = (timeout) => ({ hooks: [{ type: "command", command: `node "${self}"`, timeout }] });
    const mine = (group) => (group?.hooks ?? []).some((h) => String(h.command ?? "").includes("marmot"));

    settings.hooks ??= {};
    const changes = [];
    for (const [event, timeout] of [["SessionStart", 20], ["Stop", 15]]) {
      const groups = (settings.hooks[event] ??= []);
      const existing = groups.findIndex(mine);
      if (has("remove")) {
        if (existing >= 0) {
          groups.splice(existing, 1);
          if (!groups.length) delete settings.hooks[event];
          changes.push(`remove ${event}`);
        }
        continue;
      }
      if (existing >= 0) {
        if (!has("force")) continue;
        groups[existing] = entry(timeout);
        changes.push(`replace ${event}`);
      } else {
        groups.push(entry(timeout));
        changes.push(`add ${event}`);
      }
    }
    if (!Object.keys(settings.hooks).length) delete settings.hooks;

    if (!changes.length) {
      process.stdout.write(
        has("remove")
          ? `\nNo Marmot hooks in ${sp}; nothing to remove.\n`
          : `\nMarmot's hooks are already in ${sp}. Re-run with --force to replace them.\n`,
      );
    } else if (has("dry-run")) {
      process.stdout.write(`\nWould change ${sp}:\n${changes.map((c) => `  ${c}`).join("\n")}\n  Nothing has been written. Drop --dry-run to apply.\n`);
    } else {
      try {
        // Keep a copy of exactly what was there. This edits a file the user did
        // not write, so undoing it must not depend on us being right.
        if (raw !== null) writeFileSync(`${sp}.marmot-backup`, raw);
        writeFileSync(sp, JSON.stringify(settings, null, 2) + "\n");
        process.stdout.write(
          `\n${changes.join(", ")} in ${sp}\n` +
            (raw !== null ? `  Previous file saved as ${sp}.marmot-backup\n` : "") +
            (has("remove") ? "" : `  Restart Claude Code for the daily digest and live nudges.\n  Undo any time with: marmot init --hooks --remove\n`),
        );
      } catch (e) {
        process.stdout.write(`\nCould not write ${sp}: ${e.message}\n`);
        process.exit(1);
      }
    }
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
  // `marmot config set session.costCap=50` — for anyone who cannot open an
  // editor, which includes every coding agent and every headless run.
  const setArgs = argv.slice(argv.indexOf("set") + 1).filter((a) => !a.startsWith("--") && a.includes("="));
  if (argv.includes("set")) {
    if (!setArgs.length) {
      process.stdout.write("Usage: marmot config set <key>=<value> [...]\n  e.g. marmot config set session.costCap=50 limits.steps=[25,50,75]\n");
      process.exit(1);
    }
    const body = existsSync(cfg._path) ? JSON.parse(readFileSync(cfg._path, "utf8")) : (() => { const { _path, _exists, ...d } = { ...DEFAULTS }; return d; })();

    const changes = [];
    for (const pair of setArgs) {
      const at = pair.indexOf("=");
      const path = pair.slice(0, at).split(".").filter(Boolean);
      const raw = pair.slice(at + 1);
      if (!path.length) continue;
      // JSON first, so numbers, booleans, arrays and null all mean themselves;
      // anything else is the string you typed.
      let value;
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw;
      }
      let node = body;
      for (const key of path.slice(0, -1)) {
        if (typeof node[key] !== "object" || node[key] === null || Array.isArray(node[key])) node[key] = {};
        node = node[key];
      }
      const last = path[path.length - 1];
      changes.push(`${path.join(".")}: ${JSON.stringify(node[last])} → ${JSON.stringify(value)}`);
      node[last] = value;
    }

    try {
      writeFileSync(cfg._path, JSON.stringify(body, null, 2) + "\n");
    } catch (e) {
      process.stderr.write(`Could not write ${cfg._path}: ${e.message}\n`);
      process.exit(1);
    }
    process.stdout.write(`${cfg._path}\n${changes.map((c) => `  ${c}`).join("\n")}\n`);
    process.exit(0);
  }

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
  const { loadSessions: load, sessionDirs: dirsOf } = await import("../src/sessions.mjs");
  const configs = readServerConfigs(ROOT, [...dirsOf(load({ root: ROOT, days: DAYS })), process.cwd()]);
  const names = Object.keys(configs);
  if (!names.length) {
    process.stdout.write(`No MCP servers configured for this machine or the projects in this window.\n`);
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
  const inWindow = [...sessionFiles(ROOT)]
    .map((f) => {
      try {
        return { ...f, mtime: statSync(f.path).mtime };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((f) => (only ? f.id === only || f.id.startsWith(only) : f.mtime >= since))
    .sort((a, b) => b.mtime - a.mtime);
  const picked = inWindow.slice(0, only ? 1 : limit);

  if (!inWindow.length) {
    process.stderr.write(only ? `No session matching ${only}.\n` : `No sessions under ${ROOT}/projects in the last ${DAYS} days.\n`);
    return false;
  }

  // Full timelines for the most recent sessions, and the cheap aggregate record
  // for the rest. The page's figures are computed over *every* session in the
  // window either way — a page that quietly totalled a subset while the report
  // totalled the window is two surfaces disagreeing, which is the one thing
  // this is not allowed to do.
  const deep = new Set(picked.map((f) => f.path));
  const detailed = [];
  for (const f of picked) {
    const d = readSessionDetail(f.path, { rateOverrides: cfg.rateOverrides, caps });
    if (d) detailed.push(d);
  }
  if (!only) {
    const { readSession } = await import("../src/sessions.mjs");
    for (const f of inWindow) {
      if (deep.has(f.path)) continue;
      const a = readSession(f, { rateOverrides: cfg.rateOverrides });
      if (!a) continue;
      // Same shape, minus the part that costs megabytes.
      detailed.push({
        ...a,
        title: null,
        events: [],
        trimmed: true,
        toolCounts: a.toolCalls,
        skillCounts: Object.fromEntries([...a.skills].map((k) => [k, 1])),
        mcpCounts: a.mcpCalls,
        filesTouched: [...a.filesTouched],
        permissionModes: [...a.permissionModes],
      });
    }
    detailed.sort((x, y) => (x.endedAt < y.endedAt ? 1 : -1));
  }

  // The page shows the same figures as the report, computed the same way over
  // the same records — a detail record is a superset of a session record, so
  // `totals` and the rules read it without knowing which reader produced it.
  const { configuredServers, sessionDirs } = await import("../src/sessions.mjs");
  const dirs = [...sessionDirs(detailed), process.cwd()];
  const sizes = await mcpSizes(dirs);
  const { byProject } = await import("../src/sessions.mjs");
  const summary = {
    totals: totals(detailed),
    projects: byProject(detailed, { servers: has("demo") ? {} : (await import("../src/mcp.mjs")).readServerConfigs(ROOT, dirs) }),
    plan: has("demo") ? null : await readPlanFresh(),
    nudges: evaluate(detailed, cfg, {
      root: ROOT,
      cwd: process.cwd(),
      mcpSizes: sizes,
      plan: has("demo") ? null : (await import("../src/plan.mjs")).readPlan(ROOT),
      configured: has("demo") ? ["github", "sentry", "postgres", "datadog"] : configuredServers(ROOT, dirs),
    }),
    skills: (await import("../src/skills.mjs")).skillCosts(
      totals(detailed).skills,
      has("demo") ? (await import("../src/demo.mjs")).demoSkillSizes : (await import("../src/skills.mjs")).skillSizes({ root: ROOT, cwd: process.cwd() }),
    ),
    mcp: sizes?.servers ?? {},
    configured: has("demo") ? ["github", "sentry", "postgres", "datadog"] : configuredServers(ROOT, dirs),
  };

  const outDir = join(ROOT, "marmot");
  mkdirSync(outDir, { recursive: true });
  // Timestamped to the minute. A fixed name per day let the browser serve its
  // cached copy of an earlier run, which is a report that quietly stops moving.
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const out = flag("out", join(outDir, `sessions-${stamp}.html`));
  const html = buildHtml(detailed, { days: DAYS, root: ROOT, redacted, summary });
  writeFileSync(out, html);

  // A new file per run means the browser can never serve a cached older one —
  // but left alone that is a directory quietly filling with megabytes. Keep the
  // most recent few and drop the rest.
  if (!flag("out", null)) {
    try {
      const { readdirSync, unlinkSync } = await import("node:fs");
      const keep = Math.max(1, cfg.browse?.keep ?? 5);
      readdirSync(outDir)
        .filter((f) => /^sessions-.*\.html$/.test(f))
        .map((f) => ({ f, at: statSync(join(outDir, f)).mtimeMs }))
        .sort((a, b) => b.at - a.at)
        .slice(keep)
        .forEach((old) => unlinkSync(join(outDir, old.f)));
    } catch {
      /* tidying is a courtesy, never a reason to fail the page */
    }
  }

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

if (cmd === "remind" || cmd === "reminders") {
  const { readPlan, usableLimits } = await import("../src/plan.mjs");
  const { limitSteps } = await import("../src/rules.mjs");
  const plan = has("demo") ? { plan: "Max 20×", limits: [] } : readPlan(ROOT);
  const hasQuota = usableLimits(plan).length > 0 || (plan.plan && !["API", null].includes(plan.plan) && plan.limits.length > 0);

  const write = (patch) => {
    const body = existsSync(cfg._path) ? JSON.parse(readFileSync(cfg._path, "utf8")) : (() => { const { _path, _exists, ...d } = { ...DEFAULTS }; return d; })();
    for (const [path, value] of Object.entries(patch)) {
      const keys = path.startsWith("limits.byPlan.") ? ["limits", "byPlan", path.slice("limits.byPlan.".length)] : path.split(".");
      let node = body;
      for (const k of keys.slice(0, -1)) {
        if (typeof node[k] !== "object" || node[k] === null || Array.isArray(node[k])) node[k] = {};
        node = node[k];
      }
      node[keys[keys.length - 1]] = value;
    }
    writeFileSync(cfg._path, JSON.stringify(body, null, 2) + "\n");
    return body;
  };

  // `--at 50,75,90` sets the quota marks; `--cap 100` the dollar ceiling for a
  // plan that exposes no quota to measure against.
  const at = flag("at", null);
  const cap = flag("cap", null);
  const changed = {};
  if (at !== null) {
    const steps = String(at).split(",").map((n) => Number(n.trim())).filter((n) => Number.isFinite(n) && n > 0 && n <= 100).sort((a, b) => a - b);
    if (!steps.length) {
      process.stderr.write("marmot remind --at takes percentages, e.g. --at 50,75,90\n");
      process.exit(1);
    }
    // Both, deliberately: `byPlan` takes precedence over `steps`, so setting
    // only the shared default would silently do nothing on a plan that has an
    // entry — which is every plan we recognise.
    changed["limits.steps"] = steps;
    if (plan.plan) changed[`limits.byPlan.${plan.plan}`] = steps;
    changed["limits.enabled"] = true;
  }
  if (cap !== null) {
    const n = Number(cap);
    if (!Number.isFinite(n) || n <= 0) {
      process.stderr.write("marmot remind --cap takes an amount, e.g. --cap 100\n");
      process.exit(1);
    }
    changed["daily.costCap"] = n;
    changed["session.costCap"] = Math.max(1, Math.round(n / 2));
  }
  if (has("off")) changed["limits.enabled"] = false;
  if (has("on")) changed["limits.enabled"] = true;
  if (Object.keys(changed).length) write(changed);

  const now = loadConfig(ROOT);
  const steps = limitSteps(now, plan.plan);
  process.stdout.write(`\n  ${bold("Reminders")}${plan.plan ? dim(` · ${plan.plan}`) : ""}\n\n`);
  if (!now.limits?.enabled) {
    process.stdout.write(`  Off. ${dim("marmot remind --on")}\n`);
  } else if (hasQuota) {
    process.stdout.write(`  At ${bold(steps.length ? steps.map((n) => `${n}%`).join(", ") : "no marks set")} of each plan window — the 5-hour one and the week.\n`);
    process.stdout.write(dim(`  Your plan reports quota, so these are what run out. Dollar caps stay quiet.\n`));
  } else {
    process.stdout.write(`  Your plan reports no quota, so the ceiling is money: ${bold(usd(now.daily.costCap))} a day, ${bold(usd(now.session.costCap))} a session.\n`);
    process.stdout.write(dim(`  Change it with --cap.\n`));
  }
  process.stdout.write(`  At most one interruption every ${bold(`${now.interrupt?.minGapMins ?? 20} minutes`)}; the rest wait for the digest.\n`);
  process.stdout.write(`
  ${dim("marmot remind --at 50,75,90")}   quota marks, as percentages
  ${dim("marmot remind --cap 100")}       dollar ceiling, for plans without quota
  ${dim("marmot remind --off")}           stop them

`);
  process.exit(0);
}

if (cmd === "test-notification" || cmd === "test-notif") {
  const { alert, deliverability, silenced, notifyStyle } = await import("../src/notify.mjs");
  // `--alert` previews the shape reserved for the last mark before a limit,
  // which is otherwise hard to see on purpose — you have to nearly run out.
  const urgent = argv.includes("--alert");
  // `--banner` previews the other shape, which is otherwise only seen by
  // someone who has turned dialogs off.
  const forced = argv.includes("--banner") ? "banner" : null;
  // `--digest` previews the once-a-day summary, which has its own setting.
  const kind = argv.includes("--digest") ? "digest" : "nudge";
  const style = forced ?? notifyStyle(cfg, urgent, kind);
  const d = deliverability({ app: cfg.notify?.app ?? null, style });

  // The same call a real nudge makes, with the same config — a test that took a
  // different path would prove nothing about the thing being tested.
  const did = alert(cfg, {
    title: urgent ? "Marmot · 90% of your weekly limit" : "Marmot · Session past the cost cap",
    body: urgent
      ? "90% of your weekly limit is gone on Claude Max 20x. It resets in 2.1h. 42% of this window ran on subagents.\n\nStart a fresh session rather than carrying context you have finished with."
      : "This session has reached $82.50 against a $25.00 cap, over 60 model turns.",
    urgent,
    kind,
    style: forced,
  });

  process.stdout.write(`\n  ${bold("Sent a test notification.")} It is the same call a real nudge makes.\n\n`);
  const rows = [
    ["Desktop", cfg.notify?.desktop === false ? warn("off in your config (notify.desktop)") : did.desktop ? `sent · ${did.desktop.via ?? d.detail}` : warn("not sent")],
    ["Bell", cfg.notify?.bell === false ? dim("off in your config (notify.bell)") : did.bell === "tty" ? "rang the terminal" : did.bell === "stderr" ? dim("written to stderr — no terminal to ring") : warn("not rung")],
    ["Channel", d.detail],
    ["Stays up", style === "alert" ? "yes — it waits for a click" : cfg.notify?.persist === false ? "no — notify.persist is false" : d.persistHint ? warn("macOS decides this, see below") : "yes, until you dismiss it"],
    ["Style", `${kind} · ${style === "alert" ? "dialog, with the marmot" : forced ? "banner — because you asked for --banner" : "banner — no marmot, and it dismisses itself"}`],
    ["Other kind", kind === "nudge" ? `digest · ${notifyStyle(cfg, false, "digest") === "alert" ? "dialog" : "banner"} ${dim("(marmot test-notification --digest)")}` : `nudge · ${notifyStyle(cfg, false, "nudge") === "alert" ? "dialog" : "banner"}`],
  ];
  const w = Math.max(...rows.map((r) => r[0].length));
  for (const [k, v] of rows) process.stdout.write(`  ${k.padEnd(w)}  ${v}\n`);

  if (silenced()) {
    process.stdout.write(warn(`\n  MARMOT_NO_NOTIFY or CI is set, so nothing was actually sent.\n`));
  }

  process.stdout.write(`
  ${bold("Nothing appeared?")} In order of likelihood:

  1. A quiet-hours setting suppresses every app at once. macOS: click the clock,
     check Focus. Windows: Settings → System → Notifications → Do not disturb.
     GNOME/KDE: Settings → Notifications → Do Not Disturb.
  2. The posting app is not allowed to. ${d.channel === "macos" ? `Yours is ${d.deliverer ?? "Script Editor"} — System Settings → Notifications → allow it, or set notify.app to one you have allowed.` : "Check your notification settings for it."}
  3. Nothing at all, ever: set notify.desktop to false and rely on the bell and
     the line in your Claude Code transcript, which are unaffected.
${d.persistHint ? `\n  ${bold("Fading too fast?")} ${d.persistHint}\n  Or have every nudge wait for you: ${dim("marmot config set notify.style=alert")}\n` : ""}
  marmot config set notify.desktop=false     turn it off
  marmot config set notify.bell=false        keep the popup, drop the sound
  marmot doctor                              what Marmot thinks is set up

`);
  process.exit(0);
}

if (cmd === "logs") {
  const { readLog, logging, hookWiring, hooksMissing } = await import("../src/hooklog.mjs");
  const limit = argv.includes("--all") ? 0 : posInt(flag("tail"), 20);
  const log = readLog(ROOT, { limit });

  if (argv.includes("--path")) {
    process.stdout.write(`${log.path}\n`);
    process.exit(0);
  }
  // Raw JSONL, oldest first, so it can be piped into jq or attached to a bug
  // report without anyone having to parse the pretty output back out.
  if (argv.includes("--json")) {
    for (const e of [...log.entries].reverse()) process.stdout.write(`${JSON.stringify(e)}\n`);
    process.exit(0);
  }

  if (!log.exists) {
    process.stdout.write(`\n  No hook log at ${bold(log.path)} yet.\n`);
    process.stdout.write(
      logging(cfg)
        ? `  It is written when a hook runs. If it stays empty the hooks are not firing —\n  ${dim("marmot doctor")} says whether they are installed.\n\n`
        : `  Logging is off (${dim("log.hooks")} is false, or MARMOT_NO_LOG is set).\n\n`,
    );
    process.exit(0);
  }

  // What is installed, above what it did. "Nothing in the log" means something
  // very different depending on whether a hook is wired up at all.
  const wiring = hookWiring(ROOT);
  process.stdout.write(`\n  ${bold("Hooks installed")}\n`);
  if (!wiring.length) {
    process.stdout.write(`    ${warn("none found")} — run ${dim("marmot init --hooks")}\n`);
  } else {
    for (const w of wiring) {
      if (w.malformed) {
        process.stdout.write(`    ${warn("unreadable")}  ${w.settings} — ${w.malformed}\n`);
        continue;
      }
      const state = w.exists === false ? warn("MISSING FILE — this hook never runs") : good("ok");
      process.stdout.write(`    ${bold(w.event.padEnd(13))} ${state}  ${dim(w.scope)}\n      ${dim(w.file ?? w.command)}\n`);
    }
    const missing = hooksMissing(wiring);
    if (missing.length) process.stdout.write(`    ${warn(`${missing.join(" and ")} not installed`)} — run ${dim("marmot init --hooks")}\n`);
  }

  process.stdout.write(`\n  ${bold(`Hook log · ${log.total} run${log.total === 1 ? "" : "s"}`)}  ${dim(log.path)}\n`);
  if (log.skipped) process.stdout.write(dim(`  ${log.skipped} unreadable line${log.skipped === 1 ? "" : "s"} skipped.\n`));
  process.stdout.write("\n");

  for (const e of log.entries) {
    const when = (e.at ?? "").slice(0, 19).replace("T", " ");
    const fired = (e.rules ?? []).filter((r) => r.fired).length;
    const head = e.outcome === "nudged" ? good(e.outcome) : e.outcome === "started" ? warn("did not finish") : e.outcome;
    process.stdout.write(`  ${dim(when)}  ${bold((e.event ?? "?").padEnd(12))} ${head}\n`);

    if (e.session) {
      const money = e.cost === undefined ? "" : ` · ${usd(e.cost)}`;
      process.stdout.write(`    ${dim("session")}  ${e.session.slice(0, 8)}${money} · ${e.turns} turns · ${e.prompts} prompts${e.cwd ? ` · ${e.cwd}` : ""}\n`);
    }
    // The plan is printed on every line that has one because it is what decides
    // whether a dollar cap means anything, and a wrong reading here is
    // invisible everywhere else.
    if (e.plan !== undefined) {
      const p = e.plan;
      const limits = p?.limits?.length ? p.limits.map(([k, v]) => `${k} ${v}%`).join(", ") : "no quota";
      process.stdout.write(`    ${dim("plan")}     ${p?.name ? bold(p.name) : warn("could not identify")} · ${limits}${p?.stale && p.ageMins !== null ? dim(` · snapshot ${mins(p.ageMins)} old`) : ""}\n`);
    }
    for (const r of e.rules ?? []) {
      process.stdout.write(`    ${dim("rule")}     ${r.fired ? good("fired") : dim("quiet")}  ${r.id}${r.why ? dim(` — ${r.why}`) : ""}\n`);
    }
    if (e.held?.length) process.stdout.write(`    ${dim("held")}     ${e.held.join(", ")}\n`);
    if (e.notify) process.stdout.write(`    ${dim("notify")}   ${e.notify.style ?? "?"}${e.notify.via ? ` via ${e.notify.via}` : ""}${e.notify.bell ? ` · bell ${e.notify.bell}` : ""}\n`);
    if (!e.session && !e.rules?.length && !fired) process.stdout.write("");
    process.stdout.write("\n");
  }

  process.stdout.write(`  ${dim("marmot logs --json > marmot-hooks.jsonl")}   attach this to a bug report\n`);
  process.stdout.write(`  ${dim("marmot logs --all")}                        every run kept\n\n`);
  process.exit(0);
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
async function mcpSizes(dirs = []) {
  if (has("demo")) return { servers: { datadog: { count: 22, tokens: 3600 } } };
  const { readAudit, readServerConfigs, auditServers, auditPath } = await import("../src/mcp.mjs");

  const saved = readAudit(ROOT);
  const ageDays = saved?.measuredAt ? (Date.now() - Date.parse(saved.measuredAt)) / 86_400_000 : Infinity;
  if (saved && ageDays < cfg.mcp.auditMaxAgeDays) return saved;
  if (!cfg.mcp.enabled || !cfg.mcp.autoAudit || has("no-audit")) return saved;

  const configs = readServerConfigs(ROOT, [...dirs, process.cwd()]);
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

// Every directory the window's sessions ran in. Using these rather than the
// one you happen to be standing in is what makes the report identical from
// anywhere on the machine.
const sessionsMod = await import("../src/sessions.mjs");
const { configuredServers, sessionDirs } = sessionsMod;
const WINDOW_DIRS = DEMO ? [] : [...sessionDirs(sessions), process.cwd()];
const MCP_SIZES = await mcpSizes(WINDOW_DIRS);

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

const CONFIGURED = DEMO ? ["github", "sentry", "postgres", "datadog"] : configuredServers(ROOT, WINDOW_DIRS);
const SERVER_CONFIGS = DEMO ? {} : (await import("../src/mcp.mjs")).readServerConfigs(ROOT, WINDOW_DIRS);

/** What the diagnoses read: everything measured, in one place. */
function diagnoseContext(session) {
  const { mcpLastUsed, daysSince } = sessionsMod;
  const called = {};
  for (const s of sessions) for (const [srv, n] of Object.entries(s.mcpCalls ?? {})) called[srv] = (called[srv] ?? 0) + n;
  const baselines = sessions.map((s) => s.baselineTokens).filter((n) => typeof n === "number").sort((a, b) => a - b);
  const t = session?.tokens;
  return {
    session,
    sessionTokens: t ? t.input + t.output + t.cacheRead + t.cacheWrite : 0,
    premium: cfg.models.premium,
    attribution: ATTRIBUTION,
    mcp: {
      configured: CONFIGURED,
      called,
      sizes: MCP_SIZES,
      daysSince: daysSince(mcpLastUsed(sessions)),
      baseline: baselines.length ? baselines[Math.floor(baselines.length / 2)] : null,
    },
  };
}

const DIAGNOSE = diagnoseContext(sessions.slice().sort((a, b) => b.cost - a.cost)[0] ?? null);

const nudges = evaluate(sessions, cfg, {
  root: ROOT,
  plan: PLAN,
  attribution: ATTRIBUTION,
  diagnose: DIAGNOSE,
  cwd: DEMO ? null : process.cwd(),
  configured: DEMO ? ["github", "sentry", "postgres", "datadog"] : configuredServers(ROOT, WINDOW_DIRS),
  mcpSizes: MCP_SIZES,
});

if (cmd === "doctor") {
  const t = totals(sessions);
  const unpriced = new Set(sessions.flatMap((s) => [...s.unpricedModels]));
  const noPrompts = sessions.filter((s) => s.typedPrompts === 0).length;

  // A notification that is accepted and silently dropped is worse than none,
  // so say plainly whether one would actually arrive.
  const { deliverability, notifyStyle } = await import("../src/notify.mjs");
  const d = deliverability({ app: cfg.notify?.app ?? null, style: notifyStyle(cfg, false, "nudge") });
  const notify = !cfg.notify?.desktop
    ? "off in your config"
    : d.status === "silenced"
      ? `muted · ${d.detail}`
      : d.status === "unsupported"
        ? d.detail
        : `on · ${d.detail}${cfg.notify?.bell ? ", with a sound" : ""}`;
  // macOS decides whether a notification waits for you or fades, and only the
  // user can change it — so say where, rather than leaving it a mystery.
  const persistNote = cfg.notify?.desktop && cfg.notify?.persist !== false && d.persistHint ? `\n                  ${d.persistHint}` : "";

  // Whether the nudges are actually wired up. "Installed" and "working" are
  // different states, and the gap between them is silent.
  // Every scope, not just settings.json: a machine whose hooks live in
  // settings.local.json was being told they were not installed.
  const { hookWiring, hooksMissing, readLog } = await import("../src/hooklog.mjs");
  const wiring = hookWiring(ROOT);
  const hooks = (() => {
    if (!wiring.length) return "not installed — run `marmot init --hooks`";
    const parts = wiring.filter((w) => w.event).map((w) => `${w.event}${w.exists === false ? " (points at a missing file!)" : ""} [${w.scope}]`);
    const missing = hooksMissing(wiring);
    return `${parts.join(", ")}${missing.length ? ` — ${missing.join(" and ")} missing, run \`marmot init --hooks\`` : ""}`;
  })();
  const hookRuns = (() => {
    const l = readLog(ROOT, { limit: 1 });
    if (!l.exists) return "no runs recorded yet — `marmot logs` explains";
    const last = l.entries[0];
    return `${num(l.total)} recorded, last ${last?.at?.slice(0, 19).replace("T", " ") ?? "?"} — \`marmot logs\``;
  })();

  process.stdout.write(`
  Root            ${ROOT}
  Plan            ${(await import("../src/plan.mjs")).readPlan(ROOT).plan ?? "not detected — dollar figures are modelled at API rates"}
  Sessions        ${num(sessions.length)} in ${DAYS} days
  Thresholds      ${cfg._exists ? cfg._path : "defaults (no config file — run `marmot init` to write one)"}
  Priced turns    ${num(sessions.reduce((a, s) => a + s.pricedTurns, 0))} of ${num(t.turns)}
  Unpriced models ${unpriced.size ? [...unpriced].join(", ") : "none"}
  Sessions with 0 typed prompts  ${noPrompts}${noPrompts ? "  (resumed or agent-driven; not a fault)" : ""}
  Nudge hooks     ${hooks}
  Hook runs       ${hookRuns}
  Notifications   ${notify}${persistNote}${d.channel === "macos" ? `\n                  If none arrive: check Focus is off, then allow notifications for\n                  that app in System Settings. notify.app posts as a different one.` : ""}

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
process.stdout.write(renderReport(sessions, cfg, { days: DAYS, nudges, demo: DEMO, skillSizes: SKILL_SIZES, mcpSizes: MCP_SIZES, configuredServers: CONFIGURED, plan: PLAN, attribution: ATTRIBUTION, serverConfigs: SERVER_CONFIGS, diagnose: DIAGNOSE }));

// `--sessions` adds every session under the report; the page follows unless
// `--no-browse`. One command, the numbers and somewhere to dig in.
if (has("sessions")) process.stdout.write(`\n${renderSessionList(sessions, { heading: true })}\n\n`);

// The page is the better place to read all of this, so a person at a terminal
// gets it built and opened. A run whose output is piped — an agent, a script, a
// cron job — gets the terminal report only: writing a multi-megabyte page and
// hijacking the display is not what those callers asked for. `--browse` forces
// it anyway, `--no-browse` never.
const interactive = Boolean(process.stdout.isTTY);
if (!has("no-browse") && !has("json") && (interactive || has("browse"))) {
  process.stdout.write("\n");
  await runBrowse();
}
