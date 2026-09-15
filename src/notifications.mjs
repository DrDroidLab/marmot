/**
 * Every notification Marmot has put in front of you, and what it said.
 *
 * The hook log answers "what did the hook decide". This answers "what was I
 * shown", which is a different question on a bug report: a nudge that fired
 * correctly but read wrong, or went out through a channel that dropped it, looks
 * perfectly healthy in a log of rule outcomes. So each entry carries the words
 * themselves — the desktop title and body, and the line in the transcript — the
 * rules behind them, the plan they were judged against, and where it went.
 *
 * Local, capped, and never allowed to throw, like the hook log it sits beside.
 */

import { join } from "node:path";
import { appendJsonl, readJsonl } from "./hooklog.mjs";
import { silenced } from "./notify.mjs";

export const catalogPath = (root) => join(root, "marmot-notifications.jsonl");

/** Notifications are rare, so this keeps far more history than the hook log. */
const MAX_BYTES = 2 * 1024 * 1024;

/** On by default: an audit trail you have to remember to switch on is empty when you need it. */
export function recording(cfg, env = process.env) {
  if (env?.MARMOT_NO_LOG) return false;
  return cfg?.log?.notifications !== false;
}

/** Append one shown notification. Never throws; returns whether it was written. */
export function record(root, entry, { cfg = null, env = process.env, now = Date.now() } = {}) {
  if (!recording(cfg, env)) return false;
  return appendJsonl(catalogPath(root), entry, { keep: cfg?.log?.keepNotifications ?? 1000, maxBytes: MAX_BYTES, now });
}

/** Newest first, like `readLog`. */
export const readCatalog = (root, opts) => readJsonl(catalogPath(root), opts);

/**
 * What happened to a notification, reduced from `alert()`'s return value.
 *
 * `desktop` is the channel the command went to, not proof it arrived — macOS
 * drops notifications from unauthorised apps with exit code 0. `silenced` is
 * the case where nothing was even attempted.
 */
export function delivery(did, { env = process.env, transcript = true } = {}) {
  return {
    transcript,
    style: did?.style ?? null,
    desktop: did?.desktop ? (did.desktop.via ?? did.desktop.cmd ?? "sent") : null,
    bell: did?.bell || null,
    silenced: silenced(env),
  };
}
