/**
 * The audit talks a real protocol to a real process, so these tests run one:
 * `fakeServer()` writes a tiny MCP server and the client speaks to it over
 * stdio exactly as it would to github or sentry. Nothing here reaches a network.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readServerConfigs, measureTools, auditServer, auditServers, readAudit, auditPath } from "../src/mcp.mjs";
import { tmpRoot } from "./helpers.mjs";

/** A stdio MCP server that answers initialize and tools/list. */
function fakeServer(root, { tools = 3, behaviour = "ok" } = {}) {
  const file = join(root, `server-${behaviour}-${tools}.mjs`);
  const list = Array.from({ length: tools }, (_, i) => ({
    name: `tool_${i}`,
    description: `Tool number ${i}, which does a thing worth describing at length.`,
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
  }));
  writeFileSync(
    file,
    `
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (${behaviour === "silent"}) continue;
    if (msg.method === "initialize") {
      ${behaviour === "noise" ? 'process.stdout.write("starting up, not JSON" + String.fromCharCode(10));' : ""}
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {} } }) + "\\n");
    } else if (msg.method === "tools/list") {
      ${
        behaviour === "error"
          ? 'process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { message: "no tools for you" } }) + "\\n");'
          : `process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: ${JSON.stringify(list)} } }) + "\\n");`
      }
    }
  }
});
`,
  );
  return { command: process.execPath, args: [file] };
}

/* ── discovery ─────────────────────────────────────────────────────────── */

test("servers are found in all four places, ~/.claude.json included", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const home = join(root, "home");
  const claude = join(home, ".claude");
  const cwd = join(root, "proj");
  mkdirSync(claude, { recursive: true });
  mkdirSync(cwd, { recursive: true });

  writeFileSync(join(claude, "mcp.json"), JSON.stringify({ mcpServers: { fromMcpJson: {} } }));
  writeFileSync(join(claude, "settings.json"), JSON.stringify({ mcpServers: { fromSettings: {} } }));
  // The big one: ~/.claude.json sits beside the directory, not inside it, and
  // carries both global servers and a per-project set.
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({ mcpServers: { fromClaudeJson: {} }, projects: { [cwd]: { mcpServers: { fromProject: {} } } } }),
  );
  writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { fromDotMcp: {} } }));

  const found = Object.keys(readServerConfigs(claude, cwd)).sort();
  assert.deepEqual(found, ["fromClaudeJson", "fromDotMcp", "fromMcpJson", "fromProject", "fromSettings"]);
});

test("another project's servers are not attributed to this one", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const home = join(root, "home");
  const claude = join(home, ".claude");
  mkdirSync(claude, { recursive: true });
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({ projects: { "/somewhere/else": { mcpServers: { theirs: {} } }, "/here": { mcpServers: { mine: {} } } } }),
  );
  assert.deepEqual(Object.keys(readServerConfigs(claude, "/here")), ["mine"]);
});

test("malformed and missing config files are skipped", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  writeFileSync(join(root, "mcp.json"), "{ broken");
  assert.deepEqual(readServerConfigs(root, null), {});
  assert.deepEqual(readServerConfigs("/nonexistent/root", null), {});
});

/* ── measurement ───────────────────────────────────────────────────────── */

test("tool schemas are measured as they go over the wire", () => {
  const tools = [
    { name: "small", description: "x", inputSchema: {} },
    { name: "big", description: "y".repeat(400), inputSchema: { type: "object" } },
  ];
  const m = measureTools(tools);
  assert.equal(m.count, 2);
  assert.ok(m.tokens > 100);
  assert.equal(m.tools[0].name, "big", "biggest first, so the cost is attributable");
  assert.ok(m.tools[0].tokens > m.tools[1].tokens);
});

test("an empty or absent tool list measures zero", () => {
  assert.deepEqual(measureTools([]), { count: 0, bytes: 0, tokens: 0, tools: [] });
  assert.equal(measureTools(undefined).count, 0);
});

/* ── the protocol, against a real process ──────────────────────────────── */

test("a stdio server is asked for its tools and measured", async (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const r = await auditServer("fake", fakeServer(root, { tools: 4 }), { timeoutMs: 10_000 });
  assert.equal(r.error, null);
  assert.equal(r.transport, "stdio");
  assert.equal(r.count, 4);
  assert.ok(r.tokens > 0);
});

test("a server that logs plain text to stdout is still readable", async (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const r = await auditServer("noisy", fakeServer(root, { tools: 2, behaviour: "noise" }), { timeoutMs: 10_000 });
  assert.equal(r.error, null);
  assert.equal(r.count, 2);
});

test("a server that never answers times out instead of hanging", async (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const r = await auditServer("silent", fakeServer(root, { behaviour: "silent" }), { timeoutMs: 700 });
  assert.match(r.error, /no reply/);
  assert.equal(r.tokens, null);
});

test("a server that refuses tools/list reports why", async (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const r = await auditServer("cross", fakeServer(root, { behaviour: "error" }), { timeoutMs: 10_000 });
  assert.equal(r.error, "no tools for you");
});

test("a command that does not exist is an error, not a crash", async () => {
  const r = await auditServer("missing", { command: "definitely-not-a-real-binary-xyzzy", args: [] }, { timeoutMs: 5_000 });
  assert.ok(r.error);
  assert.equal(r.count, null);
});

test("an http server with no url is rejected without a request", async () => {
  const r = await auditServer("bad", { type: "http" }, { timeoutMs: 500 });
  assert.equal(r.error, "no url");
  assert.equal(r.transport, "http");
});

test("every server is audited, and the biggest reported first", async (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const seen = [];
  const rows = await auditServers(
    { small: fakeServer(root, { tools: 1 }), large: fakeServer(root, { tools: 6 }), broken: { command: "nope-xyzzy" } },
    { timeoutMs: 10_000, onResult: (r) => seen.push(r.name) },
  );
  assert.equal(rows.length, 3);
  assert.equal(seen.length, 3, "each result is reported as it lands");
  assert.equal(rows[0].name, "large");
  assert.equal(rows[rows.length - 1].name, "broken", "servers that failed sort last");
});

/* ── the saved result ──────────────────────────────────────────────────── */

test("a saved audit is read back, and a missing or broken one is null", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  assert.equal(readAudit(root), null);

  writeFileSync(auditPath(root), JSON.stringify({ measuredAt: "2026-09-01T00:00:00Z", servers: { sentry: { count: 14, tokens: 2300 } } }));
  assert.equal(readAudit(root).servers.sentry.tokens, 2300);

  writeFileSync(auditPath(root), "{ broken");
  assert.equal(readAudit(root), null);

  writeFileSync(auditPath(root), JSON.stringify({ nothing: true }));
  assert.equal(readAudit(root), null, "a file without servers is not an audit");
});
