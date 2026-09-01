import { byDay } from "./sessions.mjs";
import { usd, pct, num, tokens, mins, dim, bold, warn, info } from "./format.mjs";

const SHADOW =
  "Cost is a shadow price — what these tokens would have cost at published API rates. On a subscription plan it is not an invoice line. Right for comparing your own sessions, wrong for finance.";

export function wrap(text, width = 76, indent = "  ") {
  const words = text.split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > width) {
      lines.push(line.trim());
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
  const t = { cost: 0, prompts: 0, turns: 0, sessions: sessions.length, toolCalls: 0, toolErrors: 0, tok: 0, cacheRead: 0, seen: 0, models: {} };
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
  }
  t.cacheHitRate = t.seen ? t.cacheRead / t.seen : null;
  return t;
}

export function renderReport(sessions, cfg, { days, nudges, demo = false }) {
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
    ["Prompts you typed", num(t.prompts), t.sessions ? `${(t.prompts / t.sessions).toFixed(1)} per session` : ""],
    ["Model turns", num(t.turns), t.prompts ? `${(t.turns / t.prompts).toFixed(1)} per prompt` : ""],
    ["Tokens", tokens(t.tok), "input, output and cache"],
    ["Cache hit rate", t.cacheHitRate === null ? "—" : pct(t.cacheHitRate), "higher is cheaper"],
    ["Tool calls", num(t.toolCalls), `${t.toolCalls ? pct(t.toolErrors / t.toolCalls) : "0%"} failed`],
  ];
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
      out.push(`  ${m.padEnd(pad)}  ${String(usd(c)).padEnd(10)} ${dim(pct(c / t.cost))}`);
    }
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
