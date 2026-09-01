/**
 * Getting your attention, once.
 *
 * A nudge in the transcript is easy to scroll past — by the time you read it
 * the turn it was about is over. The bell and the desktop notification exist so
 * a nudge lands while you can still act on it.
 *
 * Both are on by default and both are switchable in `~/.claude/marmot.json`
 * under `notify`. They fire only when a rule actually fires, which the state
 * file already limits to once per session per rule, so this cannot become a
 * stream of popups.
 *
 * Nothing here is allowed to fail loudly: a machine with no notification daemon
 * should cost you the popup, not the nudge.
 */

import { spawn } from "node:child_process";

/**
 * Strip what could break out of the AppleScript string literal we build below,
 * and flatten to one line — a notification is one line whatever we pass it.
 */
const clean = (s, n = 180) =>
  String(s ?? "")
    .replace(/[\\"`$]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, n);

/**
 * The command that raises a desktop notification on this platform, or null
 * where there isn't one we can rely on being installed.
 */
export function notifyCommand(platform, title, body) {
  const t = clean(title, 60);
  const b = clean(body);
  if (!b) return null;
  if (platform === "darwin") {
    return { cmd: "osascript", args: ["-e", `display notification "${b}" with title "${t}"`] };
  }
  if (platform === "linux") {
    // Part of libnotify, present on most desktops. Absent on a headless box,
    // where the spawn below fails and is swallowed.
    return { cmd: "notify-send", args: ["--app-name=Marmot", t, b] };
  }
  // Windows has no dependable built-in without extra modules, so it gets the
  // bell only. Better than a popup that works on one machine in three.
  return null;
}

/** True when the environment says to stay silent regardless of config. */
export const silenced = (env = process.env) => Boolean(env.MARMOT_NO_NOTIFY || env.CI);

/**
 * Ring the bell and raise the notification, per config. Returns what it did,
 * which is what the tests assert on — firing a real popup to check is not a
 * test anyone wants to run.
 */
export function alert(cfg, { title = "Marmot", body = "", platform = process.platform, stream = process.stderr, env = process.env } = {}) {
  const n = cfg?.notify ?? {};
  const did = { bell: false, desktop: null };

  if (n.bell && !silenced(env)) {
    try {
      // stderr, never stdout: the hook's stdout is JSON that Claude Code parses.
      stream.write("\x07");
      did.bell = true;
    } catch {
      /* a closed stream is not worth a word */
    }
  }

  if (!n.desktop || silenced(env)) return did;
  const c = notifyCommand(platform, title, body);
  if (!c) return did;
  try {
    // Detached and unreferenced, so the hook can exit without waiting on it.
    spawn(c.cmd, c.args, { detached: true, stdio: "ignore" }).unref();
    did.desktop = c;
  } catch {
    /* no notification daemon, a missing binary — the nudge still stands */
  }
  return did;
}
