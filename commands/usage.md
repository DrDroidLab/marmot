---
name: usage
description: Your own Claude Code usage — spend, trends, every session, and nudges on turns, cost and model mix. Entirely local. Add --browse for the full session browser page.
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/marmot.mjs" report --sessions $ARGUMENTS`

The report above was produced by Marmot, reading this machine's own session
records under `~/.claude/projects`. Nothing was uploaded.

Show it to the user as-is. Do not re-summarise the numbers or recompute them —
they are already the answer. If nothing was flagged, say so in one line.

What the user can do from here:

- `--days N` for a different window; `--browse` to open the full session browser
  page, which carries every prompt, reply and tool call.
- `/marmot:config` to move a threshold that is firing too often or not enough.

If a rule fired on nearly every session, that is worth saying once: a cap that
matches their normal working pattern is describing them rather than flagging
anything, and raising it in `/marmot:config` is the fix.

Cost here is a shadow price at published API rates, not an invoice line. If the
user reads it as a bill, correct that once.
