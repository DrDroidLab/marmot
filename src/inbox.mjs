/**
 * The handoff between the hooks and the menu bar app.
 *
 * A hook runs in a process Claude Code starts and reaps, so it has two ways to
 * reach you: an osascript dialog, or — when the Marmot app is running — a line
 * in an inbox the app drains and posts as a real notification, with the marmot
 * on it and a Notification Center entry that stays. The app proves it is
 * running by touching a heartbeat file every minute; a heartbeat older than a
 * few minutes means it quit or crashed, and the hook falls back to the dialog
 * rather than writing into a file nobody reads.
 *
 * Nothing here throws. A failed handoff costs the app channel, never the nudge:
 * the caller falls back to `alert()`.
 */

import { readFileSync, writeFileSync, appendFileSync, renameSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";

export const heartbeatPath = (root) => join(root, "marmot-app.json");
export const inboxPath = (root) => join(root, "marmot-inbox.jsonl");

/** How stale a heartbeat may be before the app counts as gone. */
export const HEARTBEAT_MAX_MS = 3 * 60_000;

export function writeHeartbeat(root, { now = Date.now(), pid = process.ppid } = {}) {
  try {
    writeFileSync(heartbeatPath(root), JSON.stringify({ at: now, pid }) + "\n");
    return true;
  } catch {
    return false;
  }
}

/** True when the menu bar app has checked in recently enough to deliver. */
export function appAlive(root, { now = Date.now(), env = process.env } = {}) {
  if (env.MARMOT_NO_APP) return false;
  try {
    const { at } = JSON.parse(readFileSync(heartbeatPath(root), "utf8"));
    return typeof at === "number" && now - at < HEARTBEAT_MAX_MS;
  } catch {
    return false;
  }
}

/** Queue one notification for the app. False when it could not be written. */
export function appendInbox(root, { title, body, urgent = false, kind = "nudge", id = null, key = null, now = Date.now() }) {
  try {
    appendFileSync(inboxPath(root), JSON.stringify({ id, key, title, body, urgent, kind, source: "hook", at: new Date(now).toISOString() }) + "\n");
    return true;
  } catch {
    return false;
  }
}

/**
 * Everything queued since the last drain, oldest first, and the file emptied.
 *
 * Renamed before it is read, so a hook appending at the same moment writes to a
 * fresh file instead of into one being deleted — the nudge lands in the next
 * drain rather than nowhere.
 */
export function drainInbox(root) {
  const p = inboxPath(root);
  if (!existsSync(p)) return [];
  const taken = `${p}.${process.pid}.reading`;
  try {
    renameSync(p, taken);
  } catch {
    return [];
  }
  const out = [];
  try {
    for (const line of readFileSync(taken, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* a torn line is skipped, not fatal */
      }
    }
  } catch {
    /* unreadable: nothing to deliver */
  }
  try {
    unlinkSync(taken);
  } catch {
    /* left behind is harmless */
  }
  return out;
}
