---
name: config
description: Open Marmot's threshold file — the caps and ratios that decide when a nudge fires — in your editor, creating it with the defaults if you have not got one yet.
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/marmot.mjs" config --print $ARGUMENTS`

Marmot has opened its threshold file in the editor, and printed the path and
current contents above.

Tell the user where it is, in one line. If the output says it was created, say
that it now holds the defaults. Do not print the whole file back to them — it is
above, and it is open in front of them.

Every threshold that decides when a nudge fires lives in this file. The ones
users most often want:

- `limits.steps` — the marks on the way to your plan's limits, `[50, 75, 90]`
  by default, per plan under `limits.byPlan`. On a subscription these are the
  real ceiling.
- `session.costCap` / `daily.costCap` — dollar caps, which only fire on
  pay-as-you-go. On a subscription the money is already spent, so they are
  skipped rather than firing every day about a bill nobody sends.
- `session.turnCap` — prompts in one session before it is worth a word.
- `live` — which rules may interrupt mid-session. Everything not listed here
  waits for the daily digest.
- `rateOverrides` — set these if you are on negotiated rates and want the
  modelled cost to match your contract.

If the user asks to change a threshold, edit the file directly with the Edit
tool and confirm the new value. Nothing needs restarting; the next run reads it.

If a rule is firing on nearly every session, the fix is usually to raise its cap
rather than to remove the rule — a nudge that always fires gets ignored, and
then none of them work.
