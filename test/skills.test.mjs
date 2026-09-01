import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { splitSkill, skillSizes, skillCosts, estimateTokens } from "../src/skills.mjs";
import { distribution } from "../src/render.mjs";
import { tmpRoot } from "./helpers.mjs";

const writeSkill = (root, rel, text) => {
  const dir = join(root, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), text);
};

const SKILL = `---
name: demo
description: A one-line description that rides in every request.
---

# Demo

${"body text ".repeat(100)}`;

test("a skill splits into the always-on description and the on-load body", () => {
  const { description, body } = splitSkill(SKILL);
  assert.match(description, /rides in every request/);
  assert.ok(!body.includes("description:"), "frontmatter stays out of the body");
  assert.match(body, /# Demo/);
});

test("a file with no frontmatter is all body", () => {
  const { description, body } = splitSkill("# Just a heading\n\ntext");
  assert.equal(description, "");
  assert.match(body, /Just a heading/);
});

test("tokens are estimated at four bytes each", () => {
  assert.equal(estimateTokens(4000), 1000);
  assert.equal(estimateTokens(0), 0);
});

test("skills are found under the user, plugin and project trees", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  const cwd = join(root, "proj");
  writeSkill(root, "skills/mine", SKILL);
  writeSkill(root, "plugins/marketplaces/mp/external_plugins/toolkit/skills/deploy", SKILL);
  writeSkill(cwd, ".claude/skills/local", SKILL);

  const sizes = skillSizes({ root, cwd });
  assert.ok(sizes.mine, "user skill");
  assert.ok(sizes.deploy, "plugin skill by bare name");
  assert.ok(sizes["toolkit:deploy"], "and by plugin:skill, which is how transcripts name it");
  assert.ok(sizes.local, "project skill");
  assert.equal(sizes.deploy.path, sizes["toolkit:deploy"].path, "both keys are the same file");
});

test("a skill's cost is split between what is always sent and what loads on call", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  writeSkill(root, "skills/demo", SKILL);
  const s = skillSizes({ root }).demo;
  assert.ok(s.always > 0 && s.always < 30, "the description is small and always present");
  assert.ok(s.onLoad > 200, "the body is the real cost, and only on invocation");
  assert.ok(s.onLoad > s.always * 10);
});

test("a root with no skills yields nothing rather than throwing", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  assert.deepEqual(skillSizes({ root }), {});
  assert.deepEqual(skillSizes({ root: "/nonexistent" }), {});
});

test("skillCosts marks a skill it cannot measure rather than guessing", (t) => {
  const { root, cleanup } = tmpRoot();
  t.after(cleanup);
  writeSkill(root, "skills/demo", SKILL);
  const sizes = skillSizes({ root });

  const rows = skillCosts({ demo: 3, "built-in-one": 5 }, sizes);
  const demo = rows.find((r) => r.name === "demo");
  const builtin = rows.find((r) => r.name === "built-in-one");

  assert.equal(demo.known, true);
  assert.ok(demo.onLoad > 0);
  assert.equal(builtin.known, false);
  assert.equal(builtin.onLoad, null, "an unmeasurable skill reports null, never a number");
  assert.equal(builtin.calls, 5);
});

test("skillCosts on no invocations is empty", () => {
  assert.deepEqual(skillCosts({}, {}), []);
  assert.deepEqual(skillCosts(undefined, {}), []);
});

test("distribution reports mean, median and p99", () => {
  const d = distribution([1, 2, 3, 4, 100]);
  assert.equal(d.mean, 22);
  assert.equal(d.median, 3);
  assert.equal(d.p99, 100);
  assert.equal(d.max, 100);
});

test("distribution of one value, and of none", () => {
  assert.deepEqual(distribution([7]), { mean: 7, median: 7, p99: 7, max: 7 });
  assert.deepEqual(distribution([]), { mean: 0, median: 0, p99: 0, max: 0 });
});
