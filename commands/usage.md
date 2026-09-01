---
name: usage
description: Where your Claude Code tokens are going and what to stop doing about it — nudges on idle MCP servers, long sessions, model choice and your plan limits, with the window they came from. Entirely local. Opens the full session browser page too.
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/marmot.mjs" report --sessions $ARGUMENTS`

The report above was produced by Marmot, reading this machine's own session
records under `~/.claude/projects`. Nothing was uploaded. It also built a
browser page and opened it — say where it was written, in one line.

Show it to the user as-is. Do not re-summarise the numbers or recompute them —
they are already the answer. If nothing was flagged, say so in one line.

What the user can do from here:

- `--days N` for a different window; `--no-browse` to stay in the terminal.
- `/marmot:config` to move a threshold that is firing too often or not enough.

If a rule fired on nearly every session, that is worth saying once: a cap that
matches their normal working pattern is describing them rather than flagging
anything, and raising it in `/marmot:config` is the fix.

On a subscription the report says "Modelled spend" — those dollars are a shadow
price at published API rates, not an invoice line, and the plan limits beside
them are what actually runs out. On pay-as-you-go it says "Spend", and there the
figure is the bill. Do not describe one as the other.
