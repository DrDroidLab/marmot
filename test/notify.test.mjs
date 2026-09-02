/**
 * These tests never raise a real notification or ring a real bell. `alert()`
 * takes its stream, platform and env as arguments precisely so this can assert
 * on the decision rather than on a popup someone has to watch for.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { notifyCommand, alert, silenced, deliverability, oscNotifier, oscSequence, iconPath, dialogCommand, notifyStyle } from "../src/notify.mjs";
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

test("deliverability reports the overriding app, not the host", () => {
  const d = deliverability({ platform: "darwin", env: { __CFBundleIdentifier: "com.microsoft.VSCode" }, app: "com.googlecode.iterm2" });
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

test("the notification carries a sound when the bell is on", () => {
  // A terminal BEL needs a controlling terminal and a terminal that rings.
  // The notification's own sound is audible wherever the notification is.
  const withSound = notifyCommand("darwin", "Marmot", "reached $82.50", quiet, null, "Ping");
  assert.match(withSound.args[1], /sound name "Ping"$/);
  assert.doesNotMatch(notifyCommand("darwin", "Marmot", "x", quiet, null, null).args[1], /sound name/);
});

test("alert asks for a sound only when the bell is configured", () => {
  const s = fakeStream();
  const on = alert({ notify: { bell: true, desktop: true, sound: "Glass" } }, { body: "x", platform: "darwin", stream: s, env: quiet, ttyPath: null });
  if (on.desktop) assert.match(on.desktop.args[1], /sound name "Glass"/);
  const off = alert({ notify: { bell: false, desktop: true } }, { body: "x", platform: "darwin", stream: s, env: quiet, ttyPath: null });
  if (off.desktop) assert.doesNotMatch(off.desktop.args[1], /sound name/);
});

test("doctor names the channel and never calls a working setup broken", () => {
  // An earlier version read com.apple.ncprefs and reported "blocked" for an app
  // that was merely unregistered — then delivery from exactly such an app
  // worked. A false alarm that talks someone out of a working feature is worse
  // than no check.
  const mac = deliverability({ platform: "darwin", env: { __CFBundleIdentifier: "com.microsoft.VSCode" } });
  assert.equal(mac.status, "ok");
  assert.equal(mac.channel, "macos");
  assert.match(mac.detail, /com\.microsoft\.VSCode/);

  assert.equal(deliverability({ platform: "linux", env: {} }).channel, "linux");
  assert.equal(deliverability({ platform: "win32", env: {} }).channel, "windows", "Windows has a notifier now");
  assert.equal(deliverability({ platform: "darwin", env: { MARMOT_NO_NOTIFY: "1" } }).status, "silenced");
});

test("Linux gets notify-send", () => {
  const c = notifyCommand("linux", "Marmot", "a nudge");
  assert.equal(c.cmd, "notify-send");
  // The icon is included when it is on disk, which it is in a checkout.
  assert.equal(c.args[0], "--app-name=Marmot");
  assert.deepEqual(c.args.slice(-2), ["Marmot", "a nudge"]);
});

test("the marmot is shipped as both an SVG and an ICO", () => {
  // Linux takes any image path; Windows needs an .ico specifically. macOS shows
  // the posting application's icon and gives us no say, so there is nothing to
  // ship for it.
  assert.ok(iconPath("svg"), "the SVG the README uses");
  assert.ok(iconPath("ico"), "and the ICO Windows needs");
  assert.equal(iconPath("nonexistent-kind"), null, "a missing icon is null, not a throw");
});

test("Linux is given the marmot to show", () => {
  const c = notifyCommand("linux", "Marmot", "a nudge", quiet, null, null);
  const i = c.args.indexOf("-i");
  assert.ok(i > 0, "notify-send takes an icon path");
  assert.match(c.args[i + 1], /marmot\.svg$/);
});

test("Windows loads the icon file rather than a system glyph", () => {
  const ps = notifyCommand("win32", "Marmot", "a nudge", quiet, null, null).args[5];
  assert.match(ps, /New-Object System\.Drawing\.Icon\('.*marmot\.ico'\)/);
  assert.doesNotMatch(ps, /SystemIcons/, "the fallback is only for when the file is missing");
});

test("Windows gets a real notification, with nothing to install", () => {
  // NotifyIcon ships with the .NET Framework present on every Windows since 7,
  // and Windows 10/11 render its balloon as a toast. BurntToast would be nicer
  // and is installed nowhere by default.
  const c = notifyCommand("win32", "Marmot · cost cap", "reached $82.50", quiet, null, "Ping");
  assert.equal(c.cmd, "powershell");
  assert.deepEqual(c.args.slice(0, 4), ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden"]);
  const ps = c.args[5];
  assert.match(ps, /NotifyIcon/);
  assert.match(ps, /marmot\.ico/, "and it is the marmot");
  assert.match(ps, /ShowBalloonTip\(8000\)/);
  assert.match(ps, /SystemSounds\]::Asterisk\.Play/, "the bell, on Windows");
  assert.match(ps, /\$82\.50/, "figures survive: $ is inert in a single-quoted PowerShell string");
  assert.match(ps, /Start-Sleep/, "the icon must outlive the balloon or nothing shows");
});

test("a Windows notification cannot be broken out of by an apostrophe", () => {
  // The only escape inside a PowerShell single-quoted literal is a doubled
  // quote, so that is the one thing that has to be handled.
  const c = notifyCommand("win32", "Marmot", "it's over, 'quoted' text", quiet, null, null);
  assert.match(c.args[5], /'it''s over, ''quoted'' text'/);
  assert.doesNotMatch(c.args[5], /SystemSounds/, "and no sound when the bell is off");
});

test("Linux asks notify-send for a sound only when the bell is on", () => {
  const withSound = notifyCommand("linux", "Marmot", "a nudge", quiet, null, "Ping");
  assert.ok(withSound.args.includes("--hint=string:sound-name:message-new-instant"));
  const without = notifyCommand("linux", "Marmot", "a nudge", quiet, null, null);
  assert.ok(!without.args.some((a) => a.startsWith("--hint")));
});

test("an unknown platform gets no notifier, and says so", () => {
  assert.equal(notifyCommand("freebsd", "Marmot", "a nudge"), null);
  assert.equal(deliverability({ platform: "freebsd", env: {} }).status, "unsupported");
  assert.equal(deliverability({ platform: "win32", env: {} }).channel, "windows");
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
  assert.ok(!script.includes("\\"), "nothing that could escape inside the literal");

  // `$` and backticks stay: the command is spawned with an argument array, so
  // there is no shell to interpret them, and a cost nudge needs its figures.
  const money = notifyCommand("darwin", "Marmot", "reached $82.50 `now`", quiet);
  assert.match(money.args[1], /\$82\.50/);
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

test("a platform with no notifier still rings the bell", () => {
  const s = fakeStream();
  const did = alert(DEFAULTS, { body: "a nudge", platform: "freebsd", stream: s, env: quiet, ttyPath: null });
  assert.equal(did.bell, "stderr");
  assert.equal(did.desktop, null);
});

/* ── staying put until dismissed ───────────────────────────────────────── */

test("persistence is on by default", () => {
  assert.equal(DEFAULTS.notify.persist, true);
});

test("Linux is asked for critical urgency, which is what stops it expiring", () => {
  const on = notifyCommand("linux", "Marmot", "a nudge", quiet, null, null, true);
  const i = on.args.indexOf("-u");
  assert.equal(on.args[i + 1], "critical");
  assert.ok(on.args.includes("-t") && on.args[on.args.indexOf("-t") + 1] === "0");

  const off = notifyCommand("linux", "Marmot", "a nudge", quiet, null, null, false);
  assert.ok(!off.args.includes("-u"));
});

test("Windows holds the balloon up, and holds the icon up with it", () => {
  const on = notifyCommand("win32", "Marmot", "a nudge", quiet, null, null, true).args[5];
  assert.match(on, /ShowBalloonTip\(60000\)/);
  // The icon has to outlive the balloon or the balloon goes with it.
  assert.match(on, /Start-Sleep -Seconds 61/);

  const off = notifyCommand("win32", "Marmot", "a nudge", quiet, null, null, false).args[5];
  assert.match(off, /ShowBalloonTip\(8000\)/);
});

test("macOS cannot be told, so it is told to the user instead", () => {
  // `display notification` has no persistence option at all — it is a syntax
  // error. Whether one waits or fades is the delivering app's Alert style,
  // which only a person can set.
  const withHost = deliverability({ platform: "darwin", env: { __CFBundleIdentifier: "com.googlecode.iterm2" } });
  assert.match(withHost.persistHint, /Alert style: Alerts/);
  assert.match(withHost.persistHint, /iterm2/);

  // And the AppleScript itself carries nothing about it either way.
  const script = notifyCommand("darwin", "Marmot", "a nudge", quiet, null, null, true).args[1];
  assert.doesNotMatch(script, /persist|timeout|urgency/i);
});

test("alert passes persistence through, and off means off", () => {
  // Asserted on the command rather than by spawning one: this suite must not
  // depend on notify-send existing, nor leave a process behind.
  const on = notifyCommand("linux", "Marmot", "x", quiet, null, null, true);
  assert.ok(on.args.includes("critical"));
  const off = notifyCommand("linux", "Marmot", "x", quiet, null, null, false);
  assert.ok(!off.args.includes("critical"));
});

test("a binary that is not there cannot take the process down with it", () => {
  // spawn reports failure asynchronously, as an `error` event. try/catch never
  // sees it, and an unhandled one is fatal — which would kill the very nudge it
  // was announcing.
  const s = fakeStream();
  assert.doesNotThrow(() =>
    alert({ notify: { desktop: true, bell: false } }, { body: "x", platform: "linux", stream: s, env: quiet, ttyPath: null }),
  );
});


/**
 * Dialogs. These assert on the command that would be run, never by running it:
 * a test that pops a real box is a test somebody has to sit and click.
 *
 * Where `alert()` itself is under test the platform is win32, because spawning
 * a missing `powershell` on the machine running these fails harmlessly and
 * asynchronously — while spawning `osascript` would succeed, and put a dialog
 * on the screen of whoever ran `npm test`.
 */

test("a dialog is for the nudge that says you are about to run out, not the ones before it", () => {
  // The whole design in four lines: something that interrupts every time is
  // something you switch off, and then the last mark cannot reach you either.
  assert.equal(notifyStyle({}, false), "banner");
  assert.equal(notifyStyle({}, true), "alert");
  assert.equal(notifyStyle({ notify: { style: "banner" } }, true), "banner", "forced off, even when urgent");
  assert.equal(notifyStyle({ notify: { style: "alert" } }, false), "alert", "forced on, even when not");
  assert.equal(notifyStyle({ notify: { style: "nonsense" } }, true), "alert", "an unreadable setting falls back to auto");
});

test("the macOS dialog carries the marmot and waits for a click", () => {
  const c = dialogCommand("darwin", "Marmot", "90% of your weekly limit is gone.", null, "/tmp/marmot.png");
  const script = c.args[1];
  assert.equal(c.cmd, "osascript");
  assert.match(script, /display dialog/);
  assert.match(script, /with icon POSIX file "\/tmp\/marmot.png"/, "the icon display notification cannot have");
  assert.match(script, /buttons \{"Dismiss"\}/);
  assert.doesNotMatch(script, /giving up after/, "a timeout is the one thing it must not have");
});

test("a dialog keeps the line breaks a banner has to flatten", () => {
  // The reason to want one, beyond persistence: room for what to do about it.
  const c = dialogCommand("darwin", "t", "What it cost.\n\nWhat to do instead.", null, null);
  assert.match(c.args[1], /What it cost\.\n\nWhat to do instead\./);

  const banner = notifyCommand("darwin", "t", "What it cost.\n\nWhat to do instead.", quiet);
  assert.match(banner.args[1], /What it cost\. What to do instead\./, "a banner still gets one line");
});

test("a dollar figure survives into the dialog", () => {
  // Stripping shell metacharacters here once cost every cost nudge its dollar
  // sign, and "reached 82.50" is not a sentence about money.
  assert.match(dialogCommand("darwin", "t", "reached $82.50 against a $25.00 cap", null, null).args[1], /\$82\.50/);
});

test("the dialog's sound name cannot carry a shell command", () => {
  // Unlike everything else here it is interpolated into a `do shell script`,
  // so it is whitelisted rather than escaped.
  assert.match(dialogCommand("darwin", "t", "b", "Glass", null).args[1], /afplay \/System\/Library\/Sounds\/Glass\.aiff/);
  assert.doesNotMatch(dialogCommand("darwin", "t", "b", "x; rm -rf /", null).args[1], /afplay/);
  assert.doesNotMatch(dialogCommand("darwin", "t", "b", null, null).args[1], /afplay/);
});

test("Windows gets a message box, because its toast retires itself whatever timeout it is given", () => {
  const c = dialogCommand("win32", "Marmot", "90% of your weekly limit is gone.", null, null);
  assert.equal(c.cmd, "powershell");
  assert.match(c.args[c.args.length - 1], /MessageBox\]::Show/);
  assert.match(c.args[c.args.length - 1], /'Warning'/);
});

test("Linux gets no dialog, because its critical notification already never expires", () => {
  // And zenity is not installed everywhere — a failed spawn there would cost
  // the nudge entirely, which is worse than the banner it already has.
  assert.equal(dialogCommand("linux", "t", "b"), null);
  const banner = notifyCommand("linux", "t", "b", quiet, null, null, true);
  assert.ok(banner.args.includes("-u") && banner.args.includes("critical"));
});

test("an empty body raises no dialog", () => {
  assert.equal(dialogCommand("darwin", "t", "   "), null);
});

test("an urgent nudge takes the dialog, and skips the terminal's banner to get it", () => {
  // iTerm2 would happily post an OSC banner here — which is exactly the thing
  // this nudge was judged too important to be.
  const did = alert(DEFAULTS, { title: "t", body: "b", urgent: true, platform: "win32", env: { TERM_PROGRAM: "iTerm.app" }, ttyPath: null, stream: fakeStream() });
  assert.equal(did.style, "alert");
  assert.equal(did.desktop.style, "alert");
  assert.match(did.desktop.args[did.desktop.args.length - 1], /MessageBox/);
});

test("an ordinary nudge still goes out as a banner", () => {
  const did = alert(DEFAULTS, { title: "t", body: "b", urgent: false, platform: "win32", env: quiet, ttyPath: null, stream: fakeStream() });
  assert.equal(did.style, "banner");
  assert.match(did.desktop.args[did.desktop.args.length - 1], /BalloonTip/);
});

test("notify.style banner keeps the dialog away even from the last mark", () => {
  const cfg = { ...DEFAULTS, notify: { ...DEFAULTS.notify, style: "banner" } };
  const did = alert(cfg, { title: "t", body: "b", urgent: true, platform: "win32", env: quiet, ttyPath: null, stream: fakeStream() });
  assert.equal(did.style, "banner");
  assert.match(did.desktop.args[did.desktop.args.length - 1], /BalloonTip/);
});

test("a silenced environment raises no dialog either", () => {
  const did = alert(DEFAULTS, { title: "t", body: "b", urgent: true, platform: "win32", env: { MARMOT_NO_NOTIFY: "1" }, ttyPath: null, stream: fakeStream() });
  assert.equal(did.desktop, null);
});

test("doctor reports a dialog as answering both questions at once", () => {
  const d = deliverability({ platform: "darwin", env: quiet, style: "alert" });
  assert.equal(d.channel, "dialog");
  assert.equal(d.persistHint, null, "nothing for the user to go and set");
  const linux = deliverability({ platform: "linux", env: quiet, style: "alert" });
  assert.equal(linux.channel, "linux", "no dialog there, so nothing changes");
});

test("the marmot ships in every format its platforms need", () => {
  for (const kind of ["png", "ico", "svg"]) assert.ok(iconPath(kind), `docs/marmot.${kind} is missing`);
});

test("every icon the notifiers reach for is actually published", () => {
  // iconPath() resolves against the installed copy, so an asset left out of
  // package.json `files` fails only on someone else's machine, silently, as a
  // notification with no marmot on it.
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  for (const kind of ["png", "ico", "svg"]) {
    assert.ok(pkg.files.includes(`docs/marmot.${kind}`), `docs/marmot.${kind} is used but not shipped`);
  }
});
