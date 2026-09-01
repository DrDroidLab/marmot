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

import { spawn, execFileSync } from "node:child_process";
import { writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Strip what could break out of the AppleScript string literal we build below,
 * and flatten to one line — a notification is one line whatever we pass it.
 */
const clean = (s, n = 180) =>
  String(s ?? "")
    // Only what could close the AppleScript string literal or escape inside it.
    // `$` and backticks are shell metacharacters, and there is no shell here —
    // the command is spawned with an argument array. Stripping them cost every
    // cost nudge its dollar sign.
    .replace(/["\\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, n);

/**
 * Terminals that turn an OSC 9 escape sequence into a desktop notification.
 *
 * This is the channel to prefer, because it belongs to the terminal you are
 * already using: it needs nothing installed, nothing granted, and works the
 * same on macOS, Linux and Windows. The sequence is written to the controlling
 * terminal, so it reaches you even from a hook whose output is a pipe.
 *
 * Only terminals known to support it are used. An unsupported terminal may
 * print an unknown OSC sequence as text, and garbling the screen is worse than
 * a missing notification.
 */
export function oscNotifier(env = process.env) {
  const p = env.TERM_PROGRAM;
  if (env.KITTY_WINDOW_ID || p === "kitty") return { name: "kitty", osc: 99 };
  if (p === "iTerm.app") return { name: "iTerm2", osc: 9 };
  if (p === "WezTerm" || env.WEZTERM_PANE) return { name: "WezTerm", osc: 9 };
  if (p === "ghostty") return { name: "Ghostty", osc: 9 };
  if (env.WT_SESSION) return { name: "Windows Terminal", osc: 9 };
  if (env.KONSOLE_VERSION) return { name: "Konsole", osc: 777 };
  if (p === "Hyper") return { name: "Hyper", osc: 9 };
  return null;
}

/**
 * The bytes that make a terminal raise a notification.
 *
 * Sanitised for a terminal rather than for AppleScript: control characters and
 * `;` would end the sequence early, but `$` and quotes are ordinary text here
 * and must survive — a cost nudge that loses its dollar sign is worse than no
 * nudge at all.
 */
const oscClean = (s, n = 180) =>
  String(s ?? "")
    .replace(/[\x00-\x1f\x7f;]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, n);

export function oscSequence(notifier, title, body) {
  const t = oscClean(title, 60);
  const b = oscClean(body);
  if (!b) return null;
  if (notifier.osc === 99) return `\x1b]99;i=1:d=0:p=title;${t}\x1b\\\x1b]99;i=1:d=1:p=body;${b}\x1b\\`;
  if (notifier.osc === 777) return `\x1b]777;notify;${t};${b}\x07`;
  return `\x1b]9;${t} — ${b}\x07`;
}

/**
 * The command that raises a desktop notification on this platform, or null
 * where there isn't one we can rely on being installed.
 */
export function notifyCommand(platform, title, body, env = process.env, app = null, sound = null, persist = false) {
  const t = clean(title, 60);
  const b = clean(body);
  if (!b) return null;
  if (platform === "darwin") {
    // A plain `display notification` is posted by Script Editor, which most
    // people have never authorised — macOS then accepts it and drops it with no
    // error at all. Attributing it to the host terminal, which the user has
    // usually already allowed, is the difference between arriving and not.
    //
    // `notify.app` overrides that, because some hosts can never be granted:
    // an app absent from System Settings cannot be switched on there, so you
    // need to be able to point this at one that is.
    const as = app ? clean(app, 80) : null;
    const host = as ?? (env?.__CFBundleIdentifier ? clean(env.__CFBundleIdentifier, 80) : null);
    const target = host ? (host.includes(".") ? `application id "${host}"` : `application "${host}"`) : null;
    // The notification's own sound is a far better bell than a terminal BEL:
    // it is audible wherever the notification is visible, and needs no
    // controlling terminal.
    const withSound = sound ? ` sound name "${clean(sound, 30)}"` : "";
    const notify = `display notification "${b}" with title "${t}"${withSound}`;
    return { cmd: "osascript", args: ["-e", target ? `tell ${target} to ${notify}` : notify] };
  }
  if (platform === "linux") {
    // Part of libnotify, present on most desktops. Absent on a headless box,
    // where the spawn below fails and is swallowed.
    const icon = iconPath("svg");
    return {
      cmd: "notify-send",
      args: [
        "--app-name=Marmot",
        ...(icon ? ["-i", icon] : []),
        // Critical urgency is what actually stops a daemon expiring it; the
        // zero timeout is a hint most of them honour and GNOME ignores.
        ...(persist ? ["-u", "critical", "-t", "0"] : []),
        ...(sound ? ["--hint=string:sound-name:message-new-instant"] : []),
        t,
        b,
      ],
    };
  }
  if (platform === "win32") {
    // No extra module, and nothing to install: NotifyIcon ships with the .NET
    // Framework that is present on every Windows since 7, and Windows 10 and 11
    // surface its balloon as a normal toast. BurntToast would be prettier and
    // is not installed anywhere by default.
    //
    // The icon has to stay visible while the balloon shows, so the script
    // sleeps before disposing — which is fine, because it is spawned detached.
    const icoPath = iconPath("ico");
    const ps = [
      "Add-Type -AssemblyName System.Windows.Forms;",
      "Add-Type -AssemblyName System.Drawing;",
      "$n=New-Object System.Windows.Forms.NotifyIcon;",
      icoPath ? `$n.Icon=New-Object System.Drawing.Icon(${psQuote(icoPath)});` : "$n.Icon=[System.Drawing.SystemIcons]::Information;",
      `$n.BalloonTipTitle=${psQuote(t)};`,
      `$n.BalloonTipText=${psQuote(b)};`,
      "$n.Visible=$true;",
      `$n.ShowBalloonTip(${persist ? 60000 : 8000});`,
      sound ? "[System.Media.SystemSounds]::Asterisk.Play();" : "",
      `Start-Sleep -Seconds ${persist ? 61 : 9};`,
      "$n.Dispose()",
    ]
      .filter(Boolean)
      .join(" ");
    return { cmd: "powershell", args: ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps] };
  }
  return null;
}

/**
 * A PowerShell single-quoted literal, where the only escape is a doubled
 * quote. Everything else — $, backticks, backslashes — is inert inside one.
 */
const psQuote = (v) => `'${String(v ?? "").replace(/'/g, "''")}'`;

/**
 * The marmot, for platforms whose notifications can show one.
 *
 * Linux takes any image path; Windows needs an .ico, which is why one is
 * committed beside the SVG. macOS shows the posting application's icon and
 * gives `display notification` no say in it — a custom icon there would mean
 * shipping an app bundle, which is not worth it for a nudge.
 */
export function iconPath(kind) {
  try {
    const p = fileURLToPath(new URL(`../docs/marmot.${kind}`, import.meta.url));
    return existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/** True when the environment says to stay silent regardless of config. */
export const silenced = (env = process.env) => Boolean(env.MARMOT_NO_NOTIFY || env.CI);

/**
 * Which channel a notification would go out on, for `marmot doctor`.
 *
 * It deliberately does not try to predict whether macOS will show it. An
 * earlier version read `com.apple.ncprefs` and called an app "blocked" when it
 * was absent — then a plain notification arrived from exactly such an app, so
 * the check was reporting a working setup as broken. Absence from that file
 * means the app has not registered, not that delivery fails. A false alarm that
 * talks someone out of a working feature is worse than no check at all.
 */
export function deliverability({ platform = process.platform, env = process.env, app = null } = {}) {
  if (silenced(env)) return { deliverer: null, channel: "none", status: "silenced", detail: "MARMOT_NO_NOTIFY or CI is set" };

  const term = app ? null : oscNotifier(env);
  if (term) return { deliverer: term.name, channel: "terminal", status: "ok", detail: `${term.name} posts them itself, with nothing to allow` };

  if (platform === "darwin") {
    const who = app ?? env.__CFBundleIdentifier ?? null;
    return {
      deliverer: who,
      channel: "macos",
      status: "ok",
      detail: who ? `posted by ${who}` : "posted by Script Editor",
      // `display notification` has no persistence option — whether a
      // notification waits for you or fades is the delivering app's Alert
      // style, which only the user can set.
      persistHint: who
        ? `to stop them fading: System Settings → Notifications → ${who.split(".").pop()} → Alert style: Alerts`
        : null,
    };
  }
  if (platform === "linux") return { deliverer: "notify-send", channel: "linux", status: "ok", detail: "posted by notify-send, if libnotify is installed" };
  if (platform === "win32") return { deliverer: "powershell", channel: "windows", status: "ok", detail: "posted as a Windows notification via PowerShell" };
  return { deliverer: null, channel: "none", status: "unsupported", detail: "no desktop notifier on this platform — the bell and the transcript still work" };
}

/**
 * Ring the bell and raise the notification, per config. Returns what it did,
 * which is what the tests assert on — firing a real popup to check is not a
 * test anyone wants to run.
 */
export function alert(cfg, { title = "Marmot", body = "", platform = process.platform, stream = process.stderr, env = process.env, ttyPath = "/dev/tty" } = {}) {
  const n = cfg?.notify ?? {};
  const did = { bell: false, desktop: null };

  if (n.bell && !silenced(env)) {
    // A hook's stderr is a pipe Claude Code reads, not a terminal, so a bell
    // written there is swallowed. The controlling terminal is the only place it
    // can actually ring; stderr is the fallback for when we are run directly.
    if (ttyPath) {
      try {
        writeFileSync(ttyPath, "\x07");
        did.bell = "tty";
      } catch {
        /* no controlling terminal — fall through */
      }
    }
    if (!did.bell) {
      try {
        // Never stdout: the hook's stdout is JSON that Claude Code parses.
        stream.write("\x07");
        did.bell = "stderr";
      } catch {
        /* a closed stream is not worth a word */
      }
    }
  }

  if (!n.desktop || silenced(env)) return did;

  // The terminal's own notification first: nothing to install, nothing to
  // grant, and it works the same everywhere. Only when the terminal has no
  // such channel do we fall back to the OS, which on macOS needs permission
  // the host app may not have.
  const notifier = n.app ? null : oscNotifier(env);
  if (notifier && ttyPath) {
    const seq = oscSequence(notifier, title, body);
    if (seq) {
      try {
        writeFileSync(ttyPath, seq);
        did.desktop = { via: notifier.name };
        return did;
      } catch {
        /* no controlling terminal — fall through to the OS */
      }
    }
  }

  const c = notifyCommand(platform, title, body, env, n.app ?? null, n.bell ? (n.sound ?? "Ping") : null, n.persist !== false);
  if (!c) return did;
  try {
    // Detached and unreferenced, so the hook can exit without waiting on it.
    const child = spawn(c.cmd, c.args, { detached: true, stdio: "ignore" });
    // A spawn failure arrives asynchronously, as an `error` event — try/catch
    // never sees it, and an unhandled one takes the whole process down. On a
    // box with no notify-send that would kill the nudge it was announcing.
    child.on("error", () => {});
    child.unref();
    did.desktop = c;
  } catch {
    /* a missing binary, a daemon that is not there — the nudge still stands */
  }
  return did;
}
