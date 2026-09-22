<p align="center"><img src="./assets/logo.jpg" alt="ask-jev logo" width="200"></p>

<h1 align="center">ask-jev</h1>

<p align="center">
  <img alt="version" src="https://img.shields.io/badge/version-0.2.0-2dd4bf?style=flat-square">
  <img alt="Claude Code plugin" src="https://img.shields.io/badge/Claude%20Code-plugin-1abc9c?style=flat-square">
  <a href="https://github.com/yanmad27/ask-jev/actions/workflows/ci.yml"><img alt="ci" src="https://github.com/yanmad27/ask-jev/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="dependencies" src="https://img.shields.io/badge/dependencies-none-2dd4bf?style=flat-square">
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D18-1abc9c?style=flat-square">
</p>

<p align="center"><strong>English</strong> · <a href="./README.vi.md">Tiếng Việt</a></p>

**Ask [Jev](https://typesafe.ai) before asking you.**

Claude Code often stops to ask you a question (`AskUserQuestion`) even when
the answer is already sitting right there in the conversation. ask-jev
intercepts that question, hands it to Jev — a small, fast model that judges
instead of chats, returning a probability instead of prose — and answers it
for you when the answer is clearly derivable.

Questions that are genuinely yours to answer still reach you, unchanged.

```
"Which date library should we use?"        → picks date-fns (1.00)   — already in package.json
"Package this as a plugin or a skill?"     → picks Plugin   (0.95)
"Which colour palette do you want?"        → asks you                — taste
"Delete the three stale environments?"     → asks you                — irreversible
```

## Install

1. Add the marketplace (once per machine):

   ```
   /plugin marketplace add yanmad27/ask-jev
   ```

2. Install the plugin:

   ```
   /plugin install ask-jev@ask-jev
   ```

3. Give it a Vercel AI Gateway key (Jev lives in Vercel's model catalogue):

   ```bash
   echo 'vck_...' > ~/.claude/ask-jev.key && chmod 600 ~/.claude/ask-jev.key
   ```

   Already have a gateway key lying around? Set the `AI_GATEWAY_API_KEY`
   environment variable instead — no file needed.

That's it. **No key set →** the plugin quietly does nothing and Claude Code
asks you exactly as it always has. Nothing to break.

## Upgrade

```
/plugin marketplace update ask-jev
/plugin update ask-jev@ask-jev
```

The key file was renamed `jev-ask.key` → `ask-jev.key`; the old name is still
read as a fallback, so there's nothing to migrate. Restart Claude Code after
upgrading — hooks only reload on a fresh session.

## 1. Auto-answer `AskUserQuestion`

Before Claude Code shows you a question, ask-jev sends it to Jev with two
things to judge:

1. **Is this even your call to make?** Taste, private priorities, or
   anything irreversible (delete, send, publish, spend money) — Jev refuses
   to touch these, no matter how obvious the "right" answer looks.
2. **If it's not, which option is correct** — given everything said so far in
   the conversation?

Only when Jev is both confident *and* sure the question isn't personal does
Claude get the answer silently and move on. Otherwise the question reaches
you exactly as if ask-jev weren't installed.

### Options need real definitions

For Jev to judge anything, each option needs a description that actually
**defines** it — not just a label. Take "Is this a hamburger?" with an option
simply labelled "Yes": there's nothing to check that against. "Yes" needs a
description like *"A hot sandwich: a cooked ground-meat patty inside a sliced
bun"* — something you could hold the evidence up against and verify.

If any option in a question is missing a description, ask-jev never calls
Jev at all — it bounces the question straight back to Claude with
instructions to re-ask with real definitions added. Nothing reaches you in
that round; Claude just tries again.

Under the hood each option is sent as `{what, not_for}` — `not_for` names the
sibling options it must not overlap with, so the definitions rule each other
out instead of just sitting side by side.

### Several questions, and multiSelect

Several questions in one `AskUserQuestion` call are answered independently.
Whichever ones Jev is confident about get used; the rest are handed back to
you — the reason Claude gets back names the resolved answers and says to
re-ask only what's left, so a confident answer never gets thrown away just
because a sibling question stayed unclear.

`multiSelect` questions go through Jev too: each option becomes its own
yes/no question ("does this option apply?") instead of one pick. An option
counts as selected once its probability clears `JEV_ASK_THRESHOLD`, rejected
once it drops below `1 - JEV_ASK_THRESHOLD`, and the whole question stays
unresolved if any option lands in between. A resolved answer is the
comma-joined list of selected labels — possibly "none".

### When it stays silent

| Condition | Why |
|---|---|
| the question is personal (`personal > 0.5`) | that's your call, not the model's |
| Jev isn't confident enough (`< JEV_ASK_THRESHOLD`) | guessing is worse than asking |
| an option has no description | a bare label isn't something Jev can judge — bounced back to Claude, not forwarded to Jev |
| no usable context in the transcript | nothing for Jev to judge against |
| no key set, Jev errors, or it takes over 8s | a broken helper must never be the reason you can't answer |

## 2. Ask Jev before judging

A `SessionStart` hook injects a short rule reminding Claude to ask Jev before
any judgement call — classifying, picking among fixed options, yes/no on
evidence, ranking — not just when `AskUserQuestion` fires. Two hooks run at
every session start: `self-register.mjs`, which works around a Claude Code
bug that stops plugin `PreToolUse` hooks from firing (see Implementation
notes), and `session-start.mjs`, which injects the rule itself. Both are
silent if no API key is configured.

Since a session-start reminder tends to get forgotten a dozen turns in, the
`prompt` gate (below) re-injects the same one-line rule on **every** turn via
a `UserPromptSubmit` hook. Set `JEV_REMIND=0` to turn it off (e.g. if you
find it repetitive); it's already silent with no API key configured.

Beyond auto-answering `AskUserQuestion`, Claude can consult Jev for *any*
judgement call — classify something, pick between options, answer yes/no,
rate on a scale — via the bundled skill and CLI:

```
echo '{"state": ..., "questions": ...}' | node ~/.claude/plugins/marketplaces/ask-jev/bin/jev.mjs
```

For convenience, add to your shell profile:
```
alias jev='node ~/.claude/plugins/marketplaces/ask-jev/bin/jev.mjs'
```
Then use `jev` directly from any terminal.

Request:

```json
{
  "state": { "item": "Two beef patties, cheese, and pickles between a sesame bun." },
  "questions": {
    "isHamburger": {
      "type": "boolean",
      "instructions": { "question": "Does `item` match the definition of a hamburger?", "focus": "Judge the food itself, not what it's called." },
      "criteria": {
        "true": "A hot sandwich: a cooked ground-meat patty inside a sliced bun",
        "false": "Anything else — a cold sandwich, a non-ground protein, no bun, or not a sandwich at all"
      }
    }
  }
}
```

Response:

```json
{ "isHamburger": { "probability": 0.97, "confidence": 0.95 } }
```

The skill (`skills/ask-jev/SKILL.md`) explains what a good request looks
like — evidence pasted verbatim into `state`, one judgement per question,
criteria that are observable and mutually exclusive — with worked examples.

## 3. Automatic gates

Beyond auto-answering `AskUserQuestion`, four hooks ask Jev proactively at
the moments a human reviewer would actually weigh in — no explicit judgement
call needed from Claude. Each is on by default and can be turned off
individually with `JEV_GATES` (comma list; `JEV_GATES=` disables all four).

| Gate | Fires on | Jev judges | Effect |
|---|---|---|---|
| `permission` | `PreToolUse` (Bash/Edit/Write/MultiEdit/NotebookEdit) | Is this safe to run without asking? | `p ≥ 0.9` → auto-allow; `p ≤ 0.2` → force an ask; otherwise untouched |
| `stop` | `Stop` | Did the assistant stop with work still owed? | `p ≥ 0.85` → blocks the stop with a reason; a repeat block is throttled 30s to avoid looping |
| `bash` | `PostToolUse` (Bash) | success / error / tests_failed / needs_attention | Non-`success` at `p ≥ 0.8` adds one line of context for Claude |
| `prompt` | `UserPromptSubmit` | Is the prompt ambiguous? (skipped under 12 chars or starting with `/`) | Adds the "ask Jev" reminder, plus a one-line ambiguity warning at `p ≥ 0.85` |

**What Jev is shown.** Every gate — and the `AskUserQuestion` hook from
section 1 — builds the same structured `state` (`lib/context.mjs`), aiming
for what a human reviewer would actually look at:

- `task`: the first user message of the session (the original ask) and the
  latest one, verbatim.
- `conversation`: session turns, newest-first, including tool names used and
  a short summary of what each tool returned.
- `workspace`: current git branch, `git status --short`, `git diff --stat`.
- `action`: whatever is specific to that gate — the exact command/edit being
  proposed, the Bash output being triaged, or the final assistant message.

The whole thing is capped at `JEV_STATE_CHARS` (default `60000`; Jev's own
docs don't document a limit, so this is a self-imposed ceiling), filled in
the priority order above — `task` first, then as much `conversation` as fits.
A real ~33k-character state measured ~1.8s round-trip; each gate call times
out at 4s internally (8s at the hook level), so a slow or oversized state
degrades to "emits nothing" rather than blocking you. Lower
`JEV_STATE_CHARS` if you want snappier gates at the cost of less context.

Same fail-open rules as everywhere else: no API key, a gateway error, or a
timeout means the gate is silent — never a blocker.

## Usage analytics

Every gateway call and every hook decision is appended as one JSON line to
`~/.claude/ask-jev.log` (override the path with `JEV_LOG_FILE`, disable
entirely with `JEV_LOG=0`). Only the question text and option labels are
recorded — never the conversation transcript or the `state` payload sent to
Jev.

Inspect it with:

```
node ~/.claude/plugins/marketplaces/ask-jev/bin/jev.mjs stats
```

```
Calls: 12 (ok 11, error 1)
Latency: avg 412ms, p95 780ms

Decisions by outcome:
  answered              7  58.3%
  low_confidence         3  25.0%
  personal               2  16.7%

Recent decisions:
  2026-09-22T10:03:11.000Z  answered           Is this a bug or a feature?    bug (0.91)
```

Narrow the window with `--last N` or `--since 7d|24h`, or add `--json` to get the raw aggregates instead of the text report.

**Note:** `${CLAUDE_PLUGIN_ROOT}` is available inside Claude Code hooks/skills; for manual CLI calls from your terminal, use `~/.claude/plugins/marketplaces/ask-jev/bin/jev.mjs` or the `jev` alias.

### In Paseo

This repo ships a `paseo.json` with two workspace scripts: `jev:stats` (runs
the report above) and `jev:log` (`tail -f` on the log file). Open them from
Paseo's scripts panel to view usage without leaving the app.

For a live dashboard instead of a script, install the
[Paseo plugin](paseo-plugin/README.md) — a workspace panel with stat tiles,
an outcome breakdown, and a live-updating decisions table. Settings → Plugins
→ paste into "Plugin source" → Install:

```
github:yanmad27/ask-jev:paseo-plugin
```

## Configuration

All optional — sensible defaults out of the box.

| Variable | Default | |
|---|---|---|
| `AI_GATEWAY_API_KEY` | reads `~/.claude/ask-jev.key` | your Vercel AI Gateway key |
| `JEV_ASK_THRESHOLD` | `0.8` | lower it to let Jev answer more often (and be wrong more often) |
| `JEV_REMIND` | (on) | set to `0` to stop the per-turn "ask Jev" reminder |
| `JEV_GATES` | `permission,stop,bash,prompt` | comma list of enabled [automatic gates](#3-automatic-gates); empty disables all |
| `JEV_STATE_CHARS` | `60000` | max characters of context sent to Jev per gate call — lower for faster/cheaper gates |
| `JEV_MODEL` | `typesafe-ai/jev` | which model Jev evaluation runs against |
| `JEV_GATEWAY_URL` | Vercel's evaluation endpoint | only needed for a custom gateway |

The legacy key path `~/.claude/jev-ask.key` (from before the plugin was
renamed) is still read as a fallback, so nothing breaks if you set it up
under the old name.

## Contributing

Developing the plugin locally? Point the marketplace at your working copy
instead of GitHub, so edits apply immediately with no push-then-update cycle:

```
/plugin marketplace add ~/workspace/ask-jev
```

Commits follow [Conventional Commits](https://www.conventionalcommits.org)
(`feat:`/`fix:`/`docs:`…) — release-please opens a release PR that bumps
`plugin.json` and tags on merge, so there's no manual tagging.

## Implementation notes

<details>
<summary>How the hook actually intercepts a question, and why there's a second hook you never call directly</summary>

<br>

**No npm dependencies.** Just Node's `fetch` and `fs`, calling the gateway's
evaluation endpoint directly. Clone it and it runs — no `npm install`, no
`node_modules`.

**Answering "on your behalf" is really a denial.** Claude Code gives hooks no
way to return a synthetic tool result. But a `PreToolUse` hook that returns
`permissionDecision: "deny"` has its `permissionDecisionReason` fed straight
back to the model — so ask-jev's "answer" is really *blocking the question
and telling Claude what the answer is*. You'll see one `Jev answered: ...`
line in the session, and Claude carries on as if you'd typed it.

**Why there's a `SessionStart` hook too.** Claude Code currently doesn't run
a plugin's own `PreToolUse` hooks at all
([anthropics/claude-code#36397](https://github.com/anthropics/claude-code/issues/36397))
— only `SessionStart` reliably fires from a plugin. So `hooks/self-register.mjs`
runs on every `SessionStart` and writes the `PreToolUse` entry directly into
your `~/.claude/settings.json`, where hooks are known to work — and keeps the
path current across plugin updates. It only ever touches its own entry and
leaves the rest of your `settings.json` alone. Once upstream fixes that bug,
this becomes a harmless duplicate — worst case, one extra gateway call.

**Context** comes from the last 12 turns of the session transcript (subagent
and machine-generated turns dropped), trimmed to 6000 characters. Each
question costs roughly $0.00002 and takes about 0.7s.

</details>
