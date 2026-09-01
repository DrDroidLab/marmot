# Marmot

[![Status: alpha](https://img.shields.io/badge/status-alpha-orange)](https://github.com/DrDroidLab/marmot)
[![Discord](https://img.shields.io/badge/Discord-join%20us-5865F2?logo=discord&logoColor=white)](https://discord.gg/AQ3tusPtZn)

> **Alpha.** This is early software, and it reads a file format that is internal
> and undocumented — a Claude Code update can break a metric. `marmot doctor`
> shows what's still readable on your machine. Bugs and ideas are welcome, in
> [issues](https://github.com/DrDroidLab/marmot/issues) or on
> [Discord](https://discord.gg/AQ3tusPtZn).

**Your own Claude Code token consumption, read from the session records already on your machine.**

Claude Code writes every session to `~/.claude/projects/<slug>/<session-id>.jsonl` as it runs. Marmot reads those files and tells you what your sessions cost, where the turns went, and when something is worth a second look.

It's one command, zero dependencies, and it runs entirely on your own machine.

```bash
npx @drdroidlab/marmot --demo      # synthetic data, to see the shape of it
npx @drdroidlab/marmot             # your own, last 30 days
```

Works on **Pro, Max and Team** plans.

A marmot sits on its own patch of ground and whistles when something's off. That's the whole product.

![The session browser](docs/browse-index.png)

---

## What it reads

Everything Marmot needs is already on your disk. Each transcript carries per-turn token counts by type, the model, git branch, working directory, tool calls and errors, skills, MCP invocations, permission mode, and the files that changed.

That's the entire input. The report is built from counts, identifiers and tool names — it never reads your prompt or response text.

## What you get

### A report

```
  Marmot · your last 30 days
  40 sessions · everything below was read from ~/.claude/projects on this machine

  Spend              $4,184     modelled at published rates
  Sessions           40         18 active days
  Prompts you typed  926        23.1 per session
  Model turns        13,823     14.9 per prompt
  Tokens             5.8B       input, output and cache
  Cache hit rate     98%        higher is cheaper
  Tool calls         13,768     3% failed

  Daily              ▃▂▄▁▃█▆▃▂▁▄▁▂▆▁▅▄▅  peak $671 · median $233
```

That spend figure is a **shadow price** — what these tokens would have cost at published API rates. On a subscription plan it is not an invoice line. It's the right number for comparing your own sessions to each other, and only that.

### Nudges, on deterministic rules

No model decides whether to nudge you. Thresholds live in `~/.claude/marmot.json`.

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

Every rule carries three guards — a **ratio gap**, a **minimum sample** and a **dollar floor**. Tuned that way, they stay quiet on an ordinary day, which is the only way they stay useful.

### A session browser

```bash
npx @drdroidlab/marmot browse
```

One self-contained HTML file, written locally and opened in your browser. No CDN, no network, no web fonts — it works offline. Stat tiles, a clickable cost-per-turn timeline, the token split, tool/skill/MCP breakdowns, and the full chronological timeline of every prompt, reply and tool call, with a text filter and an errors-only toggle.

![A single session](docs/browse-session.png)

## Install

### As a CLI

```bash
npx @drdroidlab/marmot            # no install
npm i -g @drdroidlab/marmot       # or keep it
```

### As a Claude Code plugin

Adds `/marmot:usage`, `/marmot:sessions` and `/marmot:config`, plus the nudges where you already are.

```
/plugin marketplace add DrDroidLab/marmot
/plugin install marmot@marmot
```

Then **restart Claude Code** — hooks and commands load at session start.

- **`/marmot:config`** — opens `~/.claude/marmot.json`, creating it with the defaults if you haven't got one, so you can move a cap without leaving Claude Code.
- **Daily digest** — on your first session each day, what yesterday cost and what it flagged.
- **Live nudges** — at the end of an assistant turn, only for the rules in `live`, once per session per rule. Cost rules speak again at each doubling. Everything else waits for the digest.

### The statusline

Plugins can't ship a statusline, so it's a separate opt-in:

```bash
npx @drdroidlab/marmot init --statusline
```

```
$12.40 · 57 prompts · 41% ctx · 97% cache · Opus ▲
```

The `▲` appears once you're past your own caps.

## Commands

```bash
marmot                      # the report, last 30 days
marmot --days 7
marmot --demo               # synthetic data, to see the shape of it
marmot nudges               # only what's worth knowing
marmot sessions             # one line per session
marmot browse               # the web page
marmot browse --session 6d16e4fb
marmot browse --no-text     # counts and tool names only, no prompts
marmot doctor               # what's readable here, and what isn't
marmot init                 # write the threshold file
marmot config               # open the threshold file to edit
marmot report --json        # everything, machine-readable
```

## How the numbers are counted

The transcript format is internal and undocumented, and two details in it are easy to read wrong:

- **Cache writes are priced at their actual TTL** — 2× at one hour, 1.25× at five minutes. Claude Code writes 1h entries, so pricing every write at 1.25× understates a heavy session by about a fifth. The transcripts break this out, and Marmot reads it.
- **Usage is counted once per API response.** Claude Code writes one JSONL entry per content block — a thinking block, the text, then each tool call — and every one of those entries repeats the same `usage` object. Summing per entry inflates cost and turn counts by roughly **1.9× on a tool-heavy session**. Marmot dedupes by `message.id`.

And a "turn" means **a prompt you typed**. Tool results arrive as user entries too, so counting every user entry reads a 57-prompt session as 1,191.

## Privacy

Everything runs locally. Nothing is uploaded, and there's no service to upload it to — no account, no API key, no server.

The **report** never reads prompt or response text. The **browser page** does, because that's the point of it; it's a local file, and it inherits the sensitivity of the transcript it came from. `marmot browse --no-text` leaves the text out if you want to share the page.

Tool *results* are never stored. In a real session they're around 95% of the bytes on disk — 40MB of one 42MB transcript — and dropping them is what turns a 41MB transcript into a 1MB page.

## Scope

Marmot covers one developer on one machine, and stays small on purpose.

- **One machine.** A team needs a collector, or Claude Code's OpenTelemetry exporter.
- **Claude Code only.** Cursor stores per-message token counts locally but no model identity or cost, so it can't be priced. Copilot's local chat sessions carry no tokens, model or cost at all.
- **Lines added and removed** need the diff or git history; the transcript names paths only.
- **Agent-active versus your own time** isn't in these files. OTel has the split.
- The transcript format is internal, so every field access is defensive: a renamed field costs you a metric, not the report. `marmot doctor` shows what's readable here.

## Development

```bash
npm test        # 157 tests, no dependencies, ~2s
```

## Requirements

Node 18+. No dependencies.

## License

MIT
