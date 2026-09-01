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

import { readFileSync, existsSync } from "node:fs";
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
    exec("claude", ["-p", "/usage"]);
  } catch {
    return { refreshed: false, reason: "could not run `claude -p /usage`" };
  }
  const after = readPlan(root, { now: Date.now(), env });
  return { refreshed: after.fetchedAt !== before && after.fetchedAt !== null, plan: after };
}

/** True when a refresh would tell us something the cache cannot. */
export const worthRefreshing = (plan, staleAfterMins = 60) =>
  !plan?.fetchedAt || limitsExpired(plan) || usableLimits(plan).length === 0 || (plan.ageMins ?? Infinity) > staleAfterMins;
