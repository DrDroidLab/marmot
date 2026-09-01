---
name: usage
description: Your own Claude Code token consumption for the last N days, with nudges on turns, cost and model mix. Entirely local.
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/marmot.mjs" report $ARGUMENTS`

The report above was produced by Marmot, reading this machine's own session
records under `~/.claude/projects`. Nothing was uploaded.

Show it to the user as-is. Do not re-summarise the numbers or recompute them —
they are already the answer. If the report flagged nothing, say so in one line.

If the user asks about a specific flag, the sessions behind it are listed with
their working directory and date; `marmot sessions --days N` lists them all,
and `marmot report --json` gives the same data machine-readable.

Cost here is a shadow price at published API rates, not an invoice line. If the
user reads it as a bill, correct that once.
