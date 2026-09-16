<p align="center">
  <img src="docs/marmot-hero.png" alt="Marmot — Catch token waste while you can still act" width="100%">
</p>

<p align="center"><strong>A Mac menu bar app that shows your Claude limits and spend—and tells you what is wasting tokens, and what to do next.</strong></p>

<p align="center">
  <a href="https://github.com/DrDroidLab/marmot"><img src="https://img.shields.io/badge/status-alpha-E79545" alt="Status: alpha"></a>
  <a href="https://github.com/DrDroidLab/marmot/releases"><img src="https://img.shields.io/badge/macOS-14%2B-5E8C6A" alt="macOS 14 or newer"></a>
  <a href="https://github.com/DrDroidLab/marmot/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-5E8C6A" alt="License: MIT"></a>
  <a href="https://discord.gg/AQ3tusPtZn"><img src="https://img.shields.io/badge/Discord-join_the_den-5865F2?logo=discord&logoColor=white" alt="Join the Discord"></a>
</p>

Marmot reads the session records Claude Code already keeps on your Mac and
points out where tokens are being wasted: context that has outlived the task,
MCP tools that are loaded but never called, poor cache reuse, repeated tool
failures, or a costly model doing light work.

The useful part is timing. Marmot can nudge you at the end of a turn, while
starting fresh, compacting, or changing course can still save the next one.
No account, no server: everything stays on your Mac.

<p align="center">
  <img src="docs/app/menu.png" alt="The Marmot menu with numbered callouts: 1 the Cost and Tokens toggle, 2 Expand, 3 See all recommendations, 4 View session data, 5 Settings" width="380">
</p>

Click the marmot in your menu bar to open this menu. From there:

| | Click | What it opens |
|---|---|---|
| **1** | **Cost / Tokens** | Switches the 14-day chart between dollars and tokens |
| **2** | **Expand** ↗ | The [usage window](#expand-for-the-long-view): 7, 30 or 90 days, by model |
| **3** | **See all ›** | The [recommendations](#recommendations-not-just-numbers), in full |
| **4** | **View session data** | [Every session](#see-every-session) in your web browser |
| **5** | **Settings…** | [When to notify you](#tell-it-when-to-speak) and [what the menu bar shows](#make-the-menu-bar-yours) |

## Install

```bash
brew install --cask drdroidlab/tap/marmot
```

macOS 14 or newer, on Apple Silicon or Intel. Everything Marmot needs ships
inside the app, which is why it is about 240 MB (a 78 MB download). Prefer a
download? Take the `.dmg` from
[Releases](https://github.com/DrDroidLab/marmot/releases), drag Marmot to
Applications, and on first open use System Settings → Privacy & Security →
**Open Anyway**.

**One step after installing:** open the menu, then **Settings… → Advanced →
Install hooks**, and restart Claude Code. The app watches your limits on its
own, but the nudges that come from inside Claude Code — a long session, a cost
cap — need its hooks, and Homebrew does not install them for you.

Out of the box, you will hear about:

- **Claude's own limits** — the 5-hour session window and the week — at 50%,
  75% and 90%, on Pro, Max and Team.
- **A long session**, at 10, 15 and 20 prompts you typed, on every plan.
- **Dollar caps**, on Enterprise and pay-as-you-go API only, where the spend is
  real.

Every one of these is yours to change in **Settings… → Notifications**.

## The menu bar app

One click from the clock: the limits Claude actually enforces, what today and
the last 30 days cost, and what to do about it.

### Your limits, in colour

<p align="center">
  <img src="docs/app/limits.png" alt="The limits at the top of the menu: a green 5-hour session bar at 34% and a yellow weekly bar at 61%, with a lightning mark and reset times" width="480">
</p>

The 5-hour session window and the week, at the top of the menu, each with when
it resets:

| You see | It means |
|---|---|
| Green bar | Below 50% of that window |
| Yellow bar | 50% or more |
| Red bar | 75% or more |
| ⚡ next to a limit | You are spending it faster than it refills — at this pace it runs out before it resets |
| **just reset** | The window rolled over since the last reading; it shows 0% until the next one arrives |
| **updated 12m ago** | How old the limit reading is. **Refresh** (⌘R) asks Claude Code for a new one, at no token cost |

Limits cover every Claude product on your plan — Claude Code, Cowork and chat —
because Anthropic counts them together.

### Cost and tokens, by your local day

Today and the window total, then a 14-day chart you can switch between dollars
and tokens with **1 · Cost / Tokens**. Hover a bar for that day's models.

On Pro, Max and Team the dollar figure is **modelled**: what those tokens would
cost at published API rates, not what you pay. It is right for comparing your
own days and sessions, and wrong for finance. On pay-as-you-go API it is the
bill.

### Expand for the long view

Open it with **2 · Expand** in the menu.

<p align="center">
  <img src="docs/app/usage-window.png" alt="The expanded usage window: 7, 30 and 90-day ranges, a bar chart stacked by model, totals, and a table of models" width="760">
</p>

7, 30 or 90 days, stacked by model, with totals, your peak day, and a per-model
table. Cost or tokens, the same toggle. Hover a bar for that day's breakdown.

### Recommendations, not just numbers

Open it with **3 · See all ›** in the menu, or the **Recommendations** tab in
the usage window.

<p align="center">
  <img src="docs/app/recommendations.png" alt="The Recommendations tab, listing what is costing tokens, what to do, and where each finding came from" width="760">
</p>

The menu shows the two that matter — click one to see what to do — and this
tab shows them all: what is happening, what to do, and where the finding came
from.

| Dot | Source |
|---|---|
| Orange (red when urgent) | A threshold you set was crossed — a limit mark, a long session |
| Blue | Advice: measured by Marmot from your session files, or quoted from Claude Code's own `/usage` report |

### See every session

Open it with **4 · View session data** in the menu.

<p align="center">
  <img src="docs/app/session-browser.png" alt="The session browser: spend, tokens, cache hit rate and baseline context, how you worked, and the findings worth acting on" width="760">
</p>

A page in your browser with every session in the window: what it cost, how you
worked, what is worth acting on, and each session turn by turn, so you can
follow a number down to the prompt that caused it. It is one local file with no
network calls. It includes your prompts and Claude's replies, so treat it like
the transcript it came from.

### Tell it when to speak

Open it with **5 · Settings… → Notifications**.

<p align="center">
  <img src="docs/app/settings-notifications.png" alt="Settings: separate percentage lists for the 5-hour session limit and the weekly limit, each with marks you can add or remove" width="640">
</p>

Separate lists of marks for the 5-hour window and the week. Type a number and
press **Add**, or click **×** on a mark to remove it. The bar underneath shows
where you are now, with a tick at each mark. **Reset to plan default** puts back
50%, 75% and 90%. The same tab sets long-session marks, the daily digest, how
nudges look and sound, and has buttons to send a test.

While the app is running, it delivers nudges itself — including the ones from
inside Claude Code — and it checks your limits between turns, so a limit mark
reaches you even when you are not at the keyboard.

### Make the menu bar yours

Open it with **5 · Settings… → General**.

<p align="center">
  <img src="docs/app/general-settings.png" alt="Settings, General tab: launch at login, what the menu bar shows, which limit, how often limits refresh, and the totals window" width="560">
</p>

| Setting | Choices |
|---|---|
| **Menu bar shows** | Limit % · Today's cost · Limit % and cost · Icon only |
| **Which limit** | 5-hour session and weekly (`5h 34% · W 61%`) · 5-hour session · Weekly · Whichever is highest |
| **Refresh limits every** | 5, 15 or 30 minutes, or manually |
| **Totals window** | 7 or 30 days, for the cost and token figures |
| **Launch at login** | Start Marmot with your Mac |

### Settings at a glance

| Tab | What lives there |
|---|---|
| **General** | The menu bar display, limit refresh, totals window, launch at login |
| **Notifications** | How nudges look and sound, the percentage marks for each window, long-session marks, the daily digest, test buttons, recent notifications |
| **Advanced limits** | Limit nudges on or off, the pace warning, what counts as an unusual day |
| **Advanced** | Install or remove Claude Code's hooks, demo data for screenshots, MCP measuring, the hook log, open the settings file, run the doctor |

In the menu, **⌘R** refreshes, **⌘,** opens Settings and **⌘Q** quits.

## What a nudge looks like

<p align="center">
  <img src="docs/nudge-context.png" alt="Marmot notification recommending compacting or starting a new session because each turn is re-sending 140K tokens of history" width="720">
</p>

A nudge says what happened, what it cost, and what to do instead. Claude Code
also gets the evidence and the next action in its transcript. Marmot speaks
once per rule instead of repeating the same warning after every turn.

Choose how it arrives in **Settings… → Notifications → Nudge style** (and
**Daily digest style** for the once-a-day summary):

| Style | What you get |
|---|---|
| **Stays until dismissed** | Has room for what to do as well as what it cost, and waits for you. **The default.** A banner you were not looking at is a banner you missed. |
| **Stays only near a limit** | Waits for you only at the last mark, or when a window is burning faster than it refills. A banner otherwise. |
| **Banner** | The ordinary macOS notification, which fades on its own. |

## What Marmot catches

| Signal | What it means |
|---|---|
| Long session | 10, 15 and 20 prompts in one session, on any plan: old turns keep travelling into new ones |
| Stale session | Work resumes days later in a different area |
| Idle MCP server | Tool definitions are loaded but never used |
| Premium model on light work | A costly model handles a small task |
| Low cache hit rate | Context is rebuilt instead of reused |
| Tool failures | Calls fail and then need another turn to recover |
| Usage spike | Today is far beyond your own normal |
| Limit pace | Your allowance is disappearing faster than its window |

Every check is deterministic. No model decides whether to nudge you.

Most of those are **causes rather than alarms**. What interrupts you is a
threshold—half, three quarters, then nine tenths of a plan window, or a session
reaching 10, 15 and 20 prompts—and a limit nudge carries whichever cause best
explains getting there:

```text
▲ 75% of your weekly limit
  76% of your weekly limit is gone on Max 20×. It resets in 2.1d.
  Each turn re-sends 603K tokens of history, over 57 prompts and 3.8d.
  Run /compact, or start a new session for the next distinct piece of work.
```

Causes are ranked by how much each explains, how confident Marmot is, and how
cheaply it can be fixed. When nothing scores highly enough, the threshold still
fires without an invented reason. The full ranking is the
[Recommendations](#recommendations-not-just-numbers) tab.

## When Marmot speaks

Some nudges can interrupt at the end of a turn—the moment you can still change
the session in front of you. Everything else waits for the daily digest.

A rule speaks once per session. Limit and long-session warnings return at each
mark; cost warnings, on Enterprise and API, return when the cost doubles. When
several apply at once, the one that can run out goes first: a limit, then
money, then session length. One nudge also buys 20 minutes of quiet before
another can interrupt (**Settings… → Notifications → Quiet time between
nudges**); anything held back stays in Recommendations and the digest.

### Your plan decides what interrupts you

Claude enforces two kinds of window on a subscription: a rolling **5-hour
session** and a **week** (plus a weekly limit on some models). There is no
daily limit.

| Plan | What interrupts you |
|---|---|
| **Pro, Max, Team** | Claude's limits, at the marks you set for each window. Never a dollar cap: the plan is paid for, so allowance is what runs out. |
| **Enterprise** | Daily and session dollar caps, plus limits if the plan reports them |
| **Pay-as-you-go API** | Dollar caps, because the figure is the bill |

A subscription whose limit reading is missing or stale does not fall back to
dollars. Marmot asks Claude Code for a fresh reading in the background, at no
token cost, and judges against that.

**Long sessions** are the same on every plan: a nudge at 10, 15 and 20 prompts
you typed, each once per session. Compacting does not reset the count, because
it trims what a session carries without making it a new one. Only prompts you
typed count—tool results and model turns do not.

### Limit pace

The ⚡ in the menu, and the nudge behind it, compare how much of a window is
used with how much of it has passed. It warns only when the allowance is on
course to run out before it resets:

```text
▲ Spending your weekly allowance faster than it refills
  43% through the weekly window with 78% of it gone — 1.8× the pace that
  would last. At this rate it runs out in about 20.3h, 3.2d before it resets.
```

### What Claude Code says is eating your limits

Refreshing your limits also captures Claude Code's own account of what is
driving them — for example, "80% of your usage came from sessions active for 8+
hours". Marmot does not infer these: they are Claude Code's figures, shown as
blue recommendations, and when one explains enough of the burn it becomes the
middle sentence of a limit nudge.

### Every nudge, and where to change it

| Nudge | Fires when | Default | Change it in |
|---|---|---|---|
| Limit mark | A 5-hour or weekly window crosses one of your marks | 50%, 75%, 90% | Settings → Notifications → **5-hour session limit** / **Weekly limit** |
| Limit runs out | A window reaches 100% | on | Settings → Notifications → **When a limit runs out** |
| Limit pace | Allowance is disappearing faster than the window | > 1.5× pace, ≥ 15% elapsed, ≥ 20% used | Settings → Notifications (on/off), Settings → Advanced limits (thresholds) |
| Long session | Prompts you typed in one session — any plan | 10, 15, 20 | Settings → Notifications → **Long sessions** |
| Session cost | One session's cost — Enterprise and API only | > $25 | Settings → Notifications |
| Daily cost | Today's total — Enterprise and API only | > $50 | Settings → Notifications |
| Unusual day | Today against your own trailing average — Enterprise and API only | > 2.5σ over 14 days | Settings → Advanced limits |
| Daily digest | Once a day, at your first Claude Code session | daily | Settings → Notifications → **Daily digest** |

Idle MCP servers, subagent burn, carried history, quiet premium-model work and
failing tools are ranked as **causes** behind these nudges. They explain a
nudge instead of creating a second, duplicated alarm.

The defaults are deliberately quiet. If a nudge fires on most of your sessions,
it is describing how you work rather than flagging something unusual—move the
mark instead of learning to ignore it.

## Why you can trust the numbers

Claude Code writes one record per piece of each response, and each one repeats
the same usage figures. Marmot counts usage once per response; adding up every
record would inflate a tool-heavy session by roughly 1.9×.

Cache writes are also priced at their recorded lifetime: 1.25× input price for
five minutes and 2× for one hour. Treating every write as the cheaper kind can
understate a heavy session by about a fifth.

A prompt means a prompt you typed. Tool results also appear in Claude Code's
records, but Marmot does not count them as yours.

Cost and tokens are counted on the day each turn happened, in your own time
zone, so a session that runs past midnight is two days of work rather than a
spike on the day it ended.

These cases are pinned by the test suite.

## Good to know

- **Local by design.** Marmot has no account or hosted service, and nothing is
  uploaded.
- **Subscription dollars are estimates.** The modelled figure is the API-rate
  value, not your invoice; the limit percentage is the ceiling that matters.
- **Claude Cowork counts toward your limits, not your cost.** Cowork keeps its
  sessions in the cloud or inside its own virtual machine, so the limit bars
  include it while the cost, tokens and chart cannot.
- **The session page includes prompts and replies.** It is a local file, never
  uploaded; treat it like the transcript it came from.
- **Measuring MCP servers starts them.** Marmot does this now and then to learn
  what each server's tool definitions cost; turn it off in **Settings… →
  Advanced → Measure MCP servers automatically**.
- **What it reads and writes.** It reads `~/.claude/projects` (Claude Code's
  session records) and `~/.claude.json` (your plan and limit reading). It
  writes only `~/.claude/marmot*` files: your settings, what it has already
  told you, its logs, and the generated session pages.
- **Marmot is alpha.** Claude Code's session format is internal and can change.
  **Settings… → Advanced → Run doctor** shows what remains readable.

## Something not right?

| You see | Do this |
|---|---|
| **No current limit reading** | Press **Refresh** (⌘R). The first reading can take about 20 seconds. |
| Limit nudges arrive, but nothing about long sessions or cost | **Settings… → Advanced → Install hooks**, then restart Claude Code |
| Nothing arrives at all | Check Focus / Do Not Disturb first — it silences every app. Then **Settings… → Notifications → Send test notification** |
| A notification fired, but you are not sure what it said | **Settings… → Notifications → Recent notifications** |
| "Marmot can't be opened" after a DMG download | System Settings → Privacy & Security → **Open Anyway**, once |
| Numbers look wrong | **Settings… → Advanced → Run doctor** shows what Marmot can and cannot read |

## Update or remove

```bash
brew update && brew upgrade --cask marmot   # update
brew uninstall --cask marmot                # remove the app
```

Before removing, **Settings… → Advanced → Remove** takes Marmot's hooks out of
Claude Code. To remove its settings and logs too, delete `~/.claude/marmot*`.

Prefer the terminal? Everything here is also a command:
[Marmot from the terminal](docs/cli.md).

## Contributing

The app lives in [`macos/`](macos/README.md) and the engine it runs in `src/`.

```bash
npm test
```

Please work on a branch and open a pull request. `main` moves through reviewed
pull requests only.

## License

[MIT](LICENSE)
