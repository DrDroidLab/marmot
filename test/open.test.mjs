/**
 * Which editor gets chosen, on every platform, without opening anything.
 * `editorCommand` takes platform, env and TTY as arguments for exactly this.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { editorCommand } from "../src/open.mjs";

const P = "/home/me/.claude/marmot.json";
const bare = {}; // no VISUAL, no EDITOR

test("macOS opens the default text editor, not whatever claims .json", () => {
  // The bug this fixes: plain `open` hands a .json to Xcode or a browser and
  // you get a read-only view of a file you were trying to edit. `-t` asks for
  // the text editor specifically.
  const c = editorCommand(P, { platform: "darwin", env: bare });
  assert.equal(c.cmd, "open");
  assert.deepEqual(c.args, ["-t", P]);
  assert.equal(c.wait, false);
});

test("Windows opens Notepad rather than the file association", () => {
  const c = editorCommand(P, { platform: "win32", env: bare });
  assert.equal(c.cmd, "notepad");
  assert.deepEqual(c.args, [P]);
});

test("Linux falls back to xdg-open", () => {
  const c = editorCommand(P, { platform: "linux", env: bare });
  assert.equal(c.cmd, "xdg-open");
  assert.deepEqual(c.args, [P]);
});

test("a GUI editor in $EDITOR is used anywhere, terminal or not", () => {
  for (const editor of ["code", "cursor", "subl", "zed"]) {
    const c = editorCommand(P, { platform: "darwin", env: { EDITOR: editor }, isTty: false });
    assert.equal(c.cmd, editor, `${editor} should be used without a TTY`);
    assert.equal(c.wait, false, "a GUI editor is not waited on");
    assert.equal(c.source, "$VISUAL/$EDITOR");
  }
});

test("arguments in $EDITOR are preserved, with the path last", () => {
  const c = editorCommand(P, { platform: "darwin", env: { EDITOR: "code -w --new-window" }, isTty: false });
  assert.equal(c.cmd, "code");
  assert.deepEqual(c.args, ["-w", "--new-window", P]);
});

test("a terminal editor is used only when there is a terminal", () => {
  for (const editor of ["vim", "nvim", "nano", "emacs", "hx"]) {
    const withTty = editorCommand(P, { platform: "darwin", env: { EDITOR: editor }, isTty: true });
    assert.equal(withTty.cmd, editor);
    assert.equal(withTty.wait, true, "and it is waited on, or it cannot be used");

    // Run from a slash command there is no TTY, and spawning vim there hangs.
    const without = editorCommand(P, { platform: "darwin", env: { EDITOR: editor }, isTty: false });
    assert.equal(without.cmd, "open", `${editor} must not be spawned without a terminal`);
    assert.deepEqual(without.args, ["-t", P]);
  }
});

test("an editor given by full path is recognised by its name", () => {
  const c = editorCommand(P, { platform: "linux", env: { EDITOR: "/usr/local/bin/nvim" }, isTty: false });
  assert.equal(c.cmd, "xdg-open", "still a terminal editor, whatever path it was given by");

  // A Windows path with a space has to be quoted to be one token — which is
  // how it is actually written in an environment variable.
  const gui = editorCommand(P, { platform: "win32", env: { EDITOR: '"C:\\\\Program Files\\\\Code\\\\code.exe"' }, isTty: false });
  assert.equal(gui.source, "$VISUAL/$EDITOR", ".exe and backslashes still resolve to code");
  assert.equal(gui.wait, false);

  // Unquoted, the spaces are genuinely ambiguous, so we use the safe default.
  const unquoted = editorCommand(P, { platform: "win32", env: { EDITOR: "C:\\\\Program Files\\\\Code\\\\code.exe" }, isTty: false });
  assert.equal(unquoted.cmd, "notepad");
});

test("VISUAL wins over EDITOR", () => {
  const c = editorCommand(P, { platform: "darwin", env: { VISUAL: "code", EDITOR: "vim" }, isTty: true });
  assert.equal(c.cmd, "code");
});

test("an unknown editor is treated as a terminal one", () => {
  // Waiting on a GUI editor is a pause; not waiting on a terminal one is a
  // hang. The safe guess is the one that cannot hang.
  const withTty = editorCommand(P, { platform: "linux", env: { EDITOR: "my-strange-editor" }, isTty: true });
  assert.equal(withTty.cmd, "my-strange-editor");
  assert.equal(withTty.wait, true);

  const without = editorCommand(P, { platform: "linux", env: { EDITOR: "my-strange-editor" }, isTty: false });
  assert.equal(without.cmd, "xdg-open");
});

test("an empty or whitespace-only EDITOR is ignored", () => {
  for (const v of ["", "   "]) {
    assert.equal(editorCommand(P, { platform: "darwin", env: { EDITOR: v } }).cmd, "open");
  }
});

test("every choice names where it came from, for the line we print", () => {
  assert.equal(editorCommand(P, { platform: "darwin", env: bare }).source, "the default text editor");
  assert.equal(editorCommand(P, { platform: "win32", env: bare }).source, "Notepad");
  assert.equal(editorCommand(P, { platform: "linux", env: bare }).source, "xdg-open");
});
