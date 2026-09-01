# Marmot

**Your own Claude Code token consumption — read from the session records already on your machine.**

No account. No API key. No server. Nothing is uploaded.

A marmot sits on its own patch of ground and whistles when something's off. That's the whole product: it watches your sessions, locally, and tells you when a number is worth a look.

```bash
npx @drdroidlab/marmot --demo      # see it on synthetic data first
npx @drdroidlab/marmot             # then on your own
```

Works on **Pro, Max and Team** plans — where none of the organisation APIs exist.

![The session browser](docs/browse-index.png)

---

## Why this exists

Every dashboard for AI coding spend is built for someone managing a team. If you just want to see your own habits, the options are an enterprise API you can't get a key for, or nothing.

But Claude Code already writes everything you'd need, to your own disk. Each session appends to `~/.claude/projects/<slug>/<session-id>.jsonl` as it runs, and that file carries **more than the Compliance API returns to an Enterprise org**: exact per-turn token counts by type, the model, git branch, working directory, tool calls and errors, skills, MCP invocations, permission mode, and the files that changed.

Marmot reads those files. That's it. It never reads prompt or response text for the report — only counts, identifiers and tool names.

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

Every rule carries three guards — a **ratio gap**, a **minimum sample** and a **dollar floor**. Without all three the same checks fire on nearly every session and the whole thing gets muted inside a week.

### A session browser

```bash
npx @drdroidlab/marmot browse
```

One self-contained HTML file, written locally and opened in your browser. No CDN, no network, no fonts — it works offline. Stat tiles, a clickable cost-per-turn timeline, the token split, tool/skill/MCP breakdowns, and the full chronological timeline of every prompt, reply and tool call with a text filter and an errors-only toggle.

![A single session](docs/browse-session.png)

## Install

### As a CLI

```bash
npx @drdroidlab/marmot            # no install
npm i -g @drdroidlab/marmot       # or keep it
```

### As a Claude Code plugin

Adds `/usage` and `/sessions`, plus the nudges where you already are.

```
/plugin marketplace add DrDroidLab/marmot
/plugin install marmot@marmot
```

Then **restart Claude Code** — hooks and commands load at session start.

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
marmot report --json        # everything, machine-readable
```

## About the dollar figures

**Cost is a shadow price.** On a subscription plan it is what these tokens *would have* cost at published API rates — not an invoice line, not a bill, not something to take to finance. It is the right number for comparing your own sessions to each other, and only that.

Two things Marmot gets right that a naive reading of these files does not:

- **Cache writes are priced at their actual TTL** — 2× at one hour, 1.25× at five minutes. Claude Code writes 1h entries, so treating every write as 1.25× understates a heavy session by around a fifth. The transcripts break this out; Marmot reads it.
- **Usage is counted once per API response.** Claude Code writes one JSONL entry per content block — a thinking block, the text, then each tool call — and every one of those entries repeats the same `usage` object. Summing per entry inflates cost and turn counts by roughly **1.9× on a tool-heavy session**. Marmot dedupes by `message.id`.

A "turn" means **a prompt you typed**. Tool results come back as user entries in the transcript too, so counting every user entry inflates a 57-prompt session to 1,191.

## Privacy

Everything runs on your machine and nothing is uploaded — there is no server to upload to.

The **report** never reads prompt or response text. The **browser page** does, because that's the point of it; it is a local file, and it inherits the sensitivity of the transcript it came from. `marmot browse --no-text` leaves the text out entirely if you want to share the page.

Tool *results* are never stored anywhere by Marmot. In a real session they're around 95% of the bytes on disk — 40MB of one 42MB transcript — and dropping them is what turns a 41MB transcript into a 1MB page.

## Limits

- **One machine.** A team needs a collector, or Claude Code's OpenTelemetry exporter.
- **Claude Code only.** Cursor stores per-message token counts locally but no model identity or cost, so it can't be priced. Copilot's local chat sessions carry no tokens, model or cost at all.
- **Lines added and removed** need the diff or git history; the transcript names paths only.
- **Agent-active versus your own time** isn't in these files. OTel has the split.
- The transcript format is **internal and undocumented**. Every field access here is defensive: a renamed field should cost you a metric, not the report.

## Requirements

Node 18+. No dependencies.

## License

MIT
