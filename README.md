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

## Configuration

The defaults are deliberately quiet, so configuration is optional. If a rule
fires on most of your sessions, it is describing how you work rather than
flagging something unusual—raise the threshold instead of learning to ignore it.

```bash
marmot config set session.costCap=50           # change one threshold
marmot config set 'limits.steps=[25,50,75]'    # values are JSON
marmot config set notify.bell=false mcp.autoAudit=false
```

Marmot prints what changed, creates the file from the defaults when needed, and
leaves every other setting alone:

```text
  /Users/you/.claude/marmot.json
    session.costCap: 25 → 50
```

This is the form to use from a script or coding agent. To edit or inspect the
whole file:

```bash
marmot config          # open it in your editor
marmot config --print  # print it in the terminal
```

Nothing needs restarting—the next run reads it. Marmot uses `$VISUAL`, then
`$EDITOR`, then the platform default. A terminal editor is used only when there
is a terminal to attach it to.

### What Claude Code says is eating your limits

Refreshing limits also captures Claude Code's own attribution of your usage:

```text
  What is driving your limits · last 7d
  Claude Code's own attribution, over 2,594 requests in 19 sessions.
     96%  of your usage was at >150k context
     80%  of your usage came from sessions active for 8+ hours
          top skills: claude-api 1%
          top mcp servers: sprinto 1%
```

This is not inferred from transcripts. `limit-drivers` quotes Claude Code's
attribution when a share passes `limits.driverMinPercent`—60% by default.

The source is human-formatted text with no stability guarantee. Every line is
optional; unrecognised lines are skipped, so a format change costs this section
rather than the whole report.

### Limit thresholds

`limit-reached` speaks at marks on the way to a limit, so you hear *half gone*
before *nearly out*. Each mark speaks once.

`limit-pace` compares the percentage used with the percentage of the window
that has passed. It warns only when the allowance is on course to run out before
it resets:

```text
  ▲ Spending your weekly allowance faster than it refills
    43% through the weekly window with 78% of it gone — 1.8× the pace that
    would last. At this rate it runs out in about 20.3h, 3.2d before it resets.
```

```jsonc
"limits": {
  "enabled": true,
  "steps": [50, 75, 90],
  "byPlan": {
    "Pro":        [50, 75, 90],
    "Max 5×":     [50, 75, 90],
    "Max 20×":    [50, 75, 90],
    "Team":       [50, 75, 90],
    "Enterprise": [50, 75, 90],
    "API":        []
  }
}
```

### The nudge thresholds

| Rule | Fires when | Default |
|---|---|---|
| `session-turns` | Prompts typed in one session, with no compaction | > 20 |
| `session-cost` | One session's modelled cost | > $25 |
| `daily-cost` | Today's total | > $50 |
| `daily-baseline` | Today against your trailing average | > 2.5σ over 14 days |
| `premium-light-work` | Premium-model share on a small session | > 70% and < 10 tool calls, or docs/tests only |
| `cache-hit` | Input tokens served from cache | < 70% over ≥ 20 turns |
| `tool-errors` | Failed tool calls | > 10% over ≥ 20 calls |
| `mcp-idle` | Configured servers never invoked | any |
| `session-topics` | A long session resumed in a different area | > 1 day gap, ≥ 2 areas |
| `premium-window` | Premium models repeatedly used on small sessions | ≥ 5 sessions |

### The keys people actually change

```jsonc
{
  // Rules allowed to interrupt at the end of a turn.
  "live": ["session-cost", "daily-cost", "daily-baseline",
           "session-turns", "limit-reached"],

  "notify": { "desktop": true, "bell": true, "app": null,
              "sound": "Ping", "persist": true },

  "digest": { "cadence": "daily" },

  "limits": { "enabled": true, "steps": [50, 75, 90],
              "autoRefresh": true, "paceRatio": 1.5,
              "paceMinElapsed": 15, "paceMinUsed": 20,
              "driverMinPercent": 60 },

  "browse": { "keep": 5 },
  "mcp": { "enabled": true, "autoAudit": true,
           "auditMaxAgeDays": 7 },

  "session": { "costCap": 25, "turnCap": 20, "costFloor": 1 },
  "daily": { "costCap": 50, "baselineSigma": 2.5,
             "baselineDays": 14 },

  // USD per million tokens for negotiated pricing.
  "rateOverrides": { "claude-opus-5": { "in": 5, "out": 25 } }
}
```

`marmot config` writes every key with its default; these are the ones most
people need.

Optional statusline:

```bash
marmot init --statusline
```

```text
$12.40 · 57 prompts · 41% ctx · 97% cache · Opus ▲
```

The statusline is separate because installing it replaces an existing Claude
Code statusline.

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
