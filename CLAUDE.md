# Marmot — working notes

Marmot reads the session records Claude Code writes to `~/.claude/projects/**/*.jsonl`
and reports on your own token consumption. No account, no server, no upload.
Node 18+, ESM, **zero dependencies** — keep it that way, it's what makes `npx` instant
and the supply chain empty.

```bash
node bin/marmot.mjs --demo        # synthetic data, safe for screenshots
node bin/marmot.mjs --days 7      # your own
node bin/marmot.mjs doctor        # what's readable on this machine
```

---

## Read this before touching the readers

The transcript format is **internal and undocumented**. Three things about it are
non-obvious, cost real money to get wrong, and were each found the hard way. If
you change `src/sessions.mjs` or `src/detail.mjs`, keep all three.

### 1. One API response spans several JSONL entries, each repeating `usage`

Claude Code writes **one entry per content block** — a thinking block, then the
text, then each `tool_use` — and every one of those entries carries the *same*
`message.usage` object. Summing usage per entry inflated cost and turn counts by
**1.91×** on a real tool-heavy session ($796 → $418).

Usage is counted once per `message.id` (falling back to `requestId`). Content
blocks are still counted per entry, because each entry carries a *different* one.
Both readers do this; they must stay in agreement.

```
verify:  node -e '…' # group assistant entries by message.id, compare summed
                     # usage against deduped. The two must differ ~1.9x on a
                     # tool-heavy session, and the reader must match the deduped one.
```

### 2. A "turn" is a prompt the human typed

Tool results come back as `type: "user"` entries too. Counting every user entry
read a 57-prompt session as **1,191**. The discriminator is `promptSource`:

| value | what it is | count it? |
|---|---|---|
| `typed` | a prompt the developer typed | **yes** |
| `queued` | queued input | no |
| `system` | task notifications, reminders | no |
| absent | compaction continuation | no |

Older transcripts predate the field, so `isTypedPrompt()` falls back to "user
entry with no `tool_result` block" when a file carries no `promptSource` at all.

### 3. Cache writes have two prices, and the transcript says which

`usage.cache_creation` breaks out `ephemeral_5m_input_tokens` and
`ephemeral_1h_input_tokens`. A 1h write costs **2×** the input rate, a 5m write
**1.25×**. Claude Code writes 1h entries, so pricing every write at 1.25×
understates a heavy session by about a fifth. See `src/pricing.mjs`.

Also there: `usage.speed === "fast"` means fast mode, priced at $10/$50 on Opus.
`<synthetic>` model turns are locally generated and never billed — skip them
silently rather than reporting them as unpriced.

### Everything else

Be defensive. A malformed line is skipped, an unknown shape degrades to a partial
session. A renamed field should cost a metric, not the report. `marmot doctor`
exists to surface that.

**Tool results are never stored.** They are ~95% of the bytes on disk — 40MB of
one 42MB transcript — and dropping them is what turns a 41MB transcript into a
1MB browsable page. Names, inputs and success/failure are kept.

---

## Layout

| Path | What it is |
|---|---|
| `src/sessions.mjs` | Aggregate reader. One rolled-up record per session. |
| `src/detail.mjs` | Per-turn reader for the browser: the event timeline. |
| `src/pricing.mjs` | Published rates, cache multipliers, fast mode. |
| `src/rules.mjs` | The nudge rules. Pure functions, no I/O beyond MCP config. |
| `src/notify.mjs` | Bell + desktop notification. Never throws; `MARMOT_NO_NOTIFY` mutes it. |
| `src/skills.mjs` | Skill sizes, read from SKILL.md on disk. |
| `src/mcp.mjs` | Server discovery, and the audit client. The only code that starts a process. |
| `src/open.mjs` | Which editor opens the config, per OS. `open -t`, not `open`. |
| `src/config.mjs` | Defaults + `~/.claude/marmot.json`. |
| `src/state.mjs` | Dedupe: what has already been said. |
| `src/render.mjs` | Terminal output. |
| `src/html.mjs` | The self-contained browser page (one template function). |
| `src/demo.mjs` | Deterministic synthetic sessions for `--demo`. |
| `bin/marmot.mjs` | CLI entry and command dispatch. |
| `commands/*.md` | Slash commands. Auto-loaded — never declare them in `plugin.json`. |
| `scripts/hook.mjs` | SessionStart digest + Stop live nudges. |
| `scripts/statusline.mjs` | The statusline. Incremental file reads. |
| `test/` | `node:test` suite. `npm test`. |

Two readers exist on purpose: `sessions.mjs` answers *what did this cost*,
`detail.mjs` answers *what happened*. `isTypedPrompt()` is shared between them —
it lives in `sessions.mjs` and `detail.mjs` imports it, because when the rule was
restated in both they drifted, and the page counted a legacy transcript's tool
results as prompts. The usage accounting is still duplicated: if you change how
cost is computed, change both. `test/agreement.test.mjs` fails when they diverge.

A detail record is deliberately a **superset** of a session record — it also
carries `baselineTokens`, `dirTouches`, `promptTimes`, `modelTokens`,
`toolErrorRate` and `mcpCalls`/`skills` aliases. That is what lets the browser
page run the same `totals()` and the same rules as the terminal report, so the
two surfaces cannot quote different numbers. Keep it that way when adding a field.

## Adding a rule

Rules live in `sessionRules` (judge one session) or `windowRules` (need the whole
window). Every rule returns `{ detail, action }` or `null`, and must carry all
three guards:

- a **ratio gap** — how far past normal, not merely past
- a **minimum sample** — enough turns/calls to mean anything
- a **dollar floor** — nothing about a session too small to care about

Without all three, the same checks fired on nearly every session in testing. A
nudge that always fires gets muted, and then none of them work. Add the default
to `DEFAULTS` in `config.mjs` and a row to the README table.

Rules in `cfg.live` may interrupt mid-session; everything else waits for the daily
digest. Cost rules re-fire at each doubling (`state.mjs`), all others once per
session.

## Plugin gotchas

Both of these fail **silently or obscurely** — they cost an afternoon each.

1. **Don't declare `hooks` or `commands` in `plugin.json`.** `hooks/hooks.json`
   and `commands/` are standard locations loaded automatically. Declaring them
   again fails the whole plugin load with *"Duplicate hooks file detected"* — and
   `claude plugin details` still happily lists the components, so it looks fine.
   The manifest is name/version/description only.

2. **Hook `command` must be a string, not an array.** `["node", "…"]` is dropped
   by validation with no error; the hooks simply never fire. Use
   `"node \"${CLAUDE_PLUGIN_ROOT}/scripts/hook.mjs\""`.

3. **Slash-command arguments**: use `$ARGUMENTS`. Bash-style `${1:-30}` is passed
   through literally and became "your last NaN days". `posInt()` in the CLI now
   guards this, but don't reintroduce the pattern.

4. **macOS drops notifications from unauthorised apps silently.** `osascript`
   exits 0 and nothing appears. A plain `display notification` is posted by
   *Script Editor*, which almost nobody has authorised — so the notification has
   to be attributed to the host terminal via `__CFBundleIdentifier`, and even
   that fails if the terminal itself was never allowed. `deliverability()` reads
   `com.apple.ncprefs` to tell the difference, and `marmot doctor` reports it.
   Never assume a notification arrived because the command succeeded.

5. **A slash command in a session whose plugin was just removed prints nothing
   at all.** `${CLAUDE_PLUGIN_ROOT}` empties, the command becomes
   `node "/bin/marmot.mjs"`, node writes *Cannot find module* to stderr, and the
   slash command surfaces an empty result — it reads as "the report is broken"
   rather than "the plugin is gone". Plugin state only reloads at startup, so
   **restart after any install, uninstall or marketplace change** before judging
   anything. `claude plugin list` also keeps reporting the old state until then,
   including `✔ enabled` for a plugin you have just uninstalled.

6. **`claude plugin install` has no `--force`.** To pick up changes:
   ```bash
   claude plugin marketplace update marmot
   claude plugin uninstall marmot && claude plugin install marmot@marmot
   ```

Always check the status line, not just the component counts:

```bash
claude plugin list | grep -A4 'marmot@'      # must say: Status: ✔ enabled
claude plugin details marmot                  # Skills (2), Hooks (2)
```

## Verifying a change

```bash
npm test        # 253 tests, node:test, no dependencies
```

The suite encodes the drill that used to be manual, so most of it is covered:

| File | What it pins down |
|---|---|
| `test/pricing.test.mjs` | Prefix matching, fast mode, the three cache multipliers. |
| `test/sessions.test.mjs` | All three invariants above, plus defensive parsing. |
| `test/detail.test.mjs` | Turn merging, tool-result bodies never stored, clipping. |
| `test/agreement.test.mjs` | **The two readers agree** — cost, turns, tokens, prompts. |
| `test/rules.test.mjs` | Every rule's three guards; quiet on an ordinary session. |
| `test/cli.test.mjs` | Every command runs; `--no-text` redacts; the page is self-contained. |
| `test/hook.test.mjs` | Stop and SessionStart, driven over stdin as Claude Code drives them. |
| `test/notify.test.mjs` | Alert decisions, without firing a real popup or bell. |
| `test/mcp.test.mjs` | The audit protocol, against a real stdio server it starts itself. |

`test/helpers.mjs` builds fixtures in the real transcript shape — note that
`response()` deliberately fans one API response out across several JSONL
entries, because a one-entry-per-response fixture cannot catch the 1.9x
over-count.

Two things the suite does not cover, still worth doing by hand:

```bash
# the hook fires end to end against the real binary
rm -f ~/.claude/marmot-state.json
cd /tmp && claude -p "say ok" --max-turns 1 >/dev/null
[ -f ~/.claude/marmot-state.json ] && echo fired || echo "NOT FIRING"

# the report looks right against your own data
node bin/marmot.mjs report --days 7
```

For the page, render it and *look* at it — a screenshot has caught bugs that
static checks did not (a bar list where every value was 1, so every bar was full
width; repeated per-turn metadata that exposed the usage-duplication bug above).

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless \
  --disable-gpu --screenshot=/tmp/s.png --window-size=1240,1600 \
  --virtual-time-budget=6000 "file:///tmp/demo.html"
```

## Screenshots and demo data

**Never screenshot real sessions for the repo.** The index shows session titles,
repo paths and branch names; the detail page shows raw prompts. `--demo` exists
for this: `src/demo.mjs` is seeded and deterministic, so a screenshot regenerated
later still matches the README.

Demo runs must not touch the machine either — `bin/marmot.mjs` passes an explicit
`configured` server list to the rules so `mcp-idle` doesn't report on the real
`~/.claude/mcp.json`.

## Charts

The page's palette is the validated categorical set (blue/orange/aqua/yellow,
fixed slot order) with a single-hue blue for magnitude. If you add or change a
series colour, re-run the validator in **both** modes rather than eyeballing it;
light-mode aqua and yellow sit under 3:1 on the surface, which is why every value
is direct-labelled in the legend. Cost-per-turn is one hue over an ordered axis —
don't make it categorical, and never add a second y-axis.

## Tone

Numbers are stated plainly with their caveat attached, once. Cost is a **shadow
price** on subscription plans — say so where it appears, don't bury it. Nudges say
what happened, what it cost, and what to do instead; they don't scold, and they
don't rank people. The README's opening carries the "not an invoice line" caveat
deliberately — keep it there.
