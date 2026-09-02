<p align="center">
  <img src="docs/marmot-hero.png" alt="Marmot — Catch token waste while you can still act" width="100%">
</p>

<p align="center"><strong>A local Claude Code usage tool that tells you what is wasting tokens—and what to do next.</strong></p>

<p align="center">
  <a href="https://github.com/DrDroidLab/marmot"><img src="https://img.shields.io/badge/status-alpha-E79545" alt="Status: alpha"></a>
  <a href="https://github.com/DrDroidLab/marmot/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-5E8C6A" alt="License: MIT"></a>
  <a href="https://discord.gg/AQ3tusPtZn"><img src="https://img.shields.io/badge/Discord-join_the_den-5865F2?logo=discord&logoColor=white" alt="Join the Discord"></a>
</p>

Marmot reads Claude Code's local session records, shows where the tokens went,
and nudges you while changing course can still save the next turn.

## Install

Requires Node.js 18 or newer.

```bash
npm install -g github:DrDroidLab/marmot
marmot init --hooks
```

Restart Claude Code, then verify it:

```bash
marmot doctor
```

Want to look first? `marmot --demo` uses synthetic data and reads none of your
sessions.

## What a nudge looks like

<p align="center">
  <img src="docs/nudge-context.png" alt="Marmot notification recommending compacting or starting a new session because each turn is re-sending 140K tokens of history" width="720">
</p>

The desktop notification stays short. Claude Code gets the evidence and the
next action in its transcript. Marmot speaks once per rule instead of repeating
the same warning after every turn.

## See where the tokens went

```bash
marmot browse
```

![Marmot's local session browser showing usage, model, skill and MCP trends](docs/browse-index.png)

Open a session to see its token split, cost per turn, prompts, replies and tool
calls. Tool-result bodies are never included.

<details>
<summary><strong>See a session timeline</strong></summary>

![A single Claude Code session with its cost-per-turn chart and event timeline](docs/browse-session.png)

</details>

The browser is one local HTML file with no CDN, analytics, web fonts or network
calls.

## Commands

```bash
marmot                    # report for the last 30 days
marmot --days 7           # choose a window
marmot browse             # open the local session browser
marmot nudges             # show only actionable findings
marmot sessions           # list sessions one per line
marmot mcp-audit          # measure MCP tool-definition weight
marmot config             # open your thresholds
marmot doctor             # check readers, hooks and notifications
marmot test-notification  # send a test nudge
```

Useful options:

```bash
marmot --sessions         # include every session in the report
marmot --json             # machine-readable output
marmot --no-audit         # do not start MCP servers for measurement
marmot --no-refresh       # do not refresh plan-limit data
marmot browse --no-text   # exclude prompts and replies from the page
```

Run `marmot --help` for the complete reference.

## What Marmot catches

| Signal | What it means |
|---|---|
| Long session | Old turns keep travelling into new ones |
| Stale session | Work resumes days later in a different area |
| Idle MCP server | Tool definitions are loaded but never used |
| Premium model on light work | A costly model handles a small task |
| Low cache hit rate | Context is rebuilt instead of reused |
| Tool failures | Calls fail and then need another turn to recover |
| Usage spike | Today is far beyond your own normal |
| Limit pace | Your allowance is disappearing faster than its window |

Every check is deterministic. No model decides whether to nudge you.

## Configure it

```bash
marmot config set session.turnCap=30
marmot config set cache.minHitRate=0.8
marmot config set notify.bell=false
marmot config set 'limits.steps=[25,50,75,90]'
```

Changes apply on the next run. To inspect the full file:

```bash
marmot config --print
```

Optional statusline:

```bash
marmot init --statusline
```

```text
$12.40 · 57 prompts · 41% ctx · 97% cache · Opus ▲
```

This replaces an existing Claude Code statusline, so it is separate from hook
installation.

## Good to know

- **Local by design.** Marmot has no account or hosted service.
- **The report avoids conversation text.** It reads counts, identifiers and
  tool names.
- **The browser includes prompts and replies.** Use `browse --no-text` to leave
  them out. The generated page stays local either way.
- **MCP audit starts configured servers.** Use `--no-audit` or set
  `mcp.autoAudit=false` if you do not want that.
- **Subscription dollars are estimates.** `Modelled spend` is the API-rate value,
  not your invoice; the plan-limit percentage is the useful ceiling.
- **Marmot is alpha.** Claude Code's session format is internal and can change.
  `marmot doctor` shows what remains readable.

## Notifications not appearing?

```bash
marmot test-notification
```

If the test does not appear, check Focus or Do Not Disturb first. Then run
`marmot doctor` to see which notification path Marmot is using.

Keep transcript nudges while disabling desktop notifications or sound:

```bash
marmot config set notify.desktop=false
marmot config set notify.bell=false
```

## Update or remove

```bash
npm install -g github:DrDroidLab/marmot  # update
marmot init --hooks --remove             # remove Marmot hooks
```

## Contributing

```bash
npm test
```

Please work on a branch and open a pull request. `main` moves through reviewed
pull requests only.

## License

[MIT](LICENSE)
