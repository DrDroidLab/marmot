/**
 * Opening the thresholds file so you can actually edit it.
 *
 * The obvious call is wrong on every platform. `open file.json` on macOS hands
 * the file to whatever claims the .json extension — Xcode, a browser, Quick
 * Look — and you get a read-only view of a file you were trying to change.
 * `start` on Windows and `xdg-open` on Linux have the same problem. Each OS has
 * a way to say "in a text editor" specifically, and that is what this picks.
 *
 * $VISUAL / $EDITOR still wins when it is set, with one caveat: a terminal
 * editor needs a terminal. Run from a slash command stdout is captured, and
 * spawning vim there hangs with nothing to attach to — so terminal editors are
 * used only when we genuinely have a TTY, and GUI editors any time.
 */

import { spawn, spawnSync } from "node:child_process";

/** Editors that open their own window and return immediately. */
export const GUI_EDITORS = [
  "code", "code-insiders", "codium", "cursor", "windsurf", "subl",
  "sublime_text", "zed", "atom", "mate", "gedit", "kate", "notepad",
  "notepad++", "textedit", "bbedit",
];

/** Editors that take over the terminal, and need one to exist. */
export const TERMINAL_EDITORS = ["vi", "vim", "nvim", "nano", "emacs", "emacsclient", "helix", "hx", "micro", "kak", "ne", "ed"];

/**
 * Split an $EDITOR value into command and arguments, respecting quotes — a
 * Windows path like "C:\Program Files\Code\code.exe" is one token, not two.
 * Unquoted spaces stay ambiguous, and fall back to the platform default.
 */
export const tokenize = (value) =>
  (String(value ?? "").match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((t) => t.replace(/^["']|["']$/g, ""));

const commandName = (cmd) =>
  String(cmd ?? "")
    .split(/[\\/]/)
    .pop()
    .replace(/\.exe$/i, "")
    .toLowerCase();

/**
 * How to open `path` for editing here. Returns the command to run and whether
 * to wait for it — separated from running it so the choice can be tested on
 * every platform without opening anything.
 */
export function editorCommand(path, { platform = process.platform, env = process.env, isTty = false } = {}) {
  const configured = (env.VISUAL || env.EDITOR || "").trim();
  if (configured) {
    const parts = tokenize(configured);
    if (!parts.length) return platformDefault(path, platform);
    const name = commandName(parts[0]);
    const terminal = TERMINAL_EDITORS.includes(name);
    // An unrecognised editor is treated as a terminal one: waiting for a GUI
    // editor is a pause, but not waiting for a terminal one is a hang.
    const known = GUI_EDITORS.includes(name);
    if (!terminal && known) return { cmd: parts[0], args: [...parts.slice(1), path], wait: false, source: "$VISUAL/$EDITOR" };
    if (isTty) return { cmd: parts[0], args: [...parts.slice(1), path], wait: true, source: "$VISUAL/$EDITOR" };
    // Configured, but it needs a terminal and there is none. Fall through.
  }

  return platformDefault(path, platform);
}

/**
 * `-t` is the whole point on macOS: it opens the default *text editor* rather
 * than whatever app claims .json, which is usually a read-only viewer.
 */
function platformDefault(path, platform) {
  if (platform === "darwin") return { cmd: "open", args: ["-t", path], wait: false, source: "the default text editor" };
  if (platform === "win32") return { cmd: "notepad", args: [path], wait: false, source: "Notepad" };
  return { cmd: "xdg-open", args: [path], wait: false, source: "xdg-open" };
}

/** Open it. Never throws: a file you cannot open is not worth a stack trace. */
export function openInEditor(path, opts = {}) {
  const c = editorCommand(path, opts);
  try {
    if (c.wait) spawnSync(c.cmd, c.args, { stdio: "inherit" });
    else spawn(c.cmd, c.args, { detached: true, stdio: "ignore" }).unref();
    return c;
  } catch {
    return { ...c, error: true };
  }
}
