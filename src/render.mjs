import { byDay, byProject } from "./sessions.mjs";
import { usd, pct, num, tokens, mins, dim, bold, warn, info } from "./format.mjs";
import { skillCosts } from "./skills.mjs";

const SHADOW_API =
  "These are published API rates, which is what pay-as-you-go usage actually costs.";
const cap1 = (s) => s.charAt(0).toUpperCase() + s.slice(1);
/** A path short enough to line up, keeping the end that identifies it. */
const short = (p, n = 46) => (p.length <= n ? p : `…${p.slice(-(n - 1))}`);
const resetIn = (iso) => {
  const m = (Date.parse(iso) - Date.now()) / 60_000;
  return Number.isFinite(m) ? (m <= 0 ? "shortly" : `in ${mins(m)}`) : "soon";
};
const SHADOW =
  "The dollar figures are a shadow price — what these tokens would have cost at published API rates. On your plan they are not an invoice line; the limits above are what you actually spend. Right for comparing your own sessions to each other, wrong for finance.";

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

export function renderReport(sessions, cfg, { days, nudges, demo = false, skillSizes = {}, mcpSizes = null, configuredServers = [], plan = null, attribution = null, serverConfigs = {} }) {
  const source = demo
    ? "synthetic demo data — nothing here came from your machine"
    : "everything below was read from ~/.claude/projects on this machine";
  const t = totals(sessions);
  const days_ = byDay(sessions);
  const out = [];

  out.push("");
  out.push(bold(`  Marmot · your last ${days} days`));
  out.push(dim(`  ${num(t.sessions)} sessions${plan?.plan ? ` · ${plan.plan}` : ""} · ${source}`));
  out.push("");

  const onSubscription = plan?.plan && plan.plan !== "API";
  const rows = [
    [
      onSubscription ? "Modelled spend" : "Spend",
      usd(t.cost),
      onSubscription ? `at API rates — not what you pay on ${plan.plan}` : "at published rates",
    ],
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

  // On a subscription this is the figure that actually bites: the money is
  // already spent, and what runs out is allowance.
  for (const l of plan?.limits ?? []) {
    if (!l.active && l.percent === 0 && !l.resetsAt) continue;
    if (l.expired) {
      // Showing 5% here would read as "plenty left" about a window that has
      // since reset and nobody has measured.
      rows.push([`${cap1(l.label)} limit`, "—", `that window reset ${mins(-((Date.parse(l.resetsAt) - Date.now()) / 60_000))} ago · run /usage in Claude Code to refresh`]);
      continue;
    }
    const note = [
      l.resetsAt ? `resets ${resetIn(l.resetsAt)}` : null,
      plan.ageMins !== null && plan.ageMins > 60 ? `as of ${mins(plan.ageMins)} ago` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    rows.push([`${cap1(l.label)} limit`, `${l.percent}%`, note]);
  }
  if (plan?.spend && plan.spend.enabled && plan.spend.limit) {
    rows.push(["Usage credits", `${usd(plan.spend.used ?? 0)} of ${usd(plan.spend.limit)}`, "real money, beyond the plan"]);
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

  // Everything attached, not only what was called — an idle server costs the
  // same on every request as a busy one, and only this view shows that.
  const measured = mcpSizes?.servers ?? {};
  const allServers = [...new Set([...mcpRows.map(([m]) => m), ...configuredServers, ...Object.keys(measured)])];
  if (allServers.length) {
    const calls = Object.fromEntries(mcpRows);
    const rows = allServers
      .map((name) => ({ name, calls: calls[name] ?? 0, size: measured[name] ?? null }))
      .sort((a, b) => b.calls - a.calls || (b.size?.tokens ?? 0) - (a.size?.tokens ?? 0));
    const w = Math.max(wide, ...rows.map((r) => r.name.length));

    out.push("");
    out.push(bold("  MCP servers"));
    for (const r of rows) {
      const size = r.size?.error ? dim(r.size.error) : r.size?.tokens ? dim(`${r.size.count} tools · ~${tokens(r.size.tokens)} tokens`) : "";
      const label = `  ${r.name.padEnd(w)}  ${String(`${r.calls}×`).padStart(6)}  `;
      out.push(r.calls ? `${label}${size}` : `${warn(label)}${size}${warn("  ▲ never called")}`);
    }

    const priced = rows.filter((r) => r.size?.tokens);
    if (priced.length) {
      const total = priced.reduce((a, r) => a + r.size.tokens, 0);
      const idle = priced.filter((r) => !r.calls).reduce((a, r) => a + r.size.tokens, 0);
      out.push(
        dim(`  ${"".padEnd(w)}  ${num(total)} tokens on every request`) + (idle ? warn(`, ${num(idle)} of them idle`) : ""),
      );
    }
  }

  // Each working directory is its own setup — its own servers, its own skills,
  // often its own habits. Worth seeing the split; not worth splitting the
  // nudges, which are about a pool spent from all of them at once.
  const projects = byProject(sessions, { servers: serverConfigs });
  if (projects.length > 1) {
    out.push("");
    out.push(bold(`  By project · ${projects.length} setups`));
    const w = Math.min(46, Math.max(...projects.map((r) => short(r.dir).length)));
    for (const r of projects) {
      out.push(
        `  ${short(r.dir).padEnd(w)}  ${usd(r.cost).padStart(9)}  ${String(r.sessions).padStart(3)} sess  ${String(r.prompts).padStart(4)} prompts  ` +
          dim(r.scoped.length ? `+${r.scoped.join(", ")}` : ""),
      );
    }
    out.push(dim(`  ${"".padEnd(w)}  every nudge below is across all of them`));
  }

  // Claude Code's own accounting, which beats anything inferred from
  // transcripts — and names the two things transcripts cannot see directly.
  const attr = attribution?.windows?.[attribution.windows.length - 1];
  if (attr?.behaviours?.length) {
    out.push("");
    out.push(bold(`  What is driving your limits · ${attr.label.replace(/^Last\s+/i, "last ")}`));
    out.push(dim(`  Claude Code's own attribution, over ${num(attr.requests)} requests${attr.sessions ? ` in ${attr.sessions} sessions` : ""}.`));
    for (const b of attr.behaviours) out.push(`  ${String(`${b.percent}%`).padStart(6)}  ${b.text}`);
    for (const [kind, items] of Object.entries(attr.top ?? {})) {
      out.push(dim(`  ${"".padStart(6)}  top ${kind.replace(/-/g, " ")}: ${items.map((i) => `${i.name} ${i.percent}%`).join(", ")}`));
    }
  }

  out.push("");
  out.push(renderNudges(nudges, { heading: true }));
  out.push("");
  out.push(dim(wrap(onSubscription ? SHADOW : SHADOW_API)));
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
      const dearest = [...g.hits].sort((a, b) => (b.session.cost ?? 0) - (a.session.cost ?? 0))[0];
      out.push(wrap(dearest.detail, 76, "    "));
    } else {
      // Every one of them, dearest first: a truncated list hides exactly the
      // sessions worth looking at, and the order is the whole point.
      for (const h of [...g.hits].sort((a, b) => (b.session.cost ?? 0) - (a.session.cost ?? 0))) {
        out.push(wrap(h.detail, 76, "    "));
        out.push(dim(`      ${h.session.id.slice(0, 8)} · ${h.session.day} · ${h.session.cwd ?? "?"}`));
      }
      out.push(dim(wrap(g.hits[0].action, 76, "    ")));
    }
    out.push("");
  }
  return out.join("\n").replace(/\n+$/, "");
}
