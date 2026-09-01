/**
 * What a skill costs to load.
 *
 * The transcript does not carry this. When a skill is invoked the tool result
 * is a stub — 24 to 37 bytes on the sessions here — because the body is
 * injected into the context rather than returned through the tool. So the only
 * honest source is the `SKILL.md` on disk, which is what gets injected.
 *
 * Two different costs, and they are worth keeping apart:
 *
 *   always  — the frontmatter `description`, which sits in every request for
 *             every available skill, invoked or not.
 *   onLoad  — the body, which joins the context when the skill is invoked and
 *             stays for the rest of the session.
 *
 * Tokens are estimated at 4 bytes each. That is an estimate, and it is labelled
 * as one everywhere it is shown — the real tokeniser is not available locally,
 * and shipping a guess dressed up as a measurement is how a tool stops being
 * believed.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";

/** Bytes per token. English prose sits near 4; code a little under. */
export const BYTES_PER_TOKEN = 4;

export const estimateTokens = (bytes) => Math.round(bytes / BYTES_PER_TOKEN);

/** Split a SKILL.md into its frontmatter description and its body. */
export function splitSkill(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { description: "", body: text };
  const front = m[1];
  const body = text.slice(m[0].length);
  const d = /^description:\s*(.*(?:\r?\n[ \t]+.*)*)/m.exec(front);
  return { description: d ? d[1].trim() : "", body };
}

/** Every directory a SKILL.md might live under, deepest search last. */
function skillRoots(root, cwd) {
  const roots = [join(root, "skills"), join(root, "plugins")];
  if (cwd) roots.push(join(cwd, ".claude", "skills"));
  return roots.filter((p) => existsSync(p));
}

function* findSkillFiles(dir, depth = 0) {
  if (depth > 6) return;
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* findSkillFiles(p, depth + 1);
    else if (e.name === "SKILL.md") yield p;
  }
}

/**
 * Every skill readable on this machine, keyed by the name a `Skill` tool call
 * uses. Plugin skills are indexed under both `name` and `plugin:name`, because
 * transcripts carry either.
 */
export function skillSizes({ root, cwd = null } = {}) {
  const out = {};
  for (const dir of skillRoots(root, cwd)) {
    for (const file of findSkillFiles(dir)) {
      let text;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const name = basename(dirname(file));
      const { description, body } = splitSkill(text);
      const rec = {
        name,
        path: file,
        bytes: Buffer.byteLength(text),
        always: estimateTokens(Buffer.byteLength(description)),
        onLoad: estimateTokens(Buffer.byteLength(body)),
      };
      out[name] ??= rec;

      // `plugins/<marketplace>/…/<plugin>/skills/<name>/SKILL.md` — the segment
      // two above `skills` is the plugin a `plugin:skill` call names.
      const parts = file.split("/");
      const si = parts.lastIndexOf("skills");
      if (si > 0) {
        const plugin = parts[si - 1];
        if (plugin && plugin !== "." ) out[`${plugin}:${name}`] ??= rec;
      }
    }
  }
  return out;
}

/** Roll skill invocation counts up against their measured sizes. */
export function skillCosts(counts, sizes) {
  const rows = [];
  for (const [name, calls] of Object.entries(counts ?? {})) {
    const size = sizes[name] ?? null;
    rows.push({
      name,
      calls,
      onLoad: size ? size.onLoad : null,
      always: size ? size.always : null,
      known: Boolean(size),
    });
  }
  return rows.sort((a, b) => (b.onLoad ?? 0) - (a.onLoad ?? 0) || b.calls - a.calls);
}
