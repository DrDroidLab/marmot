#!/usr/bin/env node
/**
 * One line: what this session has cost you so far, and the two numbers the
 * nudges are built on.
 *
 * Claude Code hands us live cost, context and cache-hit figures on stdin, so
 * none of that needs parsing. Only the typed-prompt count does — and this hook
 * runs on every keystroke-ish event, so it reads the transcript *incrementally*,
 * counting only the bytes appended since the last call. A multi-megabyte
 * session file is scanned once, not on every refresh.
 */

import { openSync, readSync, closeSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "../src/config.mjs";
import { defaultRoot } from "../src/sessions.mjs";

const CACHE = join(homedir(), ".claude", "marmot-statusline.json");

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
let d = {};
try {
  d = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
} catch {
  process.exit(0);
}

function typedPrompts(path, sessionId) {
  if (!path) return null;
  let size;
  try {
    size = statSync(path).size;
  } catch {
    return null;
  }
  let cache = {};
  try {
    cache = JSON.parse(readFileSync(CACHE, "utf8"));
  } catch {
    /* first run */
  }
  const prev = cache[sessionId];
  // A shrunken file means a different session reusing the id; start over.
  const from = prev && prev.size <= size ? prev.size : 0;
  let count = from ? prev.count : 0;
  if (size > from) {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(size - from);
      readSync(fd, buf, 0, buf.length, from);
      let text = buf.toString("utf8");
      // Only whole lines; the tail is re-read next time from the last newline.
      const cut = text.lastIndexOf("\n");
      const consumed = cut < 0 ? 0 : Buffer.byteLength(text.slice(0, cut + 1), "utf8");
      text = cut < 0 ? "" : text.slice(0, cut + 1);
      count += (text.match(/"promptSource"\s*:\s*"typed"/g) ?? []).length;
      cache[sessionId] = { size: from + consumed, count };
    } finally {
      closeSync(fd);
    }
    try {
      const keys = Object.keys(cache);
      if (keys.length > 50) cache = Object.fromEntries(keys.slice(-50).map((k) => [k, cache[k]]));
      writeFileSync(CACHE, JSON.stringify(cache));
    } catch {
      /* an unwritable cache costs speed, not correctness */
    }
  }
  return count;
}

const cfg = loadConfig(defaultRoot());
const cost = d.cost?.total_cost_usd ?? 0;
const ctx = d.context_window?.used_percentage;
const hit = d.prompt_cache?.hit_ratio;
const prompts = typedPrompts(d.transcript_path, d.session_id ?? "unknown");

const D = "\x1b[2m", R = "\x1b[0m", Y = "\x1b[33m", B = "\x1b[1m";
const money = cost >= 100 ? `$${Math.round(cost)}` : `$${cost.toFixed(2)}`;
const over = cost > cfg.session.costCap;
const manyTurns = prompts !== null && prompts > cfg.session.turnCap;

const parts = [];
parts.push(`${over ? Y : ""}${B}${money}${R}`);
if (prompts !== null) parts.push(`${manyTurns ? Y : D}${prompts} prompts${R}`);
if (typeof ctx === "number") parts.push(`${D}${ctx}% ctx${R}`);
if (typeof hit === "number") parts.push(`${D}${Math.round(hit * 100)}% cache${R}`);
if (d.model?.display_name) parts.push(`${D}${d.model.display_name}${R}`);
if (over || manyTurns) parts.push(`${Y}▲${R}`);

process.stdout.write(parts.join(`${D} · ${R}`));
