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
| `permission` | `PreToolUse` (Bash/Edit/Write/MultiEdit/NotebookEdit) | Is this safe to run without asking? | `p ≥ JEV_ALLOW_THRESHOLD` → auto-allow; `p ≤ 0.2` → force an ask; in between, a second `destructive` check decides allow-or-ask (no silent "unsure" bucket) |
| `stop` | `Stop` | Did the assistant stop with work still owed? | `p ≥ 0.85` → blocks with a reason. In [full autonomy](#4-autonomy), also resolves a trailing "should I…?" on the user's behalf |
| `bash` | `PostToolUse` (Bash) | success / error / tests_failed / needs_attention | Non-`success` at `p ≥ 0.8` adds one line of context for Claude |
| `prompt` | `UserPromptSubmit` | Is the prompt ambiguous? (skipped under 12 chars or starting with `/`) | Safe mode: a clarify-with-the-user warning at `p ≥ 0.85`. [Full autonomy](#4-autonomy): never asks — proceeds on the literal reading or states an assumption |

**What Jev is shown.** Every gate — and the `AskUserQuestion` hook from
section 1 — builds the same structured `state` (`lib/context.mjs`), aiming
for what a careful human reviewer would actually look at, filled in this
priority order (lowest four dropped first if the budget runs out):

1. `preferences` — CLAUDE.md (global, project root, project `.claude/`) and
   persistent memory, **verbatim file contents only** — never a description
   Claude writes of the user. See "Evidence, not characterization" below.
2. `user_past_choices` — the last 30 times the user was actually asked
   something and what they picked (same project first), across all
   sessions. Measured to matter: the same delegation question scored
   `merge_now=0.98` with an LLM-written "user preferences" blurb, but
   `clean_then_merge=1.00` — the option the user actually picked — once fed
   their 7 real prior choices instead.
3. `task` — `current_task` (the latest user message) plus the last 5 user
   messages for background.
4. `action` — the exact thing being judged: the command, or for
   Edit/Write/MultiEdit the real `before`/`after` content, not just a path.
5. `plan_and_todos` — the latest `TodoWrite` state and/or a referenced plan
   file under `~/.claude/plans/` (path is resolved and verified to stay
   inside that directory before reading — no `../` traversal).
6. `session_summary` — if the session went through `/compact`, that summary
   verbatim, so Jev isn't blind to everything before the visible window.
7. `conversation` — recent turns, newest-first, filling whatever budget is
   left after 1–6.
8. `history` — Jev's own last 10 decisions this session, to stay consistent.
9. `permissions` — `allow`/`deny` patterns from `settings.json` — an
   allow-listed command is never rated risky.
10. `workspace` — branch, `git status`, `git diff --stat`, the actual `git
    diff` content (capped, with hunks for `.env*`/`*.pem`/`*.key`/`*secret*`
    files dropped even if tracked), and the file list.
11. `env` — cwd, current time, platform.

**Evidence, not characterization.** Nothing in `state` is Claude's own
description of the user — no "the user prefers X" prose written on the fly.
Every field is either the user's own words (messages), their own files
(CLAUDE.md, MEMORY.md), or a record of what they actually chose
(`user_past_choices`, from a `PostToolUse` hook on `AskUserQuestion` that
logs every real answer). A static test enforces this: no gate is allowed to
build a `preferences`/`user_*` field from a string literal.

The whole thing is capped at `JEV_STATE_CHARS` (default `100000` — a real
~33k-character state measured ~1.8s round-trip and a real 90k-character
state still got a clean 200; the gateway documents no limit, so this is a
self-imposed ceiling with margin, not a measured wall). The cap is enforced
on the actual serialized `JSON.stringify(state).length` as sections are
added in priority order, not a sum of each section's own internal size —
a section that doesn't fit is truncated (head kept, marked
`…[truncated]`) or dropped outright if there's no room at all. Each gate
call is budgeted at 4s (`ask-jev.mjs`'s `AskUserQuestion` answering gets
8s) — split internally into two ~1850ms attempts so a retry (see below)
never blows the budget — and the `hooks.json` timeout for each hook is set
to `budget/1000 + 1s` margin per sequential call a gate might make (6s for
the single-call gates, 16s for `stop`'s up to three, 10s for `ask-jev.mjs`).
A slow or oversized state degrades to "emits nothing" rather than blocking
you. Lower `JEV_STATE_CHARS` if you want snappier gates at the cost of less
context. Every call logs the size in
characters of each section as `state_sizes` — never the content — so the
budget can be tuned from `bin/jev.mjs stats` without exposing anything.

Same fail-open rules as everywhere else: no API key, a gateway error, or a
timeout means the gate is silent — never a blocker.

## 4. Autonomy

`JEV_AUTONOMY` controls how much ask-jev acts instead of asking you —
**`full` is the default**; set it to `safe` to go back to the pre-autonomy
behavior (Jev only ever auto-*answers* on your behalf, never proceeds past a
question or a stop on its own).

One guardrail never turns off, in either mode: a `destructive` boolean —
"would this destroy or expose something that cannot be undone: delete files
outside the workspace, drop data, force-push/rewrite shared history,
publish/deploy/pay/send to third parties, leak secrets" — and `p ≥ 0.6`
always hands the decision to you, full autonomy or not.

What changes in `full`:

- **`AskUserQuestion`** — the `personal` check (is this the user's call?) no
  longer causes a fallback by itself; only `destructive` does. A question
  Jev is confident about gets answered even if it reads as a personal
  preference, as long as it isn't destructive.
- **`prompt` gate** — an ambiguous prompt never turns into "ask the user."
  Instead Jev judges whether the literal reading is actionable: if so,
  Claude proceeds and states its assumption in one line; if not, Claude
  picks the reading most consistent with the original task, states that
  assumption, and proceeds. Either way, no question reaches you.
- **`stop` gate** — if the assistant's final message ends by asking you a
  question or for permission ("do you want me to…", "should I…"), Jev
  judges what should happen: answerable and not destructive → the stop is
  blocked with Jev's answer and an instruction not to ask again; already
  satisfied → the stop proceeds; destructive or genuinely your call → the
  stop proceeds so the question actually reaches you.
- **`permission` gate** — the allow threshold is `JEV_ALLOW_THRESHOLD`
  (default `0.8` in `full`, `0.9` in `safe`) instead of a fixed `0.9`.

Every autonomous decision is still logged with the same `label` +
`confidence` + `reason` shape as everything else — nothing here is silent,
it's just no longer routed through you.

## Usage analytics

Every gateway call and every hook decision is appended as one JSON line to
`~/.claude/ask-jev.log` (override the path with `JEV_LOG_FILE`, disable
entirely with `JEV_LOG=0`). Each decision line carries which `gate` produced
it (`ask`, `permission`, `stop`, `bash`, `prompt`), Jev's answer as a
`label` + `confidence`, and a short `reason` — the criterion text Jev
matched, never the conversation transcript or the `state` payload sent to
Jev.

Inspect it with:

```
node ~/.claude/plugins/marketplaces/ask-jev/bin/jev.mjs stats
```

```
Calls: 19 (ok 18, error 1)
Latency: avg 512ms, p95 910ms
Jev decided: 63.2%  Fell back to user: 15.8%  User overrides: 7

Decisions by outcome:
  answered               7  36.8%
  allow                  4  21.1%
  success                3  15.8%
  low_confidence         2  10.5%
  personal               1   5.3%
  ask                    1   5.3%
  tests_failed           1   5.3%

By gate:
  ask          calls   10  positive  70.0%  answered 7, low_confidence 2, personal 1
  permission   calls    5  positive  80.0%  allow 4, ask 1
  bash         calls    4  positive  75.0%  success 3, tests_failed 1

Recent decisions:
  2026-09-22T10:03:11.000Z  answered           Is this a bug or a feature?    bug (0.91)
  2026-09-22T10:02:47.000Z  allow              rm dist/old-build.js           safe (0.97)
```

Narrow the window with `--last N` or `--since 7d|24h`, or add `--json` to get the raw aggregates instead of the text report.

`decisions.by_gate` breaks the same numbers down per gate — `{ total, positive, by_outcome }` — since each gate defines "positive" differently (an `ask` decision Jev answered outright, a `permission` decision Jev auto-allowed, a `bash` run Jev judged `success`, …). "Fell back to user" only counts the two cases where a question or permission prompt actually reached you: an unanswered `ask` question, or a `permission` gate that forced an `ask`. "User overrides" counts `user_choice` events — every real answer you gave `AskUserQuestion`, captured by a `PostToolUse` hook and fed back into `user_past_choices` for future decisions.

**Note:** `${CLAUDE_PLUGIN_ROOT}` is available inside Claude Code hooks/skills; for manual CLI calls from your terminal, use `~/.claude/plugins/marketplaces/ask-jev/bin/jev.mjs` or the `jev` alias.

### In Paseo

This repo ships a `paseo.json` with two workspace scripts: `jev:stats` (runs
the report above) and `jev:log` (`tail -f` on the log file). Open them from
Paseo's scripts panel to view usage without leaving the app.

For a live dashboard instead of a script, install the
[Paseo plugin](paseo-plugin/README.md) — a workspace panel with stat tiles,
a gate filter alongside the outcome breakdown, and a live-updating decisions
table (Time, Gate, Outcome, Question/Subject, Answer, Reason — tap a row to
expand a truncated question or reason). Settings → Plugins → paste into
"Plugin source" → Install:

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
| `JEV_STATE_CHARS` | `100000` | max characters of context sent to Jev per gate call — lower for faster/cheaper gates |
| `JEV_AUTONOMY` | `full` | [autonomy mode](#4-autonomy); set to `safe` to only ever auto-answer, never proceed on its own |
| `JEV_ALLOW_THRESHOLD` | `0.8` full / `0.9` safe | `permission` gate's auto-allow threshold |
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

### Evals

`skills/ask-jev` and the hooks are covered by `claude plugin eval` cases
under `evals/` — trigger evals (does the skill fire when it should, and stay
quiet when it shouldn't), behaviour rubrics (evidence verbatim, no
`undetermined` bucket, no invented preferences), and CLI contract checks for
`bin/jev.mjs`. Run them locally with:

```
./scripts/eval.sh --trust-plugin
```

Each case spawns a real Claude Code agent, so you need a logged-in `claude`
(or `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN` in the environment). A
weekly `.github/workflows/evals.yml` job reruns the suite given a
`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` repo secret, or skips
cleanly without one — it never gates pull request CI.

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
