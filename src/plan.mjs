/**
 * Which plan you are on, and how much of it you have used.
 *
 * A dollar figure at published API rates is the right number on pay-as-you-go
 * and the wrong one on a subscription, where you have already paid and what you
 * are actually spending is *allowance*. Claude Code knows the difference and
 * writes it to `~/.claude.json`: the plan under `oauthAccount`, and a cached
 * snapshot of limit utilisation under `cachedUsageUtilization`.
 *
 * Two things to be careful with, both of which the report says out loud:
 *
 *   - The utilisation is a **cache**, stamped with `fetchedAtMs`. It is as old
 *     as the last time Claude Code asked, which may be hours. Reporting a stale
 *     percentage as current is how someone gets surprised by a limit.
 *   - On subscription plans the API returns `limit_dollars: null`, so a percent
 *     cannot be turned back into money. That is a property of the plan, not a
 *     gap in the reader, and the report does not pretend otherwise.
 *
 * Nothing here reads your email, name or account ids beyond what is needed to
 * name the plan.
 */

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

/** `default_claude_max_20x` and friends, in words. */
export function planName({ tier, orgType, billing, hasOauth }) {
  const t = String(tier ?? "").toLowerCase();
  if (t.includes("max_20x")) return "Max 20×";
  if (t.includes("max_5x")) return "Max 5×";
  if (t.includes("max")) return "Max";
  if (t.includes("team")) return "Team";
  if (t.includes("enterprise")) return "Enterprise";
  if (t.includes("pro")) return "Pro";

  const o = String(orgType ?? "").toLowerCase();
  if (o.includes("max")) return "Max";
  if (o.includes("team")) return "Team";
  if (o.includes("enterprise")) return "Enterprise";
  if (o.includes("pro")) return "Pro";

  if (billing === "stripe_subscription") return "subscription";
  if (!hasOauth) return "API";
  return null;
}

/**
 * True when the dollar figure is a real price rather than a modelled one.
 * Only pay-as-you-go API usage bills per token.
 */
export const paysPerToken = (plan) => plan === "API";

const asPercent = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** True once the window a reading described has rolled over. */
const expired = (resetsAt, now) => {
  const t = Date.parse(resetsAt ?? "");
  return Number.isFinite(t) ? t <= now : false;
};

/** The limits worth showing, newest snapshot first. */
function readLimits(u, now) {
  const out = [];
  const seen = new Set();

  // The `limits` array is the richer form, and the one Claude Code itself uses.
  for (const l of u?.limits ?? []) {
    const pct = asPercent(l?.percent);
    if (pct === null) continue;
    const kind = l.kind ?? l.group ?? "limit";
    if (seen.has(kind)) continue;
    seen.add(kind);
    out.push({
      kind,
      label: kind === "session" ? "5-hour session" : kind === "weekly_all" ? "weekly" : kind === "weekly_scoped" ? `weekly · ${l?.scope?.model?.display_name ?? "scoped"}` : kind,
      percent: pct,
      severity: l.severity ?? "normal",
      resetsAt: l.resets_at ?? null,
      active: Boolean(l.is_active),
      // The window this figure described has already rolled over, so the
      // number is not stale — it is dead. Reporting it as current would be
      // saying "you are fine" about a window nobody has measured.
      expired: expired(l.resets_at, now),
    });
  }
  if (out.length) return out;

  // Older shape: the named windows, before `limits` existed.
  for (const [key, label] of [["five_hour", "5-hour session"], ["seven_day", "weekly"]]) {
    const pct = asPercent(u?.[key]?.utilization);
    if (pct === null) continue;
    out.push({ kind: key, label, percent: pct, severity: "normal", resetsAt: u[key].resets_at ?? null, active: true, expired: expired(u[key].resets_at, now) });
  }
  return out;
}

/** Real money, where a plan has credits attached. Null where it does not. */
function readSpend(u) {
  const s = u?.spend;
  const minor = (m) => (typeof m?.amount_minor === "number" ? m.amount_minor / 10 ** (m.exponent ?? 2) : null);
  const used = minor(s?.used);
  const limit = minor(s?.limit);
  if (used === null && limit === null) return null;
  return { used, limit, currency: s?.used?.currency ?? "USD", enabled: Boolean(s?.enabled), percent: asPercent(s?.percent) };
}

/**
 * What we know about the plan behind this machine's sessions.
 *
 * `~/.claude.json` sits beside the `.claude` directory, so it is derived from
 * the root rather than assumed, and `--root` keeps working.
 */
export function readPlan(root, { now = Date.now(), env = process.env } = {}) {
  const path = `${root}.json`;
  const unknown = { plan: null, limits: [], spend: null, fetchedAt: null, ageMins: null, stale: true, path };
  if (!existsSync(path)) return unknown;

  let d;
  try {
    d = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return unknown; // a malformed config costs the plan, not the report
  }

  const acct = d.oauthAccount ?? null;
  // An API key overrides a signed-in account: those tokens are billed per token
  // whatever the account behind them says.
  const usingKey = Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
  const plan = usingKey
    ? "API"
    : planName({ tier: acct?.organizationRateLimitTier ?? acct?.userRateLimitTier, orgType: acct?.organizationType, billing: acct?.billingType, hasOauth: Boolean(acct) });

  const cached = d.cachedUsageUtilization ?? null;
  const fetchedAt = typeof cached?.fetchedAtMs === "number" ? cached.fetchedAtMs : null;
  const ageMins = fetchedAt ? Math.max(0, (now - fetchedAt) / 60_000) : null;

  return {
    plan,
    limits: readLimits(cached?.utilization, now),
    spend: readSpend(cached?.utilization),
    fetchedAt,
    ageMins,
    // An hour-old snapshot is worth showing with its age attached; older than a
    // day is worth distrusting.
    stale: ageMins === null || ageMins > 60,
    path,
  };
}

/**
 * The limits worth acting on: ones whose window is still the window they were
 * measured in. Everything else tells you about a window that has since reset.
 */
export const usableLimits = (plan) =>
  // A reading with no reset time and no active flag cannot be checked for
  // freshness at all, so it is not something to act on either.
  (plan?.limits ?? []).filter((l) => !l.expired && (l.active || l.resetsAt));

/** True when we hold readings, but none of them still describe a live window. */
export const limitsExpired = (plan) => Boolean(plan?.limits?.length) && usableLimits(plan).length === 0;

/**
 * How long each window is. Needed to turn "78% used" into "78% used with a day
 * left", which is the difference between a number and something to act on.
 */
export const WINDOW_MS = { session: 5 * 3_600_000, five_hour: 5 * 3_600_000, weekly_all: 7 * 86_400_000, weekly_scoped: 7 * 86_400_000, seven_day: 7 * 86_400_000 };

/**
 * Whether a window is being spent faster than it is passing.
 *
 * `pace` is share-used over share-elapsed: 1.0 is exactly on track to reach the
 * limit as the window ends, 2.0 is running out in half the time. `exhaustsInMs`
 * is how long the remaining allowance lasts at this rate — null when the pace
 * would not reach the limit at all.
 */
export function limitPace(limit, now = Date.now()) {
  const len = WINDOW_MS[limit?.kind];
  if (!len || !limit?.resetsAt) return null;
  const remainingMs = Date.parse(limit.resetsAt) - now;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return null;

  const elapsedPct = (1 - remainingMs / len) * 100;
  if (elapsedPct <= 0) return null; // the window has only just begun
  const pace = limit.percent / elapsedPct;
  const left = 100 - limit.percent;
  // At this rate, how much longer the remaining allowance lasts.
  const perMs = elapsedPct > 0 ? limit.percent / (len - remainingMs) : 0;
  const exhaustsInMs = perMs > 0 ? left / perMs : null;
  return {
    elapsedPct,
    remainingMs,
    pace,
    exhaustsInMs,
    // Only interesting when it runs out with time still on the clock.
    exhaustsBeforeReset: exhaustsInMs !== null && exhaustsInMs < remainingMs,
  };
}

/** The single limit closest to being reached, which is the one worth saying. */
export function tightestLimit(limits = []) {
  return limits.reduce((a, l) => (a === null || l.percent > a.percent ? l : a), null);
}

/**
 * Ask Claude Code to refresh its own usage snapshot.
 *
 * `/usage` is handled entirely client-side: run headless it fetches the live
 * figures, updates `cachedUsageUtilization`, and creates no session and no
 * model turn — measured at zero tokens and no transcript. So this needs no
 * credentials of ours, calls no undocumented endpoint, and costs nothing. It
 * simply asks Claude Code to do the thing it already does, now rather than
 * whenever it would have.
 *
 * Never throws: an unrefreshed snapshot is worth reporting with its age, and a
 * missing `claude` on PATH is not an error worth a stack trace.
 */
export function refreshUsage(root, { timeoutMs = 45_000, run, now = Date.now(), env = process.env } = {}) {
  const before = readPlan(root, { now, env }).fetchedAt;
  try {
    const exec =
      run ??
      ((cmd, args) =>
        execFileSync(cmd, args, {
          encoding: "utf8",
          timeout: timeoutMs,
          stdio: ["ignore", "pipe", "ignore"],
          // Run somewhere neutral: this should not adopt the project's
          // settings, hooks or MCP servers just to read a number.
          cwd: env.TMPDIR || "/tmp",
          env: { ...env, MARMOT_NO_NOTIFY: "1" },
        }));
    const out = exec("claude", ["-p", "/usage"]);
    // The attribution block exists only in this output, so it is saved here or
    // it is lost until the next refresh.
    const attribution = parseUsageOutput(out);
    if (attribution) writeAttribution(root, attribution);
  } catch {
    return { refreshed: false, reason: "could not run `claude -p /usage`" };
  }
  const after = readPlan(root, { now: Date.now(), env });
  return { refreshed: after.fetchedAt !== before && after.fetchedAt !== null, plan: after, attribution: readAttribution(root) };
}

export const attributionPath = (root) => `${root}/marmot-usage.json`;

function writeAttribution(root, attribution) {
  try {
    writeFileSync(attributionPath(root), JSON.stringify(attribution, null, 2) + "\n");
  } catch {
    /* an unwritable cache costs the section, not the report */
  }
}

/** What the last refresh said was driving your limits, if anything did. */
export function readAttribution(root) {
  const p = attributionPath(root);
  if (!existsSync(p)) return null;
  try {
    const d = JSON.parse(readFileSync(p, "utf8"));
    return d?.windows?.length ? d : null;
  } catch {
    return null;
  }
}

/** True when a refresh would tell us something the cache cannot. */
export const worthRefreshing = (plan, staleAfterMins = 60) =>
  !plan?.fetchedAt || limitsExpired(plan) || usableLimits(plan).length === 0 || (plan.ageMins ?? Infinity) > staleAfterMins;

/**
 * What Claude Code itself says is driving your limit usage.
 *
 * `/usage` prints an attribution block that no local file carries: the share of
 * usage that came from very long sessions, the share that ran at high context,
 * and the skills, plugins and MCP servers contributing most. It is Anthropic's
 * own accounting rather than our inference, which makes it the most credible
 * thing Marmot can show — a nudge that says "80% of your usage came from
 * sessions active for 8+ hours" is quoting the source, not arguing with it.
 *
 * It is human-formatted text with no stability guarantee, so this is written
 * the way the transcript readers are: every line is optional, anything
 * unrecognised is skipped, and a format change costs a section rather than the
 * report. `marmot doctor` surfaces when nothing could be parsed.
 */
export function parseUsageOutput(text) {
  const lines = String(text ?? "").split("\n");
  const windows = [];
  let current = null;

  for (const raw of lines) {
    const line = raw.trimEnd();

    // "Last 24h · 976 requests · 13 sessions"
    const head = /^(Last\s+[^\u00b7]+?)\s*\u00b7\s*([\d,]+)\s+requests?(?:\s*\u00b7\s*([\d,]+)\s+sessions?)?/i.exec(line.trim());
    if (head) {
      current = {
        label: head[1].trim(),
        requests: Number(head[2].replace(/,/g, "")),
        sessions: head[3] ? Number(head[3].replace(/,/g, "")) : null,
        behaviours: [],
        top: {},
      };
      windows.push(current);
      continue;
    }
    if (!current) continue;

    const body = line.trim();
    if (!body) continue;

    // "Top skills: /claude-api 2%, /dataviz 2%"
    const top = /^Top\s+([A-Za-z ]+?)\s*:\s*(.+)$/i.exec(body);
    if (top) {
      const key = top[1].trim().toLowerCase().replace(/\s+/g, "-");
      const items = top[2]
        .split(",")
        .map((chunk) => /^\s*(.+?)\s+(\d+(?:\.\d+)?)%\s*$/.exec(chunk))
        .filter(Boolean)
        .map((m) => ({ name: m[1].replace(/^\//, ""), percent: Number(m[2]) }));
      if (items.length) current.top[key] = items;
      continue;
    }

    // "92% of your usage was at >150k context"
    const behaviour = /^(\d+(?:\.\d+)?)%\s+(.*\S)\s*$/.exec(body);
    if (behaviour) {
      current.behaviours.push({ percent: Number(behaviour[1]), text: behaviour[2] });
    }
  }

  return windows.length ? { windows, parsedAt: new Date().toISOString() } : null;
}

/** The window an attribution question is about, by preference longest. */
export const attributionFor = (attr, label) =>
  (attr?.windows ?? []).find((w) => (label ? w.label.toLowerCase().includes(label) : true)) ?? null;
