# <img src="docs/marmot.svg" alt="" width="42" align="top"> Marmot

[![Status: alpha](https://img.shields.io/badge/status-alpha-orange)](https://github.com/DrDroidLab/marmot)
[![Discord](https://img.shields.io/badge/Discord-join%20us-5865F2?logo=discord&logoColor=white)](https://discord.gg/AQ3tusPtZn)

> **Alpha.** This is early software, and it reads a file format that is internal
> and undocumented — a Claude Code update can break a metric. `marmot doctor`
> shows what's still readable on your machine. Bugs and ideas are welcome, in
> [issues](https://github.com/DrDroidLab/marmot/issues) or on
> [Discord](https://discord.gg/AQ3tusPtZn).

**Your own Claude Code token consumption, read from the session records already on your machine.**

Claude Code writes every session to `~/.claude/projects/**.jsonl` as it runs. Marmot reads those files and tells you what your sessions cost, where the turns went, and when something is worth a second look.

```bash
npx @drdroidlab/marmot --demo      # synthetic data, to see the shape of it
npx @drdroidlab/marmot             # your own, last 30 days
```

Node 18+, zero dependencies, entirely local. Works on **Pro, Max and Team** plans.

```
  Marmot · your last 30 days
  40 sessions · everything below was read from ~/.claude/projects on this machine

  Spend              $4,184     modelled at published rates
  Sessions           40         18 active days
  Prompts you typed  926        per session: 23.1 mean · 16 median · 79 p99
  Model turns        13,823     14.9 per prompt
  Tokens             5.8B       input, output and cache
  Cache hit rate     98%        higher is cheaper
  Tool calls         13,768     3% failed
  Baseline context   35.3K      median, before you type — prompt, skills, tool definitions

  Daily              ▃▂▄▁▃█▆▃▂▁▄▁▂▆▁▅▄▅  peak $671 · median $233

  Where it went
  claude-opus-5      $4,092     98% · 5.7B tokens
  claude-sonnet-5    $92        2% · 104M tokens

  Skills
  dataviz            6×         ~4.1K tokens to load
  code-review        5×         ~1.8K tokens to load

  MCP servers called
  github             70×
  sentry             12×
```

**Baseline context** is the prefix carried into every request before you type anything — system prompt, skill descriptions and every attached tool definition. It is the number to look at when you wonder what an idle MCP server is costing you.

Spend is a **shadow price** — what these tokens would have cost at published API rates. On a subscription plan it is not an invoice line. Right for comparing your own sessions to each other, wrong for finance.

---

## Install

**As a CLI**

```bash
npx @drdroidlab/marmot            # no install
npm i -g @drdroidlab/marmot       # or keep it
```

**As a Claude Code plugin** — the same numbers, without leaving Claude Code.

```
/plugin marketplace add DrDroidLab/marmot
/plugin install marmot@marmot
```

Then **restart Claude Code** — hooks and commands only load at session start. You get:

- `/marmot:usage` — the report, every session, and the nudges.
- `/marmot:config` — open your thresholds file.
- **A daily digest** on your first session each day: what yesterday cost, and what it flagged.
- **Live nudges** at the end of a turn, for the rules in `live` only — once per session per rule, and again at each doubling for cost. Each one rings the bell and raises a desktop notification.

Check it loaded — the status line, not the component count:

```bash
claude plugin list | grep -A4 'marmot@'    # Status: ✔ enabled
```

**The statusline** — plugins can't ship one, so it's a separate opt-in.

```bash
npx @drdroidlab/marmot init --statusline
```

```
$12.40 · 57 prompts · 41% ctx · 97% cache · Opus ▲
```

The `▲` appears once you're past your own caps.

## Usage

| Command | Slash command | What it does |
|---|---|---|
| `marmot` | `/marmot:usage` | The report — spend, trends, every session, nudges |
| `marmot config` | `/marmot:config` | Open the thresholds file |
| `marmot browse` | | Build the session browser page and open it |
| `marmot nudges` | | Only what's worth knowing |
| `marmot sessions` | | One line per session |
| `marmot mcp-audit` | | Measure what each MCP server's tool definitions cost |
| `marmot doctor` | | What's readable on this machine, and what isn't |
| `marmot init` | | Write the thresholds file |

`/marmot:usage` is the one command to reach for: it prints the report with every
session listed, and `--browse` opens the full page from there.

| Flag | |
|---|---|
| `--days N` | Window, default 30 |
| `--sessions` | Add the per-session list to the report |
| `--browse` | Also build and open the session browser page |
| `--demo` | Synthetic data, safe for screenshots |
| `--json` | Machine-readable |
| `--root DIR` | Claude Code home, default `~/.claude` |
| `--session ID` | `browse`: just this one |
| `--limit N` | `browse`: most recent N, default 25 |
| `--no-text` | `browse`: counts and tool names only, no prompts |
| `--no-audit` | Skip measuring MCP servers this run |

### The session browser

One self-contained HTML file, written locally and opened in your browser — no CDN, no network, no web fonts.

It opens on **the same figures as the report** — spend, tokens, cache, baseline context, the model split, skills, MCP servers and every nudge — because they are computed once in Node and shipped with the page rather than recalculated in the browser. From there each session opens onto its full timeline: every prompt, reply and tool call, with a cost-per-turn chart, the token split, a text filter and an errors-only toggle.

![The session browser](docs/browse-index.png)

![A single session](docs/browse-session.png)

### What your MCP servers cost

Every attached server's tool definitions are sent with **every** request, and
nothing on disk records how big they are. So this asks the servers directly:

```bash
npx @drdroidlab/marmot mcp-audit
```

```
  Server                   Tools    Tokens    Calls (30d)
  github                      26     ~4.1K            142
  kubernetes                  28     ~5.2K             18
  sentry                      14     ~2.3K              0  ▲
  datadog                     22     ~3.6K              0  ▲

  15,200 tokens of tool definitions ride on every request.
  ~5,900 of them (39%) belong to 2 servers you have not called in 30 days:
  sentry, datadog
```

The report runs this for you when it has no recent figures, showing progress as
it goes, and caches the result in `~/.claude/marmot-mcp.json` for a week. It is
the only thing Marmot does that **starts your servers** rather than reading a
file — set `mcp.autoAudit` to `false` to only ever measure on demand, or pass
`--no-audit` for one run. `--tools` breaks it down per tool.

## Configuration

Everything runs on defaults, so this is optional. When you do want to move a
threshold:

```bash
marmot config          # opens ~/.claude/marmot.json, creating it if you have none
marmot config --print  # ...and print it to the terminal
```

or `/marmot:config` inside Claude Code. Nothing needs restarting — the next run
reads it.

It opens in a real text editor, not a preview: `$VISUAL`/`$EDITOR` if you have
one set, otherwise your default text editor on macOS, Notepad on Windows,
`xdg-open` on Linux. A terminal editor like vim is only used when there is a
terminal to attach it to, so `/marmot:config` inside Claude Code opens a window
instead of hanging.

### The nudge thresholds

| Rule | Fires when | Default |
|---|---|---|
| `session-turns` | Prompts you typed in one session, **and it never compacted** | > 20 |
| `session-cost` | One session's modelled cost | > $25 |
| `daily-cost` | Today's total | > $50 |
| `daily-baseline` | Today against **your own** trailing average | > 2.5σ over 14 days |
| `premium-light-work` | Premium-model share on a session that stayed small | > 70% and < 10 tool calls, or docs/tests only |
| `cache-hit` | Input tokens served from cache | < 70% over ≥ 20 turns |
| `tool-errors` | Failed tool calls | > 10% over ≥ 20 calls |
| `mcp-idle` | Servers configured and never invoked | any |
| `session-topics` | A long session resumed after a gap, in a different area | > 1 day gap, ≥ 2 areas |
| `premium-window` | A habit of premium models on small sessions | ≥ 5 sessions |

If a rule fires on nearly every session, **raise its cap rather than removing
it**. Every rule carries three guards — a ratio gap, a minimum sample and a
dollar floor — because a nudge that always fires gets muted, and then none of
them work.

### The keys people actually change

```jsonc
{
  // Which rules may interrupt you mid-session. Everything else waits
  // for the daily digest.
  "live": ["session-cost", "daily-cost", "daily-baseline", "session-turns"],

  // How a nudge reaches you, beyond the line in the transcript.
  "notify": { "desktop": true, "bell": true },

  // "off" stops the daily digest entirely.
  "digest": { "cadence": "daily" },

  // The report measures your MCP servers when it has nothing recent.
  // autoAudit false means it only ever measures when you ask it to.
  "mcp": { "enabled": true, "autoAudit": true, "auditMaxAgeDays": 7 },

  "session": { "costCap": 25, "turnCap": 20, "costFloor": 1 },
  "daily":   { "costCap": 50, "baselineSigma": 2.5, "baselineDays": 14 },

  // Set these if you are on negotiated rates and want the modelled
  // cost to match your contract. USD per million tokens.
  "rateOverrides": { "claude-opus-5": { "in": 5, "out": 25 } }
}
```

`marmot config` writes every key with its default, commented by the table
above — these are just the ones worth knowing about.

**Turning the alerts down.** `notify.bell` rings the terminal bell,
`notify.desktop` raises a system notification. Set either to `false`.
`MARMOT_NO_NOTIFY=1` silences both for one run, and CI is silent automatically.

**Measuring MCP servers less often.** Raise `mcp.auditMaxAgeDays`, or set
`mcp.autoAudit` to `false` and run `marmot mcp-audit` when it suits you.

**Starting the nudges over.** `~/.claude/marmot-state.json` records what has
already been said. Delete it to hear everything again.

## How the numbers are counted

The transcript format is internal and undocumented, and two details in it are easy to read wrong:

- **Cache writes are priced at their actual TTL** — 2× at one hour, 1.25× at five minutes. Claude Code writes 1h entries, so pricing every write at 1.25× understates a heavy session by about a fifth.
- **Usage is counted once per API response.** Claude Code writes one JSONL entry per content block, and every one repeats the same `usage` object. Summing per entry inflates cost and turns by roughly **1.9× on a tool-heavy session**. Marmot dedupes by `message.id`.

And a "turn" means **a prompt you typed**. Tool results arrive as user entries too, so counting every user entry reads a 57-prompt session as 1,191.

## Privacy

Everything runs locally. Nothing is uploaded, and there's no service to upload it to — no account, no API key, no server.

The **report** reads only counts, identifiers and tool names, never your prompt or response text. The **browser page** does read them, because that's the point of it; it's a local file that inherits the sensitivity of the transcript it came from, and `marmot browse --no-text` leaves the text out if you want to share it.

Tool *results* are never stored. They're around 95% of the bytes on disk — 40MB of one 42MB transcript — and dropping them is what turns a 41MB transcript into a 1MB page.

## Scope

Marmot covers one developer on one machine, and stays small on purpose.

- **One machine.** A team needs a collector, or Claude Code's OpenTelemetry exporter.
- **Claude Code only.** Cursor stores per-message token counts but no model identity or cost, so it can't be priced. Copilot's local chat sessions carry no tokens, model or cost at all.
- **Lines added and removed** need the diff or git history; the transcript names paths only.
- **Agent-active versus your own time** isn't in these files. OTel has the split.

## Development

```bash
npm test        # 233 tests, no dependencies, ~6s
```

## License

MIT
