/**
 * These tests never raise a real notification or ring a real bell. `alert()`
 * takes its stream, platform and env as arguments precisely so this can assert
 * on the decision rather than on a popup someone has to watch for.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { notifyCommand, alert, silenced } from "../src/notify.mjs";
import { DEFAULTS } from "../src/config.mjs";

/** Collects what would have been written, in place of stderr. */
const fakeStream = () => {
  const written = [];
  return { written, write: (s) => (written.push(s), true) };
};

const quiet = {}; // an env with nothing set

test("both alerts are on by default", () => {
  assert.equal(DEFAULTS.notify.desktop, true);
  assert.equal(DEFAULTS.notify.bell, true);
});

test("macOS gets an osascript notification", () => {
  const c = notifyCommand("darwin", "Marmot · Session past the cost cap", "This session has reached $64.");
  assert.equal(c.cmd, "osascript");
  assert.equal(c.args[0], "-e");
  assert.match(c.args[1], /^display notification "/);
  assert.match(c.args[1], /with title "Marmot · Session past the cost cap"$/);
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
  assert.equal(notifyCommand("darwin", "Marmot", ""), null);
  assert.equal(notifyCommand("darwin", "Marmot", "   "), null);
});

test("quotes and backslashes cannot break out of the AppleScript string", () => {
  // The body is interpolated into an -e argument, so anything that could close
  // the literal or start a substitution has to be gone before it gets there.
  const nasty = 'oops" & (do shell script "touch /tmp/pwned") & "';
  const c = notifyCommand("darwin", "Marmot", nasty);
  const script = c.args[1];
  // Exactly two quotes for the body and two for the title, and no more.
  assert.equal((script.match(/"/g) ?? []).length, 4);
  assert.ok(!script.includes('\\'));
  assert.ok(!script.includes("$"));
  assert.ok(!script.includes("`"));
});

test("a multi-line detail is flattened and capped", () => {
  const c = notifyCommand("darwin", "Marmot", `line one\nline two\n\n   line three`);
  assert.match(c.args[1], /line one line two line three/);
  const long = notifyCommand("darwin", "Marmot", "x".repeat(500));
  assert.ok(long.args[1].length < 260, "the body is capped");
});

test("the bell goes to the given stream, never stdout", () => {
  const s = fakeStream();
  const did = alert({ notify: { bell: true, desktop: false } }, { body: "a nudge", stream: s, env: quiet });
  assert.deepEqual(s.written, ["\x07"]);
  assert.equal(did.bell, true);
  assert.equal(did.desktop, null);
});

test("the bell can be turned off on its own", () => {
  const s = fakeStream();
  const did = alert({ notify: { bell: false, desktop: false } }, { body: "a nudge", stream: s, env: quiet });
  assert.deepEqual(s.written, []);
  assert.equal(did.bell, false);
});

test("the desktop notification can be turned off on its own", () => {
  const s = fakeStream();
  const did = alert({ notify: { bell: true, desktop: false } }, { body: "a nudge", platform: "darwin", stream: s, env: quiet });
  assert.equal(did.bell, true);
  assert.equal(did.desktop, null, "no notification was raised");
});

test("no notify config at all is silent rather than a crash", () => {
  const s = fakeStream();
  assert.doesNotThrow(() => alert({}, { body: "a nudge", stream: s, env: quiet }));
  assert.doesNotThrow(() => alert(undefined, { body: "a nudge", stream: s, env: quiet }));
  assert.deepEqual(s.written, []);
});

test("MARMOT_NO_NOTIFY and CI silence both channels", () => {
  assert.equal(silenced({ MARMOT_NO_NOTIFY: "1" }), true);
  assert.equal(silenced({ CI: "true" }), true);
  assert.equal(silenced({}), false);

  for (const env of [{ MARMOT_NO_NOTIFY: "1" }, { CI: "true" }]) {
    const s = fakeStream();
    const did = alert(DEFAULTS, { body: "a nudge", platform: "darwin", stream: s, env });
    assert.deepEqual(s.written, [], "no bell when silenced");
    assert.equal(did.desktop, null, "no popup when silenced");
  }
});

test("a stream that throws does not take the nudge down with it", () => {
  const bad = { write: () => { throw new Error("EPIPE"); } };
  assert.doesNotThrow(() => alert({ notify: { bell: true, desktop: false } }, { body: "a nudge", stream: bad, env: quiet }));
});

test("an unwritable platform still rings the bell", () => {
  const s = fakeStream();
  const did = alert(DEFAULTS, { body: "a nudge", platform: "win32", stream: s, env: quiet });
  assert.equal(did.bell, true, "Windows gets the bell even without a popup");
  assert.equal(did.desktop, null);
});
