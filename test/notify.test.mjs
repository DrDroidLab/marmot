/**
 * These tests never raise a real notification or ring a real bell. `alert()`
 * takes its stream, platform and env as arguments precisely so this can assert
 * on the decision rather than on a popup someone has to watch for.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { notifyCommand, alert, silenced, deliverability, oscNotifier, oscSequence } from "../src/notify.mjs";
import { DEFAULTS } from "../src/config.mjs";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Collects what would have been written, in place of stderr. */
const fakeStream = () => {
  const written = [];
  return { written, write: (s) => (written.push(s), true) };
};

const quiet = {}; // an env with nothing set — never process.env, or these
                  // tests read whichever terminal happens to be running them

test("the terminal posts the notification itself where it can", () => {
  // This is the channel worth having: nothing to install, nothing to grant,
  // and identical on macOS, Linux and Windows.
  assert.equal(oscNotifier({ TERM_PROGRAM: "iTerm.app" }).name, "iTerm2");
  assert.equal(oscNotifier({ TERM_PROGRAM: "ghostty" }).name, "Ghostty");
  assert.equal(oscNotifier({ TERM_PROGRAM: "WezTerm" }).name, "WezTerm");
  assert.equal(oscNotifier({ WEZTERM_PANE: "0" }).name, "WezTerm");
  assert.equal(oscNotifier({ KITTY_WINDOW_ID: "1" }).name, "kitty");
  assert.equal(oscNotifier({ WT_SESSION: "abc" }).name, "Windows Terminal");
  assert.equal(oscNotifier({ KONSOLE_VERSION: "22" }).name, "Konsole");
});

test("an unknown terminal gets no escape sequence at all", () => {
  // Some terminals print an OSC they do not understand. Garbling the screen is
  // worse than a missing notification, so only known ones are used.
  assert.equal(oscNotifier({ TERM_PROGRAM: "vscode" }), null);
  assert.equal(oscNotifier({ TERM_PROGRAM: "Apple_Terminal" }), null);
  assert.equal(oscNotifier({}), null);
});

test("the escape sequence keeps the figures and cannot end itself early", () => {
  const seq = oscSequence({ osc: 9 }, "Marmot · cost cap", "reached $82.50 against a $25.00 cap");
  assert.match(seq, /\$82\.50/, "a cost nudge that loses its dollar sign is useless");
  assert.equal(seq.slice(0, 4), "\x1b]9;");
  assert.equal(seq.slice(-1), "\x07");

  // `;` and control characters would terminate the sequence.
  const nasty = oscSequence({ osc: 9 }, "T", "a;b\x07c\nd");
  assert.equal((nasty.match(/;/g) ?? []).length, 1, "only the sequence's own separator");
  assert.equal((nasty.match(/\x07/g) ?? []).length, 1, "only the terminator");
});

test("kitty and Konsole get their own forms", () => {
  assert.match(oscSequence({ osc: 99 }, "T", "b"), /^\x1b\]99;/);
  assert.match(oscSequence({ osc: 777 }, "T", "b"), /^\x1b\]777;notify;T;b\x07$/);
  assert.equal(oscSequence({ osc: 9 }, "T", ""), null);
});

test("alert prefers the terminal, and says which one took it", (t) => {
  const s = fakeStream();
  const tmp = join(tmpdir(), `marmot-osc-${Date.now()}`);
  const did = alert(
    { notify: { bell: false, desktop: true } },
    { body: "reached $82.50", title: "Marmot", platform: "darwin", stream: s, env: { TERM_PROGRAM: "iTerm.app" }, ttyPath: tmp },
  );
  assert.deepEqual(did.desktop, { via: "iTerm2" });
  assert.match(readFileSync(tmp, "utf8"), /\x1b\]9;Marmot — reached \$82\.50\x07/);
  rmSync(tmp, { force: true });
});

test("with no terminal channel it falls back to the OS", () => {
  const s = fakeStream();
  const did = alert(
    { notify: { bell: false, desktop: true } },
    { body: "a nudge", platform: "darwin", stream: s, env: { TERM_PROGRAM: "vscode", __CFBundleIdentifier: "com.microsoft.VSCode" }, ttyPath: null },
  );
  if (did.desktop) assert.equal(did.desktop.cmd, "osascript");
});

test("doctor reports the terminal channel when there is one", () => {
  const d = deliverability({ platform: "darwin", env: { TERM_PROGRAM: "iTerm.app" } });
  assert.equal(d.status, "ok");
  assert.match(d.detail, /nothing to allow/);

  // And on Linux too, where there is no permission model to check.
  assert.equal(deliverability({ platform: "linux", env: { KITTY_WINDOW_ID: "1" } }).status, "ok");
});

test("both alerts are on by default", () => {
  assert.equal(DEFAULTS.notify.desktop, true);
  assert.equal(DEFAULTS.notify.bell, true);
});

test("macOS gets an osascript notification", () => {
  const c = notifyCommand("darwin", "Marmot · Session past the cost cap", "This session has reached $64.", quiet);
  assert.equal(c.cmd, "osascript");
  assert.equal(c.args[0], "-e");
  assert.match(c.args[1], /^display notification "/);
  assert.match(c.args[1], /with title "Marmot · Session past the cost cap"$/);
});

test("macOS attributes the notification to the host app when it can", () => {
  // A plain `display notification` is posted by Script Editor, which most people
  // have never authorised — macOS accepts it and drops it with no error. Posting
  // as the terminal the user is already using is what makes it arrive.
  const c = notifyCommand("darwin", "Marmot", "a nudge", { __CFBundleIdentifier: "com.googlecode.iterm2" });
  assert.match(c.args[1], /^tell application id "com\.googlecode\.iterm2" to display notification "a nudge"/);
});

test("notify.app overrides the host, for a host that can never be granted", () => {
  // macOS only lists apps that have registered themselves, and an app that is
  // not listed cannot be switched on — so there has to be a way to post as one
  // that is.
  const byId = notifyCommand("darwin", "Marmot", "a nudge", { __CFBundleIdentifier: "com.microsoft.VSCode" }, "com.googlecode.iterm2");
  assert.match(byId.args[1], /tell application id "com\.googlecode\.iterm2"/);

  // A name rather than a bundle id is accepted too, since that is what people
  // see in System Settings.
  const byName = notifyCommand("darwin", "Marmot", "a nudge", {}, "Script Editor");
  assert.match(byName.args[1], /tell application "Script Editor"/);
});

test("alert passes notify.app through", () => {
  const s = fakeStream();
  const did = alert(
    { notify: { bell: false, desktop: true, app: "com.googlecode.iterm2" } },
    { body: "a nudge", platform: "darwin", stream: s, env: { __CFBundleIdentifier: "com.microsoft.VSCode" }, ttyPath: null },
  );
  // The spawn may or may not succeed here; what matters is which app it named.
  if (did.desktop) assert.match(did.desktop.args[1], /com\.googlecode\.iterm2/);
});

test("deliverability checks the overriding app, not the host", () => {
  const d = deliverability({
    platform: "darwin",
    env: { __CFBundleIdentifier: "com.microsoft.VSCode", HOME: "/home/me" },
    app: "com.googlecode.iterm2",
    run: () => "<plist>com.googlecode.iterm2</plist>",
  });
  assert.equal(d.status, "ok");
  assert.equal(d.deliverer, "com.googlecode.iterm2");
});

test("with no host app it falls back to a plain notification", () => {
  const c = notifyCommand("darwin", "Marmot", "a nudge", {});
  assert.match(c.args[1], /^display notification "a nudge"/);
});

test("a host bundle id cannot break out of the script either", () => {
  const c = notifyCommand("darwin", "Marmot", "a nudge", { __CFBundleIdentifier: 'evil" & (do shell script "boom") & "' });
  assert.equal((c.args[1].match(/"/g) ?? []).length, 6, "id, body and title: three quoted strings, no more");
});

test("deliverability reports a blocked app rather than staying quiet", () => {
  // The plist lists every app that may post. An app absent from it is dropped.
  const listed = deliverability({
    platform: "darwin",
    env: { __CFBundleIdentifier: "com.googlecode.iterm2", HOME: "/home/me" },
    run: () => "<plist>com.googlecode.iterm2</plist>",
  });
  assert.equal(listed.status, "ok");
  assert.equal(listed.deliverer, "com.googlecode.iterm2");

  const missing = deliverability({
    platform: "darwin",
    env: { __CFBundleIdentifier: "com.microsoft.VSCode", HOME: "/home/me" },
    run: () => "<plist>com.googlecode.iterm2</plist>",
  });
  assert.equal(missing.status, "blocked");
  assert.match(missing.detail, /drop them silently/);
});

test("deliverability degrades to unknown rather than throwing", () => {
  const thrown = deliverability({ platform: "darwin", env: { HOME: "/home/me" }, run: () => { throw new Error("no plutil"); } });
  assert.equal(thrown.status, "unknown");
  assert.equal(thrown.deliverer, "com.apple.ScriptEditor2", "which is what a plain notification posts as");

  assert.equal(deliverability({ platform: "darwin", env: { HOME: "/x" }, run: () => "" }).status, "unknown");
  assert.equal(deliverability({ platform: "linux", env: {} }).status, "unknown");
  assert.equal(deliverability({ platform: "darwin", env: { MARMOT_NO_NOTIFY: "1" } }).status, "silenced");
});

test("Linux gets notify-send", () => {
  const c = notifyCommand("linux", "Marmot", "a nudge");
  assert.equal(c.cmd, "notify-send");
  assert.deepEqual(c.args, ["--app-name=Marmot", "Marmot", "a nudge"]);
});

test("a platform with no dependable notifier gets none", () => {
  assert.equal(notifyCommand("win32", "Marmot", "a nudge"), null);
  assert.equal(notifyCommand("freebsd", "Marmot", "a nudge"), null);
});

test("an empty body raises nothing", () => {
  assert.equal(notifyCommand("darwin", "Marmot", "", quiet), null);
  assert.equal(notifyCommand("darwin", "Marmot", "   ", quiet), null);
});

test("quotes and backslashes cannot break out of the AppleScript string", () => {
  // The body is interpolated into an -e argument, so anything that could close
  // the literal or start a substitution has to be gone before it gets there.
  const nasty = 'oops" & (do shell script "touch /tmp/pwned") & "';
  const c = notifyCommand("darwin", "Marmot", nasty, quiet);
  const script = c.args[1];
  // Exactly two quotes for the body and two for the title, and no more.
  assert.equal((script.match(/"/g) ?? []).length, 4);
  assert.ok(!script.includes('\\'));
  assert.ok(!script.includes("$"));
  assert.ok(!script.includes("`"));
});

test("a multi-line detail is flattened and capped", () => {
  const c = notifyCommand("darwin", "Marmot", `line one\nline two\n\n   line three`, quiet);
  assert.match(c.args[1], /line one line two line three/);
  const long = notifyCommand("darwin", "Marmot", "x".repeat(500), quiet);
  assert.ok(long.args[1].length < 260, "the body is capped");
});

test("the bell goes to the given stream, never stdout", () => {
  const s = fakeStream();
  const did = alert({ notify: { bell: true, desktop: false } }, { body: "a nudge", stream: s, env: quiet, ttyPath: null });
  assert.deepEqual(s.written, ["\x07"]);
  assert.equal(did.bell, "stderr");
  assert.equal(did.desktop, null);
});

test("the bell prefers the real terminal over a piped stderr", (t) => {
  // A hook's stderr is a pipe Claude Code reads, so a bell written there never
  // reaches the terminal. /dev/tty is the only place it can actually ring.
  const s = fakeStream();
  const tmp = join(tmpdir(), `marmot-tty-${Date.now()}`);
  const did = alert({ notify: { bell: true, desktop: false } }, { body: "a nudge", stream: s, env: quiet, ttyPath: tmp });
  assert.equal(did.bell, "tty");
  assert.deepEqual(s.written, [], "and stderr is left alone when the terminal took it");
  assert.equal(readFileSync(tmp, "utf8"), "\x07");
  rmSync(tmp, { force: true });
});

test("the bell falls back to stderr when there is no terminal", () => {
  const s = fakeStream();
  const did = alert({ notify: { bell: true, desktop: false } }, { body: "a nudge", stream: s, env: quiet, ttyPath: "/nonexistent/dir/tty" });
  assert.equal(did.bell, "stderr");
  assert.deepEqual(s.written, ["\x07"]);
});

test("the bell can be turned off on its own", () => {
  const s = fakeStream();
  const did = alert({ notify: { bell: false, desktop: false } }, { body: "a nudge", stream: s, env: quiet, ttyPath: null });
  assert.deepEqual(s.written, []);
  assert.equal(did.bell, false);
});

test("the desktop notification can be turned off on its own", () => {
  const s = fakeStream();
  const did = alert({ notify: { bell: true, desktop: false } }, { body: "a nudge", platform: "darwin", stream: s, env: quiet, ttyPath: null });
  assert.equal(did.bell, "stderr");
  assert.equal(did.desktop, null, "no notification was raised");
});

test("no notify config at all is silent rather than a crash", () => {
  const s = fakeStream();
  assert.doesNotThrow(() => alert({}, { body: "a nudge", stream: s, env: quiet, ttyPath: null }));
  assert.doesNotThrow(() => alert(undefined, { body: "a nudge", stream: s, env: quiet, ttyPath: null }));
  assert.deepEqual(s.written, []);
});

test("MARMOT_NO_NOTIFY and CI silence both channels", () => {
  assert.equal(silenced({ MARMOT_NO_NOTIFY: "1" }), true);
  assert.equal(silenced({ CI: "true" }), true);
  assert.equal(silenced({}), false);

  for (const env of [{ MARMOT_NO_NOTIFY: "1" }, { CI: "true" }]) {
    const s = fakeStream();
    const did = alert(DEFAULTS, { body: "a nudge", platform: "darwin", stream: s, env, ttyPath: null });
    assert.deepEqual(s.written, [], "no bell when silenced");
    assert.equal(did.desktop, null, "no popup when silenced");
  }
});

test("a stream that throws does not take the nudge down with it", () => {
  const bad = { write: () => { throw new Error("EPIPE"); } };
  assert.doesNotThrow(() => alert({ notify: { bell: true, desktop: false } }, { body: "a nudge", stream: bad, env: quiet, ttyPath: null }));
});

test("an unwritable platform still rings the bell", () => {
  const s = fakeStream();
  const did = alert(DEFAULTS, { body: "a nudge", platform: "win32", stream: s, env: quiet, ttyPath: null });
  assert.equal(did.bell, "stderr", "Windows gets the bell even without a popup");
  assert.equal(did.desktop, null);
});
