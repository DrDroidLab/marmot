---
name: sessions
description: Build a local web page of your past Claude Code sessions — turns, prompts, tool calls, skills and MCP servers laid out in full — and open it in your browser.
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/marmot.mjs" browse $ARGUMENTS`

Marmot has written a self-contained HTML page and opened it in the browser.
Tell the user where it was written and how many sessions it covers — that is all
they need. Do not describe the page's contents; they are looking at it.

The page is a local file. Nothing was uploaded, and it should not be attached to
a ticket or pasted into a chat without thinking: unless it was built with
`--no-text`, it contains the raw prompts and replies from those sessions.

If the command failed, the likely causes are no sessions in the window (suggest a
larger `--days`) or a non-standard Claude Code home (suggest `--root`).
