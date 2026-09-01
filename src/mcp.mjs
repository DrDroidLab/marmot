/**
 * Asking a server what it costs you.
 *
 * Every attached MCP server's tool definitions are sent with every request, and
 * nothing on disk records how big they are — not the transcript, not the caches,
 * not the debug logs. The only way to a real number is to ask the server, which
 * is why this is an explicit `marmot mcp-audit` rather than something the report
 * does behind your back. It is the one part of Marmot that starts a process
 * instead of reading a file.
 *
 * The result is written to `~/.claude/marmot-mcp.json`, and the read-only report
 * picks it up from there if it exists. Run it once and the idle-server nudge can
 * quote real tokens instead of a shrug.
 */

import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { estimateTokens } from "./skills.mjs";

const PROTOCOL = "2024-11-05";
const CLIENT = { name: "marmot", version: "0.1.0" };

/**
 * Every configured server with its full config, not just its name.
 *
 * Four places, and `~/.claude.json` is the one that matters most — it holds
 * both the global servers and a per-project set under `projects[cwd]`. Reading
 * only `~/.claude/mcp.json` found 3 of the 10 servers on the machine this was
 * written on, which made the idle-server nudge quietly useless.
 */
export function readServerConfigs(root, cwd = null) {
  const out = {};
  const take = (servers) => {
    for (const [name, cfg] of Object.entries(servers ?? {})) out[name] ??= cfg;
  };
  const read = (p) => {
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      return null; // a malformed config is a finding for the report, not a crash
    }
  };

  take(read(join(root, "mcp.json"))?.mcpServers);
  take(read(join(root, "settings.json"))?.mcpServers);

  // `~/.claude.json` sits beside the directory, not inside it.
  const main = read(`${root}.json`);
  take(main?.mcpServers);
  if (cwd) take(main?.projects?.[cwd]?.mcpServers);

  if (cwd) take(read(join(cwd, ".mcp.json"))?.mcpServers);
  return out;
}

/** The tokens a tool list costs, as the schema actually goes over the wire. */
export function measureTools(tools) {
  let bytes = 0;
  const each = [];
  for (const t of tools ?? []) {
    const b = Buffer.byteLength(JSON.stringify(t));
    bytes += b;
    each.push({ name: t?.name ?? "(unnamed)", bytes: b, tokens: estimateTokens(b) });
  }
  return { count: each.length, bytes, tokens: estimateTokens(bytes), tools: each.sort((a, b) => b.bytes - a.bytes) };
}

const rpc = (id, method, params) => JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params: params ?? {} }) + "\n";

/** Ask a stdio server for its tools. Never throws; reports what went wrong. */
function listToolsStdio(cfg, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cfg.command, cfg.args ?? [], {
        env: { ...process.env, ...(cfg.env ?? {}) },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      return resolve({ error: e.message });
    }

    let buf = "";
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve(r);
    };

    const timer = setTimeout(() => finish({ error: `no reply in ${Math.round(timeoutMs / 1000)}s` }), timeoutMs);

    child.on("error", (e) => finish({ error: e.message }));
    child.stderr?.on("data", () => {
      /* servers log freely on stderr; it is not an error signal */
    });

    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // a server writing plain text to stdout
        }
        if (msg.id === 1) {
          // Initialised. Announce, then ask for the tools.
          try {
            child.stdin.write(rpc(null, "notifications/initialized"));
            child.stdin.write(rpc(2, "tools/list"));
          } catch (e) {
            finish({ error: e.message });
          }
        } else if (msg.id === 2) {
          if (msg.error) finish({ error: msg.error.message ?? "tools/list failed" });
          else finish({ tools: msg.result?.tools ?? [] });
        }
      }
    });

    try {
      child.stdin.write(rpc(1, "initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT }));
    } catch (e) {
      finish({ error: e.message });
    }
  });
}

/** The same over HTTP. Streamable-HTTP servers answer with SSE, so parse both. */
async function listToolsHttp(cfg, timeoutMs) {
  const url = cfg.url ?? cfg.endpoint;
  if (!url) return { error: "no url" };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const post = (body) =>
    fetch(url, {
      method: "POST",
      signal: ac.signal,
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(cfg.headers ?? {}) },
      body,
    });

  const parse = async (res) => {
    const text = await res.text();
    if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      for (const line of text.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          return JSON.parse(line.slice(5).trim());
        } catch {
          /* keep looking */
        }
      }
      return null;
    }
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };

  try {
    const init = await post(rpc(1, "initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT }));
    if (init.status === 401 || init.status === 403) return { error: "needs authentication" };
    if (!init.ok) return { error: `HTTP ${init.status}` };
    await parse(init);

    const res = await post(rpc(2, "tools/list"));
    if (res.status === 401 || res.status === 403) return { error: "needs authentication" };
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const msg = await parse(res);
    if (!msg) return { error: "unreadable reply" };
    if (msg.error) return { error: msg.error.message ?? "tools/list failed" };
    return { tools: msg.result?.tools ?? [] };
  } catch (e) {
    return { error: e.name === "AbortError" ? `no reply in ${Math.round(timeoutMs / 1000)}s` : e.message };
  } finally {
    clearTimeout(timer);
  }
}

/** One server, measured. Resolves to a row whatever happens. */
export async function auditServer(name, cfg, { timeoutMs = 20_000 } = {}) {
  const isHttp = cfg?.type === "http" || cfg?.type === "sse" || (!cfg?.command && (cfg?.url || cfg?.endpoint));
  const r = isHttp ? await listToolsHttp(cfg, timeoutMs) : await listToolsStdio(cfg, timeoutMs);
  if (r.error) return { name, transport: isHttp ? "http" : "stdio", error: r.error, count: null, tokens: null };
  return { name, transport: isHttp ? "http" : "stdio", error: null, ...measureTools(r.tools) };
}

/** Every server, a few at a time so a slow one does not hold up the rest. */
export async function auditServers(configs, { timeoutMs = 20_000, concurrency = 4, onResult } = {}) {
  const names = Object.keys(configs);
  const rows = [];
  let i = 0;
  const worker = async () => {
    while (i < names.length) {
      const name = names[i++];
      const row = await auditServer(name, configs[name], { timeoutMs });
      rows.push(row);
      onResult?.(row);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, names.length) }, worker));
  return rows.sort((a, b) => (b.tokens ?? -1) - (a.tokens ?? -1));
}

export const auditPath = (root) => join(root, "marmot-mcp.json");

/** What a previous audit measured, if one has been run on this machine. */
export function readAudit(root) {
  const p = auditPath(root);
  if (!existsSync(p)) return null;
  try {
    const d = JSON.parse(readFileSync(p, "utf8"));
    if (!d || typeof d !== "object" || !d.servers) return null;
    return d;
  } catch {
    return null;
  }
}
