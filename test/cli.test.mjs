/**
 * The end-to-end drill from CLAUDE.md, run automatically.
 *
 * Every command still runs, `--no-text` really redacts, and the page is valid
 * and self-contained. These are the checks that were being done by hand.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpRoot, writeSession, prompt, toolUse, response, usage } from "./helpers.mjs";

const CLI = fileURLToPath(new URL("../bin/marmot.mjs", import.meta.url));

const run = (args, { expectFail = false } = {}) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    if (!expectFail) throw new Error(`marmot ${args.join(" ")} exited ${e.status}\n${e.stdout}\n${e.stderr}`);
    return { code: e.status, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
};

/** A root with one realistic session in it. */
function populatedRoot() {
  const { root, cleanup } = tmpRoot();
  const entries = [prompt("fix the retry path")];
  for (let i = 0; i < 30; i += 1) {
    entries.push(
      response({
        id: `m${i}`,
        u: usage({ input: 200, output: 800, cacheRead: 30_000, write1h: 4_000 }),
        thinking: "considering",
        text: `MY-SECRET-REPLY-${i}`,
        tools: [toolUse("Bash", { command: `run step ${i}` }), toolUse("Read", { file_path: `/repo/f${i}.ts` })],
      }),
    );
  }
  entries.push(prompt("MY-SECRET-PROMPT ship it"));
  writeSession(root, { project: "-repo", id: "sess-aaaa1111", entries });
  return { root, cleanup };
}

test("every command runs against a populated root", (t) => {
  const { root, cleanup } = populatedRoot();
  t.after(cleanup);
  for (const args of [["report", "--days", "7"], ["nudges", "--days", "7"], ["sessions", "--days", "7"], ["doctor"], ["help"], ["report", "--days", "7", "--json"]]) {
    const { out } = run([...args, "--root", root]);
    assert.ok(out.length > 0, `marmot ${args.join(" ")} printed nothing`);
  }
});

test("every command runs in demo mode without reading the machine", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  // The demo must not report on this machine's real MCP config.
  mkdirSync(join(root, "projects"), { recursive: true });
  writeFileSync(join(root, "mcp.json"), JSON.stringify({ mcpServers: { "a-real-private-server": {} } }));
  for (const args of [["report"], ["nudges"], ["sessions"]]) {
    const { out } = run([...args, "--demo", "--root", root]);
    assert.ok(!out.includes("a-real-private-server"), `${args[0]} --demo leaked the real MCP config`);
  }
});

test("report --json is machine-readable and carries the window", (t) => {
  const { root, cleanup } = populatedRoot();
  t.after(cleanup);
  const { out } = run(["report", "--days", "7", "--json", "--root", root]);
  const data = JSON.parse(out);
  assert.equal(data.window.days, 7);
  assert.equal(data.sessions.length, 1);
  assert.equal(data.sessions[0].typedPrompts, 2);
  assert.equal(data.sessions[0].assistantTurns, 30, "usage deduped end to end");
  assert.equal(data.sessions[0].toolCalls, 60);
  assert.ok(data.totals.cost > 0);
});

test("a slash command that failed to substitute its argument does not become NaN days", (t) => {
  const { root, cleanup } = populatedRoot();
  t.after(cleanup);
  // The literal `${1:-30}` bug: posInt must fall back rather than print "NaN".
  for (const bad of ["${1:-30}", "abc", "-5", "0"]) {
    const { out } = run(["report", "--days", bad, "--root", root]);
    assert.ok(!out.includes("NaN"), `--days ${bad} produced NaN`);
    assert.match(out, /last 30 days/, `--days ${bad} should fall back to 30`);
  }
});

test("an empty root explains itself and exits non-zero", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const { code, out } = run(["report", "--root", root], { expectFail: true });
  assert.equal(code, 1);
  assert.match(out, /No sessions/);
});

test("doctor reports what is readable here", (t) => {
  const { root, cleanup } = populatedRoot();
  t.after(cleanup);
  const { out } = run(["doctor", "--days", "7", "--root", root]);
  assert.match(out, /Root\s+/);
  assert.match(out, /Priced turns\s+30 of 30/);
  assert.match(out, /Unpriced models\s+none/);
});

test("init writes the thresholds and refuses to clobber them", (t) => {
  const { root, cleanup } = populatedRoot();
  t.after(cleanup);
  const first = run(["init", "--root", root]);
  assert.match(first.out, /Wrote/);
  const cfg = JSON.parse(readFileSync(join(root, "marmot.json"), "utf8"));
  assert.equal(cfg.session.turnCap, 20);
  assert.ok(!("_path" in cfg), "internal fields stay out of the written file");

  const second = run(["init", "--root", root]);
  assert.match(second.out, /already exists/);
});

test("config creates the thresholds file with the defaults when there is none", (t) => {
  const { root, cleanup } = populatedRoot();
  t.after(cleanup);
  const { out } = run(["config", "--no-open", "--root", root]);
  assert.match(out, /marmot\.json/);
  assert.match(out, /created/);

  const cfg = JSON.parse(readFileSync(join(root, "marmot.json"), "utf8"));
  assert.equal(cfg.session.turnCap, 20);
  assert.ok(!("_path" in cfg) && !("_exists" in cfg), "internal fields stay out of the file");
});

test("config never clobbers thresholds you have already edited", (t) => {
  const { root, cleanup } = populatedRoot();
  t.after(cleanup);
  writeFileSync(join(root, "marmot.json"), JSON.stringify({ session: { costCap: 500 } }, null, 2));

  const { out } = run(["config", "--no-open", "--root", root]);
  assert.ok(!out.includes("created"), "an existing file is opened, not rewritten");
  assert.deepEqual(JSON.parse(readFileSync(join(root, "marmot.json"), "utf8")), { session: { costCap: 500 } });
});

test("config --print shows the file, and the path either way", (t) => {
  const { root, cleanup } = populatedRoot();
  t.after(cleanup);
  const quiet = run(["config", "--no-open", "--root", root]).out;
  assert.ok(!quiet.includes("turnCap"), "without --print it is just the path");

  const printed = run(["config", "--no-open", "--print", "--root", root]).out;
  assert.match(printed, /"turnCap": 20/);
  assert.match(printed, /marmot\.json/);
  // Whatever it printed after the path must be the file, parseable as JSON.
  const body = printed.slice(printed.indexOf("{"));
  assert.doesNotThrow(() => JSON.parse(body));
});

test("the file config writes is one loadConfig accepts", async (t) => {
  const { root, cleanup } = populatedRoot();
  t.after(cleanup);
  run(["config", "--no-open", "--root", root]);
  const { loadConfig } = await import("../src/config.mjs");
  const cfg = loadConfig(root);
  assert.equal(cfg._exists, true);
  assert.equal(cfg.session.costCap, 25);
  assert.deepEqual(cfg.live, ["session-cost", "daily-cost", "daily-baseline", "session-turns", "limit-reached"]);
});

test("report --sessions folds the per-session list into the report", (t) => {
  const { root, cleanup } = populatedRoot();
  t.after(cleanup);
  const plain = run(["report", "--days", "7", "--root", root]).out;
  const withList = run(["report", "--days", "7", "--sessions", "--root", root]).out;

  assert.ok(!plain.includes("Sessions ·"), "the list is opt-in");
  assert.match(withList, /Sessions · 1/);
  assert.match(withList, /2 prompts/, "a session line carries the prompt count");
  // The report itself is still all there.
  assert.match(withList, /Prompts you typed/);
});

test("a piped run writes no page and opens nothing", (t) => {
  const { root, cleanup } = populatedRoot();
  t.after(cleanup);
  // How an agent, a script or a cron job calls it. Building a multi-megabyte
  // page and taking over the display is not what those callers asked for, and
  // the tests themselves run this way — so this is also why the suite is quiet.
  const { out } = run(["report", "--days", "7", "--no-audit", "--root", root]);
  assert.match(out, /Prompts you typed/, "the report still prints");
  assert.equal(existsSync(join(root, "marmot")), false, "and nothing was written");
});

test("--browse forces the page even when output is piped", (t) => {
  const { root, cleanup } = populatedRoot();
  t.after(cleanup);
  const out = join(root, "page.html");
  const { out: stdout } = run(["report", "--days", "7", "--sessions", "--browse", "--no-open", "--no-audit", "--out", out, "--root", root]);
  assert.match(stdout, /Prompts you typed/);
  assert.match(stdout, /Sessions · 1/);
  assert.match(stdout, /Wrote /);
  assert.ok(readFileSync(out, "utf8").includes("sess-aaaa1111"));
});

test("marmot sessions and report --sessions render the same lines", (t) => {
  const { root, cleanup } = populatedRoot();
  t.after(cleanup);
  const standalone = run(["sessions", "--days", "7", "--root", root]).out.trim();
  const folded = run(["report", "--days", "7", "--sessions", "--root", root]).out;
  assert.ok(folded.includes(standalone), "one renderer, so the two cannot drift");
});

test("config set changes a threshold without opening an editor", (t) => {
  const { root, cleanup } = populatedRoot();
  t.after(cleanup);
  run(["config", "--no-open", "--root", root]);

  const { out } = run(["config", "set", "session.costCap=50", "limits.steps=[25,50,75]", "notify.bell=false", "--root", root]);
  assert.match(out, /session\.costCap: 25 → 50/, "it says what it changed");

  const cfg = JSON.parse(readFileSync(join(root, "marmot.json"), "utf8"));
  // JSON first, so a number is a number and a list is a list — not the string
  // you typed, which would silently fail every comparison in the rules.
  assert.equal(cfg.session.costCap, 50);
  assert.deepEqual(cfg.limits.steps, [25, 50, 75]);
  assert.equal(cfg.notify.bell, false);
  assert.equal(cfg.session.turnCap, 20, "siblings are left alone");
});

test("config set creates the file from the defaults when there is none", (t) => {
  const { root, cleanup } = populatedRoot();
  t.after(cleanup);
  run(["config", "set", "session.turnCap=40", "--root", root]);
  const cfg = JSON.parse(readFileSync(join(root, "marmot.json"), "utf8"));
  assert.equal(cfg.session.turnCap, 40);
  assert.equal(cfg.daily.costCap, 50, "and the rest of the defaults come with it");
});

test("config set builds a path that does not exist yet", (t) => {
  const { root, cleanup } = populatedRoot();
  t.after(cleanup);
  run(["config", "set", "limits.byPlan.Pro=[10,20]", "--root", root]);
  assert.deepEqual(JSON.parse(readFileSync(join(root, "marmot.json"), "utf8")).limits.byPlan.Pro, [10, 20]);
});

test("config set with nothing to set explains itself", (t) => {
  const { root, cleanup } = populatedRoot();
  t.after(cleanup);
  const { code, out } = run(["config", "set", "--root", root], { expectFail: true });
  assert.equal(code, 1);
  assert.match(out, /Usage: marmot config set/);
});

test("what config set writes is what loadConfig reads", async (t) => {
  const { root, cleanup } = populatedRoot();
  t.after(cleanup);
  run(["config", "set", "session.costCap=99", "limits.enabled=false", "--root", root]);
  const { loadConfig } = await import("../src/config.mjs");
  const cfg = loadConfig(root);
  assert.equal(cfg.session.costCap, 99);
  assert.equal(cfg.limits.enabled, false);
});

test("installing hooks leaves everything else in settings.json alone", (t) => {
  const { root, cleanup } = populatedRoot();
  t.after(cleanup);
  const sp = join(root, "settings.json");
  writeFileSync(sp, JSON.stringify({
    statusLine: { type: "command", command: "mine" },
    permissions: { allow: ["Bash"] },
    hooks: { Stop: [{ hooks: [{ type: "command", command: "someone-elses-hook" }] }] },
  }));

  run(["init", "--hooks", "--root", root]);
  const after = JSON.parse(readFileSync(sp, "utf8"));
  assert.deepEqual(after.statusLine, { type: "command", command: "mine" });
  assert.deepEqual(after.permissions, { allow: ["Bash"] });
  assert.ok(after.hooks.Stop.some((g) => g.hooks.some((h) => h.command === "someone-elses-hook")), "another tool's hook survives");
  assert.equal(after.hooks.Stop.length, 2, "and ours is added beside it");
});

test("installing hooks keeps a copy of what was there", (t) => {
  const { root, cleanup } = populatedRoot();
  t.after(cleanup);
  const sp = join(root, "settings.json");
  const before = JSON.stringify({ statusLine: { type: "command", command: "mine" } });
  writeFileSync(sp, before);

  run(["init", "--hooks", "--root", root]);
  assert.equal(readFileSync(`${sp}.marmot-backup`, "utf8"), before, "byte for byte, so undoing does not depend on us being right");
});

test("--dry-run writes nothing at all", (t) => {
  const { root, cleanup } = populatedRoot();
  t.after(cleanup);
  const sp = join(root, "settings.json");
  const { out } = run(["init", "--hooks", "--dry-run", "--root", root]);
  assert.match(out, /Would change/);
  assert.match(out, /add SessionStart/);
  assert.match(out, /Nothing has been written/);
  assert.equal(existsSync(sp), false, "no file appeared");
});

test("--remove takes out only Marmot's own hooks", (t) => {
  const { root, cleanup } = populatedRoot();
  t.after(cleanup);
  const sp = join(root, "settings.json");
  writeFileSync(sp, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "someone-elses-hook" }] }] } }));

  run(["init", "--hooks", "--root", root]);
  run(["init", "--hooks", "--remove", "--root", root]);

  const after = JSON.parse(readFileSync(sp, "utf8"));
  assert.deepEqual(after.hooks.Stop, [{ hooks: [{ type: "command", command: "someone-elses-hook" }] }]);
  assert.ok(!after.hooks.SessionStart, "and the event we emptied is gone entirely");

  const { out } = run(["init", "--hooks", "--remove", "--root", root]);
  assert.match(out, /nothing to remove/, "removing twice is not an error");
});

test("a settings file that is not JSON is refused, never overwritten", (t) => {
  const { root, cleanup } = populatedRoot();
  t.after(cleanup);
  const sp = join(root, "settings.json");
  writeFileSync(sp, "{ this is not json");

  const { code, out } = run(["init", "--hooks", "--root", root], { expectFail: true });
  assert.equal(code, 1);
  assert.match(out, /not valid JSON/);
  assert.equal(readFileSync(sp, "utf8"), "{ this is not json", "the file we could not read is the file we must not destroy");
});

test("doctor says whether the nudge hooks are actually wired up", (t) => {
  const { root, cleanup } = populatedRoot();
  t.after(cleanup);
  // "Installed" and "working" are different states, and the gap is silent.
  assert.match(run(["doctor", "--days", "7", "--no-audit", "--root", root]).out, /Nudge hooks\s+not installed/);

  run(["init", "--hooks", "--root", root]);
  assert.match(run(["doctor", "--days", "7", "--no-audit", "--root", root]).out, /Nudge hooks\s+SessionStart, Stop/);
});

test("doctor names a half-installed or broken hook rather than passing it", (t) => {
  const { root, cleanup } = populatedRoot();
  t.after(cleanup);
  run(["init", "--hooks", "--root", root]);
  const sp = join(root, "settings.json");

  const settings = JSON.parse(readFileSync(sp, "utf8"));
  delete settings.hooks.Stop;
  writeFileSync(sp, JSON.stringify(settings));
  assert.match(run(["doctor", "--days", "7", "--no-audit", "--root", root]).out, /Stop missing/);

  // A hook pointing at a deleted install looks fine in settings.json and does
  // nothing at all.
  settings.hooks.SessionStart[0].hooks[0].command = 'node "/gone/marmot/scripts/hook.mjs"';
  writeFileSync(sp, JSON.stringify(settings));
  assert.match(run(["doctor", "--days", "7", "--no-audit", "--root", root]).out, /points at a missing file/);
});

/* ── the browser page ──────────────────────────────────────────────────── */

const buildPage = (root, extra = []) => {
  const out = join(root, "page.html");
  run(["browse", "--days", "7", "--limit", "3", "--no-open", "--out", out, "--root", root, ...extra]);
  return readFileSync(out, "utf8");
};

test("--no-text leaves every character of prompt and reply text out of the page", (t) => {
  const { root, cleanup } = populatedRoot();
  t.after(cleanup);
  const html = buildPage(root, ["--no-text"]);
  assert.ok(!html.includes("MY-SECRET-PROMPT"), "a prompt leaked into a redacted page");
  assert.ok(!html.includes("MY-SECRET-REPLY"), "a reply leaked into a redacted page");
  // Tool names and counts are the point of the redacted page, so they stay.
  assert.ok(html.includes("Bash"), "tool names should survive redaction");
});

test("without --no-text the page carries the text, and says so on stdout", (t) => {
  const { root, cleanup } = populatedRoot();
  t.after(cleanup);
  const out = join(root, "page.html");
  const { out: stdout } = run(["browse", "--days", "7", "--no-open", "--out", out, "--root", root]);
  assert.match(stdout, /contains your prompts/);
  assert.ok(readFileSync(out, "utf8").includes("MY-SECRET-PROMPT"));
});

test("the page never carries tool result bodies", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const secret = "TOOL-RESULT-BODY-SHOULD-NEVER-APPEAR";
  writeSession(root, {
    id: "s1",
    entries: [
      prompt("read it"),
      response({ id: "m1", u: usage({ output: 10 }), tools: [toolUse("Read", { file_path: "/a.ts" }, "t1")] }),
      {
        type: "user",
        promptSource: "system",
        timestamp: "2026-09-01T10:00:00.000Z",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: secret }] },
        toolUseResult: { stdout: secret },
      },
    ],
  });
  assert.ok(!buildPage(root).includes(secret));
});

test("the page is self-contained: no network references at all", (t) => {
  const { root, cleanup } = populatedRoot();
  t.after(cleanup);
  const html = buildPage(root);
  for (const rx of [/<script[^>]+src=/i, /<link[^>]+href=["']https?:/i, /@import\s+url\(/i, /src=["']https?:/i]) {
    assert.ok(!rx.test(html), `page references something external: ${rx}`);
  }
  assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(html.replace(/MY-SECRET-[A-Z0-9-]+/g, "")), "no external URLs");
});

test("the page's inline script parses, and its data payload is valid JSON", async (t) => {
  const { root, cleanup } = populatedRoot();
  t.after(cleanup);
  const html = buildPage(root);
  const blocks = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].map((m) => ({ attrs: m[1], src: m[2] })).filter((b) => b.src.trim());
  assert.ok(blocks.length >= 2, "the page should carry a data payload and a script");

  const { execFileSync: exec } = await import("node:child_process");
  let sawJson = false;
  let sawCode = false;
  for (const [i, b] of blocks.entries()) {
    if (/type\s*=\s*["']application\/json["']/i.test(b.attrs)) {
      // The embedded payload is data, not code — it must parse as JSON.
      sawJson = true;
      assert.doesNotThrow(() => JSON.parse(b.src), `data payload ${i} is not valid JSON`);
      assert.ok(!b.src.includes("</script"), "the payload must not be able to close its own tag");
    } else {
      sawCode = true;
      const f = join(root, `script-${i}.js`);
      writeFileSync(f, b.src);
      assert.doesNotThrow(() => exec(process.execPath, ["--check", f], { stdio: "pipe" }), `inline script ${i} does not parse`);
    }
  }
  assert.ok(sawJson && sawCode, "expected both a JSON payload and executable script");
});

test("old pages are pruned, so the directory cannot fill up", (t) => {
  const { root, cleanup } = populatedRoot();
  t.after(cleanup);
  const dir = join(root, "marmot");
  mkdirSync(dir, { recursive: true });
  // Seven earlier runs, oldest first.
  for (let i = 0; i < 7; i += 1) {
    const f = join(dir, `sessions-2026-08-0${i + 1}-10-00.html`);
    writeFileSync(f, "old");
    utimesSync(f, new Date(Date.now() - (10 - i) * 86_400_000), new Date(Date.now() - (10 - i) * 86_400_000));
  }
  writeFileSync(join(dir, "keep-me.txt"), "not ours");

  run(["browse", "--days", "7", "--no-open", "--no-audit", "--root", root]);

  const left = readdirSync(dir).filter((f) => f.endsWith(".html"));
  assert.equal(left.length, 5, `kept ${left.length}: ${left.join(", ")}`);
  assert.ok(!left.includes("sessions-2026-08-01-10-00.html"), "the oldest went first");
  assert.ok(readdirSync(dir).includes("keep-me.txt"), "and nothing that is not ours is touched");
});

test("an explicit --out is never pruned against", (t) => {
  const { root, cleanup } = populatedRoot();
  t.after(cleanup);
  const dir = join(root, "marmot");
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 7; i += 1) writeFileSync(join(dir, `sessions-2026-08-0${i + 1}-10-00.html`), "old");

  // Writing somewhere you named is not a managed run; leave the rest alone.
  run(["browse", "--days", "7", "--no-open", "--no-audit", "--out", join(root, "mine.html"), "--root", root]);
  assert.equal(readdirSync(dir).filter((f) => f.endsWith(".html")).length, 7);
});

test("the page and the report quote the same figures", (t) => {
  const { root, cleanup } = populatedRoot();
  t.after(cleanup);

  const report = run(["report", "--days", "7", "--no-audit", "--root", root]).out;
  const out = join(root, "page.html");
  run(["browse", "--days", "7", "--no-open", "--no-audit", "--out", out, "--root", root]);
  const html = readFileSync(out, "utf8");
  const payload = JSON.parse(/<script[^>]*id="data"[^>]*>([\s\S]*?)<\/script>/.exec(html)[1].replace(/\\u003c/g, "<"));

  assert.ok(payload.summary, "the page carries a precomputed summary");
  const t2 = payload.summary.totals;

  // The report prints these; the page must agree on all of them, because they
  // are computed once in Node and shipped, not recomputed in the browser.
  assert.match(report, new RegExp(`Prompts you typed\\s+${t2.prompts}`));
  assert.match(report, new RegExp(`Model turns\\s+${t2.turns.toLocaleString("en-US")}`));
  assert.equal(t2.sessions, 1);
  assert.ok(t2.baseline > 0, "and the page knows the baseline context");
  assert.ok(t2.promptsPerSession, "and the prompt distribution");
});

test("the page carries the same nudges the report prints", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  // A session well past the cost cap, so at least one rule has to fire.
  const entries = [prompt("go")];
  for (let i = 0; i < 40; i += 1) {
    entries.push(prompt(`step ${i}`));
    entries.push(response({ id: `m${i}`, u: usage({ input: 5_000, output: 20_000, cacheRead: 200_000, write1h: 50_000 }), text: "working" }));
  }
  writeSession(root, { id: "spendy", entries });

  const out = join(root, "page.html");
  run(["browse", "--days", "7", "--no-open", "--no-audit", "--out", out, "--root", root]);
  const html = readFileSync(out, "utf8");
  const payload = JSON.parse(/<script[^>]*id="data"[^>]*>([\s\S]*?)<\/script>/.exec(html)[1].replace(/\\u003c/g, "<"));

  const ids = payload.summary.nudges.sessionNudges.map((g) => g.id);
  assert.ok(ids.includes("session-cost"), `expected session-cost, got ${ids.join(", ")}`);
  const report = run(["report", "--days", "7", "--no-audit", "--root", root]).out;
  assert.match(report, /Session past the cost cap/);
});

test("the page embeds a payload the browser can parse", (t) => {
  const { root, cleanup } = populatedRoot();
  t.after(cleanup);
  const html = buildPage(root);
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /<\/html>\s*$/i);
  assert.ok(html.includes("sess-aaaa1111"), "the session should appear in the page");
});

test("browse --session picks one session by id prefix", (t) => {
  const { root, cleanup } = populatedRoot();
  t.after(cleanup);
  writeSession(root, { id: "other-bbbb2222", entries: [prompt("second"), response({ id: "x1", u: usage({ output: 10 }), text: "reply" })] });
  const out = join(root, "one.html");
  const { out: stdout } = run(["browse", "--session", "sess-aaaa", "--no-open", "--out", out, "--root", root]);
  assert.match(stdout, /1 sessions?/);
  assert.ok(!readFileSync(out, "utf8").includes("other-bbbb2222"));
});

test("browse on an unknown session id fails with a clear message", (t) => {
  const { root, cleanup } = populatedRoot();
  t.after(cleanup);
  const { code, out } = run(["browse", "--session", "nope", "--no-open", "--root", root], { expectFail: true });
  assert.equal(code, 1);
  assert.match(out, /No session matching nope/);
});

test("browse --demo writes a page without touching the real root", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const out = join(root, "demo.html");
  run(["browse", "--demo", "--no-open", "--out", out, "--root", root]);
  const html = readFileSync(out, "utf8");
  assert.match(html, /demo data/);
  assert.ok(html.length > 1000);
});
