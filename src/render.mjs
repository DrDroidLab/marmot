import { byDay } from "./sessions.mjs";
import { usd, pct, num, tokens, mins, dim, bold, warn, info } from "./format.mjs";
import { skillCosts } from "./skills.mjs";

const SHADOW =
  "Cost is a shadow price — what these tokens would have cost at published API rates. On a subscription plan it is not an invoice line. Right for comparing your own sessions, wrong for finance.";

export function wrap(text, width = 76, indent = "  ") {
  const words = text.split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > width) {
      // A word longer than the width starts the first line rather than pushing
      // an empty one before it — a long path in a nudge should not print a gap.
      if (line.trim()) lines.push(line.trim());
      line = w;
    } else line += ` ${w}`;
  }
  if (line.trim()) lines.push(line.trim());
  return lines.map((l) => indent + l).join("\n");
}

function sparkline(values) {
  const bars = "▁▂▃▄▅▆▇█";
  const max = Math.max(...values, 0);
  if (!max) return dim("no spend");
  return values.map((v) => bars[Math.min(7, Math.round((v / max) * 7))]).join("");
}

export function totals(sessions) {
  const t = { cost: 0, prompts: 0, turns: 0, sessions: sessions.length, toolCalls: 0, toolErrors: 0, tok: 0, cacheRead: 0, seen: 0, models: {}, modelTokens: {}, skills: {}, mcp: {}, baselines: [], promptCounts: [] };
  for (const s of sessions) {
    t.cost += s.cost;
    t.prompts += s.typedPrompts;
    t.turns += s.assistantTurns;
    t.toolCalls += s.totalToolCalls;
    t.toolErrors += s.toolErrors;
    t.tok += s.tokens.input + s.tokens.output + s.tokens.cacheRead + s.tokens.cacheWrite;
    t.cacheRead += s.tokens.cacheRead;
    t.seen += s.tokens.cacheRead + s.tokens.cacheWrite + s.tokens.input;
    for (const [m, c] of Object.entries(s.models)) t.models[m] = (t.models[m] ?? 0) + c;
    for (const [m, k] of Object.entries(s.modelTokens ?? {})) t.modelTokens[m] = (t.modelTokens[m] ?? 0) + (k.total ?? 0);
    for (const name of s.skills ?? []) t.skills[name] = (t.skills[name] ?? 0) + 1;
    for (const [srv, n] of Object.entries(s.mcpCalls ?? {})) t.mcp[srv] = (t.mcp[srv] ?? 0) + n;
    if (typeof s.baselineTokens === "number") t.baselines.push(s.baselineTokens);
    t.promptCounts.push(s.typedPrompts ?? 0);
  }
  t.cacheHitRate = t.seen ? t.cacheRead / t.seen : null;
  t.baseline = t.baselines.length ? median(t.baselines) : null;
  t.promptsPerSession = distribution(t.promptCounts);
  return t;
}

/**
 * One line per session, newest first. Used by `marmot sessions` and folded into
 * the report by `--sessions`, so the two can never drift apart.
 */
export function renderSessionList(sessions, { heading = false } = {}) {
  const out = [];
  if (heading) out.push(bold(`  Sessions · ${sessions.length}`), "");
  for (const s of sessions) {
    out.push(
      `  ${s.day}  ${usd(s.cost).padStart(9)}  ${String(s.typedPrompts).padStart(4)} prompts  ${String(s.assistantTurns).padStart(5)} turns  ${dim(s.cwd ?? "")}`,
    );
  }
  return out.join("\n");
}

export function renderReport(sessions, cfg, { days, nudges, demo = false, skillSizes = {} }) {
  const source = demo
    ? "synthetic demo data — nothing here came from your machine"
    : "everything below was read from ~/.claude/projects on this machine";
  const t = totals(sessions);
  const days_ = byDay(sessions);
  const out = [];

  out.push("");
  out.push(bold(`  Marmot · your last ${days} days`));
  out.push(dim(`  ${num(t.sessions)} sessions · ${source}`));
  out.push("");

  const rows = [
    ["Spend", usd(t.cost), "modelled at published rates"],
    ["Sessions", num(t.sessions), `${days_.length} active day${days_.length === 1 ? "" : "s"}`],
    [
      "Prompts you typed",
      num(t.prompts),
      t.sessions ? `per session: ${t.promptsPerSession.mean.toFixed(1)} mean · ${num(t.promptsPerSession.median)} median · ${num(t.promptsPerSession.p99)} p99` : "",
    ],
    ["Model turns", num(t.turns), t.prompts ? `${(t.turns / t.prompts).toFixed(1)} per prompt` : ""],
    ["Tokens", tokens(t.tok), "input, output and cache"],
    ["Cache hit rate", t.cacheHitRate === null ? "—" : pct(t.cacheHitRate), "higher is cheaper"],
    ["Tool calls", num(t.toolCalls), `${t.toolCalls ? pct(t.toolErrors / t.toolCalls) : "0%"} failed`],
  ];
  if (t.baseline !== null) {
    rows.push(["Baseline context", tokens(t.baseline), "median, before you type — prompt, skills, tool definitions"]);
  }
  const pad = Math.max(...rows.map((r) => r[0].length));
  for (const [k, v, note] of rows) out.push(`  ${k.padEnd(pad)}  ${bold(String(v).padEnd(10))} ${dim(note)}`);

  if (days_.length > 1) {
    out.push("");
    out.push(`  ${"Daily".padEnd(pad)}  ${info(sparkline(days_.map((d) => d.cost)))}  ${dim(`${days_[0].day} → ${days_[days_.length - 1].day}`)}`);
    const peak = days_.reduce((a, d) => (d.cost > a.cost ? d : a));
    out.push(`  ${"".padEnd(pad)}  ${dim(`peak ${usd(peak.cost)} on ${peak.day} · median ${usd(median(days_.map((d) => d.cost)))}`)}`);
  }

  const models = Object.entries(t.models).sort((a, b) => b[1] - a[1]);
  if (models.length) {
    out.push("");
    out.push(bold("  Where it went"));
    for (const [m, c] of models) {
      const tk = t.modelTokens[m] ?? 0;
      out.push(`  ${m.padEnd(pad)}  ${String(usd(c)).padEnd(10)} ${dim(`${pct(c / t.cost)}${tk ? ` · ${tokens(tk)} tokens` : ""}`)}`);
    }
  }

  const skills = skillCosts(t.skills, skillSizes);
  const mcpRows = Object.entries(t.mcp).sort((a, b) => b[1] - a[1]);
  // A long skill or server name must not knock the columns out of line.
  const wide = Math.max(pad, ...skills.map((r) => r.name.length), ...mcpRows.map(([m]) => m.length), 0);
  if (skills.length) {
    out.push("");
    out.push(bold("  Skills"));
    for (const r of skills) {
      const cost = r.known ? `~${tokens(r.onLoad)} tokens to load` : dim("size not readable — ships inside Claude Code");
      out.push(`  ${r.name.padEnd(wide)}  ${String(`${r.calls}×`).padEnd(10)} ${dim(cost)}`);
    }
  }

  if (mcpRows.length) {
    out.push("");
    out.push(bold("  MCP servers called"));
    for (const [srv, n] of mcpRows) out.push(`  ${srv.padEnd(wide)}  ${String(`${n}×`).padEnd(10)}`);
  }

  out.push("");
  out.push(renderNudges(nudges, { heading: true }));
  out.push("");
  out.push(dim(wrap(SHADOW)));
  out.push("");
  return out.join("\n");
}

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

/** Mean, median and p99 — the shape of a distribution, not just its average. */
export function distribution(values) {
  const v = [...values].sort((x, y) => x - y);
  if (!v.length) return { mean: 0, median: 0, p99: 0, max: 0 };
  const at = (q) => v[Math.min(v.length - 1, Math.ceil(q * v.length) - 1)];
  return {
    mean: v.reduce((a, x) => a + x, 0) / v.length,
    median: median(v),
    p99: at(0.99),
    max: v[v.length - 1],
  };
}

export function renderNudges({ sessionNudges, windowNudges }, { heading = false, compact = false } = {}) {
  const out = [];
  const total = sessionNudges.length + windowNudges.length;
  if (heading) {
    out.push(bold(total ? `  ${total} thing${total === 1 ? "" : "s"} worth knowing` : "  Nothing to raise"));
    if (!total) {
      out.push(dim("  Every rule you have enabled came back clean for this window."));
      return out.join("\n");
    }
    out.push("");
  }

  for (const w of windowNudges) {
    out.push(`  ${warn("▲")} ${bold(w.label)}`);
    out.push(wrap(w.detail, 76, "    "));
    if (!compact) out.push(dim(wrap(w.action, 76, "    ")));
    out.push("");
  }

  for (const g of sessionNudges) {
    const n = g.hits.length;
    out.push(`  ${warn("▲")} ${bold(g.label)} ${dim(`· ${n} session${n === 1 ? "" : "s"}`)}`);
    if (compact) {
      out.push(wrap(g.hits[0].detail, 76, "    "));
    } else {
      for (const h of g.hits.slice(0, 3)) {
        out.push(wrap(h.detail, 76, "    "));
        out.push(dim(`      ${h.session.id.slice(0, 8)} · ${h.session.day} · ${h.session.cwd ?? "?"}`));
      }
      if (n > 3) out.push(dim(`    …and ${n - 3} more`));
      out.push(dim(wrap(g.hits[0].action, 76, "    ")));
    }
    out.push("");
  }
  return out.join("\n").replace(/\n+$/, "");
}
