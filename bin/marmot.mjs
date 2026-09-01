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
import { renderReport, renderNudges, totals } from "../src/render.mjs";
import { usd, num, dim, bold } from "../src/format.mjs";
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
    doctor            What is readable on this machine, and what is not

  Flags
    --days <n>        Window, default 30
    --root <dir>      Claude Code home, default ~/.claude
    --json            Machine-readable output
    --demo            Run against synthetic sessions, not your own
    --statusline      With init: also install the statusline

  config only
    --print           Also print the file to the terminal
    --no-open         Show the path, do not open it

  browse only
    --limit <n>       Most recent N sessions, default 25
    --session <id>    Just this one
    --out <file>      Where to write, default ~/.claude/marmot/
    --no-text         Leave prompt and response text out of the page
    --no-open         Write it, do not open it

  Nothing here uploads, and no prompt or response text is ever read.
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
    const { execFile, spawnSync } = await import("node:child_process");
    const editor = process.env.VISUAL || process.env.EDITOR;
    if (editor && process.stdout.isTTY) {
      // A terminal editor needs a terminal. We only have one when stdout is a
      // TTY — run from a slash command it is captured, and vim would hang.
      spawnSync(editor, [cfg._path], { stdio: "inherit", shell: true });
    } else {
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      execFile(opener, [cfg._path], () => {});
    }
  }
  process.exit(0);
}

if (cmd === "browse") {
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
    const html = buildHtml(demoSessions(), { days: 7, root: "(demo data — not your machine)", redacted: false });
    writeFileSync(out, html);
    process.stdout.write(`Wrote ${out}  (6 synthetic sessions)\n`);
    if (!has("no-open")) {
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      execFile(opener, [out], () => {});
    }
    process.exit(0);
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
    process.exit(1);
  }

  const detailed = [];
  for (const f of picked) {
    const d = readSessionDetail(f.path, { rateOverrides: cfg.rateOverrides, caps });
    if (d) detailed.push(d);
  }

  const outDir = join(ROOT, "marmot");
  mkdirSync(outDir, { recursive: true });
  const out = flag("out", join(outDir, `sessions-${new Date().toISOString().slice(0, 10)}.html`));
  const html = buildHtml(detailed, { days: DAYS, root: ROOT, redacted });
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
  process.exit(0);
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
const nudges = evaluate(sessions, cfg, {
  root: ROOT,
  // Demo runs must not read this machine's MCP config, or the demo reports on you.
  configured: DEMO ? ["github", "sentry", "postgres", "datadog"] : undefined,
});

if (cmd === "doctor") {
  const t = totals(sessions);
  const unpriced = new Set(sessions.flatMap((s) => [...s.unpricedModels]));
  const noPrompts = sessions.filter((s) => s.typedPrompts === 0).length;
  process.stdout.write(`
  Root            ${ROOT}
  Sessions        ${num(sessions.length)} in ${DAYS} days
  Thresholds      ${cfg._exists ? cfg._path : "defaults (no config file — run `marmot init` to write one)"}
  Priced turns    ${num(sessions.reduce((a, s) => a + s.pricedTurns, 0))} of ${num(t.turns)}
  Unpriced models ${unpriced.size ? [...unpriced].join(", ") : "none"}
  Sessions with 0 typed prompts  ${noPrompts}${noPrompts ? "  (resumed or agent-driven; not a fault)" : ""}

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
  process.stdout.write("\n");
  for (const s of sessions) {
    process.stdout.write(
      `  ${s.day}  ${usd(s.cost).padStart(9)}  ${String(s.typedPrompts).padStart(4)} prompts  ${String(s.assistantTurns).padStart(5)} turns  ${dim(s.cwd ?? "")}\n`,
    );
  }
  process.stdout.write("\n");
  process.exit(0);
}

process.stdout.write(renderReport(sessions, cfg, { days: DAYS, nudges, demo: DEMO }));
