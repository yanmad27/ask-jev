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

Claude Code often stops to ask you a question (`AskUserQuestion`), and the
answer is often already sitting in the conversation. ask-jev hands that
question to Jev — a small, fast model that judges instead of chats, returning a
probability instead of prose — and shows you Jev's recommendation next to the
question. **Jev advises; you decide.** Jev never answers an `AskUserQuestion`
for you and never blocks it: the question always reaches you, with its options
and their labels intact. By default Jev's line is appended to the question text
(see [the channel setting](#1-advice-on-askuserquestion)).

```
"Which date library should we use?"        → Jev đề xuất: date-fns (1.00) — already in package.json
"Package this as a plugin or a skill?"     → Jev đề xuất: Plugin (0.95)
"Which colour palette do you want?"        → Jev nghiêng về: Teal (0.55) — no direct statement from you — a guess
"Delete the three stale environments?"     → Jev đề xuất: Keep them (0.88) — and you still decide
```

(The one-line advice the Claude Code hook shows is in Vietnamese —
`đề xuất` = "recommends", `nghiêng về` = "leans towards".)

## Install

1. Add the marketplace (once per machine):

   ```
   /plugin marketplace add yanmad27/ask-jev
   ```

2. Install the plugin:

   ```
   /plugin install ask-jev@ask-jev
   ```

3. Get a key at [console.typesafe.ai/keys](https://console.typesafe.ai/keys)
   and set it as `TYPESAFE_API_KEY` — or put it in a file:

   ```bash
   echo '<your key>' > ~/.claude/ask-jev.key && chmod 600 ~/.claude/ask-jev.key
   ```

   **Legacy Vercel AI Gateway:** existing `vck_...` keys keep working — they
   are auto-detected and routed through the gateway. Force a provider with
   `ASK_JEV_PROVIDER=typesafe|vercel`. Reading the key from
   `AI_GATEWAY_API_KEY` is deprecated; prefer `TYPESAFE_API_KEY`.

That's it. **No key set →** the plugin quietly does nothing and Claude Code
asks you exactly as it always has. Nothing to break.

## What you'll see

When Claude asks you a question, ask-jev adds one line of advice per question
to the session, in the question's own wording:

```
Jev đề xuất: Plugin (0.95) — A packaged bundle of hooks, skills and commands [grounded in your messages/past choices]
Jev nghiêng về: Teal (0.55) — A calm blue-green accent [no direct statement from you — a guess]
```

- **`Jev đề xuất: X (0.86) — <reason>`** — Jev's confidence in `X` is at or
  above `ASK_JEV_ASK_THRESHOLD` (default `0.8`).
- **`Jev nghiêng về: X (0.55) — <reason>`** — weak advice: below the threshold.
- **`<reason>` is not Jev's own explanation** — the classifier returns
  probabilities, not prose. It is the recommended option's own description,
  plus a tag saying whether your messages or past choices ground the pick
  (`grounded in your messages/past choices`) or it is a guess
  (`no direct statement from you — a guess`). It is capped at 160 characters.
- **If Jev fails** (provider error, timeout, out of credits) the question
  still reaches you, with a note appended the same way as advice: `Jev: không có đề xuất (lỗi <status>) — bạn tự quyết`
  ("no advice — you decide"). A billing / HTTP 402 failure says
  `hết credits — credits exhausted` once per session and a generic note after.
- **No API key** → completely silent.

The question is never answered or denied. In the default `annotate` channel
(below) its text carries Jev's line (or the failure note) and the recommended
option's description gets ` (Jev đề xuất)`; option labels are never changed.
The examples above are illustrative.

## How it works

Four pieces, layered on top of each other:

1. **[Advice on `AskUserQuestion`](#1-advice-on-askuserquestion)** — the
   core feature above: Jev recommends, you answer.
2. **[Ask Jev before judging](#2-ask-jev-before-judging)** — Claude may
   consult Jev through a CLI for its *own internal* judgement calls (which
   model tier, how to classify something) — never for anything that is yours
   to decide.
3. **[Automatic gates](#3-automatic-gates)** — four hooks ask Jev at the
   moments a human reviewer would weigh in: is this tool call safe, did the
   assistant stop too early, did a command succeed, is the prompt ambiguous.
4. **[Autonomy](#4-autonomy)** — how far the *gates* act instead of asking
   you, with one guardrail that never turns off: anything destructive always
   comes to you.

### 1. Advice on `AskUserQuestion`

When Claude Code is about to show you a question, ask-jev sends it to Jev
together with the session context, and Jev scores each option. **Jev never
answers.** It cannot select an option, deny the tool, or hand a result back to
Claude — the `PreToolUse` hook adds information and nothing else.

What Jev is shown is the `state` described under "What Jev is shown" in
[Automatic gates](#3-automatic-gates): the messages **you typed** (the `task` section holds only those — tool
results and Claude's own output are excluded from it), the recent conversation,
your CLAUDE.md and memory files, and your **past choices**. Two things to know about the past choices:

- they are read from the [local log](#usage-analytics) — the last 30
  `AskUserQuestion` answers recorded there, **across all your projects and
  sessions** (same project first), not only the current one;
- so the question text and the option you picked in another project can be sent
  to Jev when you are working in this one.

Jev then judges one thing per question: **which option would you pick, given
that evidence?** (and whether your own words or past choices actually
ground that pick). There is no
"is this your call?" filter any more — taste, personal and even destructive
questions get advice too, because you are the one deciding. See
[What you'll see](#what-youll-see) for the format.

**How the advice reaches you** is a setting, `ASK_JEV_ADVICE_CHANNEL`:

| Channel | What happens |
|---|---|
| `annotate` (default) | The hook returns `permissionDecision: "ask"` with an `updatedInput`: the advice line (or, when Jev failed, the failure note) is appended to the question text and the recommended option's description gets ` (Jev đề xuất)`; option labels are unchanged. It also emits the same text as a top-level `systemMessage`. It still asks you — the hook drops any answer-like key (`answers`, `annotations`, …) from `updatedInput`, so it can never pre-fill a reply |
| `message` (opt-in) | Only a top-level `systemMessage` line per question; the question itself is passed through untouched |

`annotate` is the default because, in Claude Code 2.1.284, a `systemMessage`
on its own only shows up in the transcript *after* the dialog closes — too late
to help you choose. Because the question text is what Claude Code keys the
answer by, the answer Claude receives is keyed by the annotated question, so
Claude sees Jev's line there too, labelled as Jev's. The [log](#usage-analytics)
keeps the **original** question as the canonical text.

With several questions in one call each gets its own line, prefixed
`[1/3]`, `[2/3]`, …; a `multiSelect` question is judged option by option and may
recommend several options (or none).

**In [Paseo](#in-paseo), install the [Paseo plugin](paseo-plugin/README.md) —
it advises natively, and still never answers.** The plugin watches the pending
permission request and appends one timeline item per question
(`ask-jev.advice`) — a separate item, not text on the card. It never calls
`respondToPermission` for a question. If Jev fails, an
`ask-jev.advice` item says the advice is unavailable (a 402 adds that Jev's
credits are exhausted, once per agent session); a missing key is silent.
Claude Code's own `AskUserQuestion` hook stands down under `PASEO_AGENT_ID`
(logged as a `standdown`, not a `decision`) so the two never double-advise.
Without the plugin, questions in Paseo reach you with no advice.

**Known limit:** an advice item whose append is already in flight when you
answer can still land afterwards (it cannot be cancelled). Your answer is then
recorded as `no_advice`, because the advice was not visible when you chose.

The plugin needs the same Jev API key as the hooks — `~/.claude/ask-jev.key`,
or `TYPESAFE_API_KEY`/`ASK_JEV_API_KEY` — but it's read from the **Paseo
daemon's** own environment and home directory, not the shell you happen to
be typing in. If you only export the key in a shell rc, the daemon may never
see it; the key file sidesteps that. Install only **one** copy of the
plugin: two copies loaded in the same process (e.g. `ask-jev` and a local
`ask-jev-dev`) share an in-memory dedupe map so they won't both advise on the
same request, but there's no reason to run two.

<details>
<summary>Options need real definitions, multiSelect, and when there is no advice</summary>

**Options need real definitions.** For Jev to judge anything, each option
needs a description that actually **defines** it — not just a label. Take
"Is this a hamburger?" with an option simply labelled "Yes": there's nothing
to check that against. "Yes" needs a description like *"A hot sandwich: a
cooked ground-meat patty inside a sliced bun"* — something you could hold
the evidence up against and verify. The description is also what Jev's
`<reason>` quotes back at you.

If any option in a question is missing a description (or the question has
fewer than two options), ask-jev does not call Jev for that question: it adds
no advice and no note, and the question reaches you as asked. The skipped
question is logged as `advice_unavailable` (`missing_definition` /
`single_option`).

Under the hood each option is sent as `{what, not_for}` — `not_for` names the
sibling options it must not overlap with, so the definitions rule each other
out instead of just sitting side by side.

**Several questions, and multiSelect.** Several questions in one
`AskUserQuestion` call are advised independently; a failure on one does not
affect the others.

`multiSelect` questions go through Jev too: each option becomes its own
yes/no question ("does this option apply?") instead of one pick. Every option
at or above 0.5 is recommended — possibly none — and the advice's confidence is
the least decisive option's.

**When you get no advice (Claude Code hook).**

| Condition | What you see |
|---|---|
| no API key | nothing at all |
| no usable context in the transcript | nothing (logged `advice_unavailable: no_context`) |
| an option has no description, or only one option | nothing (logged `missing_definition` / `single_option`) |
| Jev errors or takes over 8s | the question plus `Jev: không có đề xuất (…) — bạn tự quyết` (appended to the question in `annotate`, a `systemMessage` in `message`) |
| running inside Paseo | the Claude Code hook stands down; the Paseo plugin (if installed) advises instead |

</details>

### 2. Ask Jev before judging

Jev's CLI is for Claude's **own internal judgement calls** — which model or
tier to use, how to classify something internal — where the answer follows from
evidence Claude already has. It is **not** a way around you: anything you would
decide (taste, push / PR / merge / deploy, any external effect such as sending,
uploading, inviting, purchasing or deleting) goes through `AskUserQuestion`,
where Jev only advises and you answer.

A `SessionStart` hook injects a short rule saying exactly that. Two hooks run at
every session start: `self-register.mjs`, which works around a Claude Code
bug that stops plugin `PreToolUse` hooks from firing (see
[Implementation notes](#implementation-notes)), and `session-start.mjs`,
which injects the rule itself. Both are silent if no API key is configured.

Since a session-start reminder tends to get forgotten a dozen turns in, the
`prompt` gate (below) re-injects the same one-line rule on **every** turn via
a `UserPromptSubmit` hook. Set `ASK_JEV_REMIND=0` to turn it off (e.g. if you
find it repetitive); it's already silent with no API key configured.

Claude can consult Jev for those internal judgement calls — classify
something, pick between options, answer yes/no, rate on a scale — via the
bundled skill and CLI. When the confidence is at or above
`ASK_JEV_ASK_THRESHOLD` Claude may act on the answer and reports it as one line,
`Jev chose "X" (0.93)` (the CLI itself prints the raw JSON below; the one-line
report is an instruction to Claude). Below the threshold Claude states its own
manual choice and says so.

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

**The CLI checks the request before it calls Jev** (`lib/cli-validate.mjs`,
plain regexes, no model call). There is no override.

*Rejected* — exit code 2, the provider is never called, Claude falls back to
its own manual choice:

- a `state` key that is Claude's own description of you (`user_profile`,
  `user_taste`, `about_user`, …) rather than your words;
- a taste / preference question with none of your own words or past choices in
  `state`;
- Claude asking Jev to judge its own output ("is my fix correct?");
- a question that asks Jev to take a decision that is yours — push / PR / merge
  / deploy / send / delete and similar — in a "should I…?" / "ok to…?" framing,
  or an option labelled with the action and its object (`Push to origin`,
  `delete it`, `do_not_push`);
- any question, instruction or criteria string over 4096 characters.

*Flagged* — a warning on stderr and in the log, the call still goes through:
a question that looks checkable with a read-only command (run it and put the
output in `state` instead); a `state` text that reads like a description of
your taste; a bare action-word label or an action-like criterion without a
decision framing, which may be a plain classification (`release`,
`Merge the PR now`); evidence that repeats the
question or several option labels verbatim.

### 3. Automatic gates

Besides the advice on `AskUserQuestion`, four hooks ask Jev proactively at
the moments a human reviewer would actually weigh in — no explicit judgement
call needed from Claude. Each is on by default and can be turned off
individually with `ASK_JEV_GATES` (comma list; `ASK_JEV_GATES=` — set but empty —
disables all four). The gates are unchanged by the advice-only design.

| Gate | Fires on | Jev judges | Effect |
|---|---|---|---|
| `permission` | `PreToolUse` (every tool — matcher `*`) | Is this safe to run without asking? | A static read-only allowlist (`Read`, `Grep`, `Glob`, `LS`, `WebSearch`, `WebFetch`, `list_`/`get_`/`read_`/`search_`/`inspect_`/`capture_`-style MCP calls, …) auto-allows with **zero network calls**. Everything else asks Jev both `safe` and `destructive` together: `p(destructive) ≥ 0.6` always forces an ask; else `p(safe) ≥ ASK_JEV_ALLOW_THRESHOLD` and `p(destructive) < 0.3` → auto-allow; otherwise ask (no silent "unsure" bucket). In [full autonomy](#4-autonomy), anything Jev rates non-destructive (`< 0.3`) proceeds even if `safe` misses the threshold; `0.3–0.6` asks; `≥ 0.6` always asks |
| `stop` | `Stop` | Did the assistant stop with work still owed? | `p ≥ 0.85` → blocks with a reason. In [full autonomy](#4-autonomy), also resolves a trailing "should I…?" on the user's behalf |
| `bash` | `PostToolUse` (Bash) | success / error / tests_failed / needs_attention | Non-`success` at `p ≥ 0.8` adds one line of context for Claude |
| `prompt` | `UserPromptSubmit` | Is the prompt ambiguous? (skipped under 12 chars or starting with `/`) | Safe mode: a clarify-with-the-user warning at `p ≥ 0.85`. [Full autonomy](#4-autonomy): never asks — proceeds on the literal reading or states an assumption |

The read-only fast path and the `destructive` criteria live in `lib/gate.mjs`,
shared between the `permission` hook and `bin/jev-eval.mjs`, so a replay uses
the exact same rules a real decision would. `AskUserQuestion` never reaches
this gate — it has its own hook (section 1).

<details>
<summary>What counts as destructive (and what doesn't)</summary>

**What counts as destructive.** Irreversible loss or exposure — no undo, no
way to get the data or trust back:

- Deleting or overwriting a file outside both the workspace and scratch
  dirs (`/tmp`, `$TMPDIR`, `~/.cache`, `~/.paseo/worktrees`, git
  worktrees), or `rm -rf` on a non-scratch path
- `git push --force`/`--force-with-lease`, rewriting shared history, or
  pushing directly to `main`/`master`/another protected branch
- Deleting a remote branch or tag
- `npm publish`/`paseo plugin install` from an untrusted source,
  deploying, paying, or emailing/messaging a third party
- Printing or exfiltrating a secret or key, or dropping a database
- Editing `~/.ssh`, `~/.claude/settings*.json`, or a shell rc file

Reversible, so **not** destructive:

- Writes inside the workspace or a scratch dir (`/tmp`, `$TMPDIR`, `~/.cache`,
  `~/.paseo/worktrees`, git worktrees, `~/.claude/plans/`,
  `~/.claude/projects/*/memory/`, `~/.claude/todos/`)
- `git commit`/`branch`/`checkout`/`merge`/`rebase` of local branches
- `git push` to a feature branch
- `gh pr create`/`edit`/`checks`/`merge --squash` (a merge only lands once
  CI and branch protection allow it)
- Reads or network GETs
- A `sleep`/polling loop

</details>

<details>
<summary>What Jev is shown (the <code>state</code> priority order)</summary>

Every gate — and the `AskUserQuestion` advice from section 1 — builds the same
structured `state` (`lib/context.mjs`), aiming for what a careful human
reviewer would actually look at, filled in this priority order (lowest four
dropped first if the budget runs out):

1. `preferences` — CLAUDE.md (global, project root, project `.claude/`) and
   persistent memory, **verbatim file contents only** — never a description
   Claude writes of the user. See "Evidence, not characterization" below.
2. `user_past_choices` — the last 30 times the user was actually asked
   something and what they picked, read from the local log
   (`readUserPastChoices`): **across all projects and sessions**, same project
   (`cwd`) first. When Jev had advised, the entry also carries
   `jev_recommended` and whether you `agreement`-ed. Measured to matter: the same delegation question scored
   `merge_now=0.98` with an LLM-written "user preferences" blurb, but
   `clean_then_merge=1.00` — the option the user actually picked — once fed
   their 7 real prior choices instead.
3. `task` — `current_task` (the latest user message) plus the last 5 user
   messages for background — **human-typed text only**; tool results and
   Claude's output are not included here.
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

The whole thing is capped at `ASK_JEV_STATE_CHARS` (default `70000` — a real
~33k-character state measured ~1.8s round-trip; api.typesafe.ai caps `state`
at 32k tokens, and dense log-like text of 80k characters passed while 90k
was rejected with `max_tokens_exceeded`, so 70k leaves margin). The cap is enforced
on the actual serialized `JSON.stringify(state).length` as sections are
added in priority order, not a sum of each section's own internal size —
a section that doesn't fit is truncated (head kept, marked
`…[truncated]`) or dropped outright if there's no room at all. Each gate
call is budgeted at 4s (`ask-jev.mjs`'s `AskUserQuestion` advice gets
8s) — split internally into two ~1850ms attempts so a retry never blows the
budget — and the `hooks.json` timeout for each hook is set to
`budget/1000 + 1s` margin per sequential call a gate might make (6s for the
single-call gates, 16s for `stop`'s up to three, 10s for `ask-jev.mjs`). A
slow or oversized state degrades to "emits nothing" rather than blocking
you. Lower `ASK_JEV_STATE_CHARS` if you want snappier gates at the cost of
less context. Every call logs the size in characters of each section as
`state_sizes` — never the content — so the budget can be tuned from
`bin/jev.mjs stats` without exposing anything.

Same fail-open rules as everywhere else: no API key, an API error, or a
timeout means the gate is silent — never a blocker.

</details>

### 4. Autonomy

`ASK_JEV_AUTONOMY` controls how far the [automatic gates](#3-automatic-gates)
act instead of asking you — **`full` is the default**; set it to `safe` to
go back to the pre-autonomy behavior (the gates never proceed past a question
or a stop on their own). **It does not affect `AskUserQuestion`:** that is
advice-only in both modes — Jev recommends, you answer.

One guardrail never turns off, in either mode: a `destructive` boolean — see
["what counts as destructive"](#3-automatic-gates) — and `p ≥ 0.6` always
hands the decision to you, full autonomy or not.

What changes in `full`:

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
- **`permission` gate** — the allow threshold is `ASK_JEV_ALLOW_THRESHOLD`
  (default `0.8` in `full`, `0.9` in `safe`) instead of a fixed `0.9`; more
  importantly, `destructive` is now the hard floor by itself. In full
  autonomy, anything Jev rates non-destructive (`< 0.3`) proceeds — `safe`
  no longer has to clear the threshold too; `0.3–0.6` still asks; `≥ 0.6`
  always asks.

Every gate decision is still logged with the same `label` +
`confidence` + `reason` shape as everything else — nothing here is silent,
it's just no longer routed through you.

## Configuration

All optional — sensible defaults out of the box.

| Variable | Default | |
|---|---|---|
| `TYPESAFE_API_KEY` | reads `~/.claude/ask-jev.key` | your key from [console.typesafe.ai/keys](https://console.typesafe.ai/keys) |
| `ASK_JEV_API_KEY` | — | overrides every other key variable, checked first |
| `AI_GATEWAY_API_KEY` | — | deprecated: legacy Vercel AI Gateway key, only a fallback |
| `ASK_JEV_PROVIDER` | inferred from the key | `typesafe` or `vercel`; a `vck_` key infers `vercel`, anything else `typesafe` |
| `ASK_JEV_ASK_THRESHOLD` | `0.8` | the "strong" line for `AskUserQuestion` advice (`Jev đề xuất` at or above it, `Jev nghiêng về` below) and the confidence at which Claude may act on a CLI answer |
| `ASK_JEV_ADVICE_CHANNEL` | `annotate` | how `AskUserQuestion` advice is shown: `annotate` (appended to the question and recommended option via `updatedInput`, plus a `systemMessage`) or `message` (`systemMessage` only — visible after the dialog closes); anything else means `annotate` |
| `ASK_JEV_REMIND` | (on) | set to `0` to stop the per-turn "ask Jev" reminder |
| `ASK_JEV_GATES` | `permission,stop,bash,prompt` | comma list of enabled [automatic gates](#3-automatic-gates); set but empty (`ASK_JEV_GATES=`) disables all |
| `ASK_JEV_STATE_CHARS` | `70000` | max characters of context sent to Jev per gate call — lower for faster/cheaper gates |
| `ASK_JEV_AUTONOMY` | `full` | [autonomy mode](#4-autonomy); set to `safe` so the gates never proceed on their own; no effect on `AskUserQuestion` advice |
| `ASK_JEV_ALLOW_THRESHOLD` | `0.8` full / `0.9` safe | `permission` gate's auto-allow threshold |
| `ASK_JEV_MODEL` | `jev-latest` (`typesafe-ai/jev` on `vercel`) | which model Jev evaluation runs against |
| `ASK_JEV_LOG_FILE` | `~/.claude/ask-jev.log` | where the [usage log](#usage-analytics) is written |
| `ASK_JEV_LOG` | (on) | set to `0` to write no log at all |
| `ASK_JEV_API_URL` | `https://api.typesafe.ai/v1/systemone` (Vercel's endpoint on `vercel`) | only needed for a custom endpoint; `ASK_JEV_GATEWAY_URL` is still read as an alias |

`JEV_*` names still work but are deprecated.

The legacy key path `~/.claude/jev-ask.key` (from before the plugin was
renamed) is still read as a fallback, so nothing breaks if you set it up
under the old name.

## Usage analytics

Every API call and every decision — a gate, a piece of `AskUserQuestion`
advice, your own answer, or a direct CLI call to `bin/jev.mjs` — is appended as
one JSON line to `~/.claude/ask-jev.log` (override the path with
`ASK_JEV_LOG_FILE`, disable entirely with `ASK_JEV_LOG=0`). Every line carries a
unique `event_id`.

**The log is private, but it is not free of your words.** It does not hold the
`state` sent to Jev or the session transcript, but it does hold short excerpts
of what you and Claude said — listed below. Treat it like shell history.
Control, zero-width and bidirectional-override characters are scrubbed from
every string before a row is written, and `jev stats` strips them again when it
prints (so old rows and hostile text can't inject terminal escapes).

<details>
<summary>What the log stores, field by field</summary>

**File.** Created with mode `0600`; an existing log that is more open than
that is tightened to `0600` the first time a process writes to it. The
billing-note marker files (`.ask-jev-billing-<hash of session id>`, empty,
`0600`) live next to the log, or in `ASK_JEV_STATE_DIR` if set.

**Every row (schema 2)** is stamped with `schema`, `version`, `invocation_id`,
`session_id`, `autonomy`, `threshold`, `source` (`hook` / `paseo` / `cli`),
`repo` (the git remote URL with credentials, query and fragment stripped) and
`agent` (the Paseo agent id, when there is one).

**Row kinds**

| `kind` | What it records |
|---|---|
| `call` | one request to Jev: status, latency, attempts, provider/model, the size in characters of each `state` section (`state_sizes` — sizes only) |
| `decision` | a gate decision, or for `gate:"ask"` (`mode:"advisory"`) the outcome `advised` or `advice_unavailable` per question |
| `provider_error` | a failed Jev call: error class, HTTP status, redacted error text, whether the billing note was shown |
| `outcome` | what you answered an `AskUserQuestion` with, next to what Jev recommended (`agreement`: `agree` / `disagree` / `partial` / `free_text` / `no_advice` / `unparsed`) |
| `standdown` | the Claude Code hook stepping aside because Paseo is advising (`diagnostic` for related Paseo events) |
| `user_choice` | legacy rows from before schema 2; still read for past choices |

**Text that is stored** (one central cap, applied to every row before it is written):

| Field | Holds | Cap |
|---|---|---|
| `question` / `question_text` | see the next table; always the **original** question, even when the annotated one was shown | 300 characters |
| `options`, `chosen`, `recommended` | option labels, your selection, Jev's pick — each list entry capped separately, at most 50 entries | 300 each |
| `advice_text` | the advice line you were shown | 300 |
| `reason` | the matched criterion, or for advice the option's description + grounded tag | 160 |
| `question_name` | the CLI question's name | 120 |
| `warnings` | CLI validation flags (`class`, `path`, `message`), at most 20 | 300 per string |
| `error` / `message` | the provider's error text, with keys, tokens and URL credentials redacted | 200 |
| `cwd` | on `outcome` rows, the working directory | — |

`question` is where your own words can end up. By row:

| Row | `question` contains |
|---|---|
| `AskUserQuestion` advice / `outcome` | the question text Claude asked you; `chosen` is the option you picked **or the free text you typed** for "Other" |
| `permission` gate | the Bash command about to run, or `<tool> <file path>` for other tools |
| `bash` gate | the Bash command that ran (not its output) |
| `prompt` gate | **the prompt you submitted** (only prompts the gate judges: 12+ characters, not starting with `/`) |
| `stop` gate | Claude's final message of the turn |
| CLI (`gate:"cli"`) | the question Claude wrote for Jev; `options` are the criteria names |

Because those fields are free text, a command or prompt containing a secret
will be logged as typed (up to the cap). Only the provider **error** text is
redacted. If that matters, set `ASK_JEV_LOG=0`.

**Not stored:** the `state` payload, the transcript, CLAUDE.md / memory
contents, command output, and the API key.

**The log is also read back.** Your past `outcome` rows feed `user_past_choices`
and recent gate decisions feed `history` in later requests, so `question` /
`chosen` text from one session (and one project) can be sent to Jev in another.
Delete the file to clear that memory.

</details>

Inspect it with:

```
node ~/.claude/plugins/marketplaces/ask-jev/bin/jev.mjs stats
```

<details>
<summary>Sample output and what each line means</summary>

```
Calls: 19 (ok 18, error 1)  error rate 5.3%
Latency: avg 512ms, p95 910ms
Human answers: 8   Agreement with Jev: 71.4% (5 of 7 compared; disagree 1, partial 1)
Advice on AskUserQuestion: 9 questions, advised 7 (strong 5, weak 2), unavailable 2
Positive outcomes: 78.9%  Fallbacks: 15.8%
  (CLI rows: positive = a strong result, confidence at or above the threshold; the log only observes the result, not whether the agent acted on it)

By entry point:
  entry point    decisions  calls  errors  error rate
  hook                  16     16       1        6.3%
  paseo                  2      2       0        0.0%
  cli                    1      1       0        0.0%

Stand-downs (not decisions, not errors): 3  paseo 3
Provider errors: 1  server 1

Decisions by outcome:
  advised                7   36.8%
  allow                  4   21.1%
  success                3   15.8%
  advice_unavailable     2   10.5%
  ask                    1    5.3%
  tests_failed           1    5.3%
  true                   1    5.3%

By gate:
  ask          calls    9  positive  77.8%  advised 7, advice_unavailable 2
  permission   calls    5  positive  80.0%  allow 4, ask 1
  bash         calls    4  positive  75.0%  success 3, tests_failed 1
  cli          calls    1  positive 100.0%  true 1

Recent decisions:
  2026-09-22T10:03:11.000Z  advised            Is this a bug or a feature?    bug (0.91)
  2026-09-22T10:02:47.000Z  allow              rm dist/old-build.js           safe (0.97)
```

The numbers are illustrative. Narrow the window with `--last N` or `--since 7d|24h`, or add `--json` to get the raw aggregates instead of the text report.

- **Human answers** — every answer you gave an `AskUserQuestion` (an `outcome` row, or a legacy `user_choice`), whether or not Jev had advised.
- **Agreement with Jev** — of the answers where Jev's recommendation was shown, the share that matched it exactly (`agree`); `partial` is a `multiSelect` answer that overlapped. Free-text and un-advised answers are not compared.
- **By entry point** — decisions, Jev calls, call errors and the error rate per entry point (`hook`, `paseo`, `cli`). CLI decisions count in the totals.
- **Stand-downs** are listed separately: they are neither decisions nor errors.
- **Positive** means something different per gate (an `ask` question Jev advised on, a `permission` decision Jev auto-allowed, a `bash` run Jev judged `success`, …). **For the CLI it means a strong result — confidence at or above the threshold — not proof that the agent acted on it.** "Fallbacks" counts questions where no advice was produced, `permission` gates that forced an `ask`, and CLI results below the threshold.

</details>

**Note:** `${CLAUDE_PLUGIN_ROOT}` is available inside Claude Code hooks/skills; for manual CLI calls from your terminal, use `~/.claude/plugins/marketplaces/ask-jev/bin/jev.mjs` or the `jev` alias.

### In Paseo

This repo ships a `paseo.json` with two workspace scripts: `jev:stats` (runs
the report above) and `jev:log` (`tail -f` on the log file). Open them from
Paseo's scripts panel to view usage without leaving the app.

For a live dashboard instead of a script, install the
[Paseo plugin](paseo-plugin/README.md) — a workspace panel with stat tiles,
a gate filter alongside the outcome breakdown, and a live-updating decisions
table (Time, Gate, Outcome, Question/Subject, Answer, Reason). Click a row
for the full record, and the panel shows "Human answers" and "Agreement with
Jev". The same plugin also advises on `AskUserQuestion` natively
(see [above](#1-advice-on-askuserquestion)) — one install covers both.
Settings → Plugins → paste into "Plugin source" → Install:

```
github:yanmad27/ask-jev:paseo-plugin
```

## Upgrade

### Claude Code

In a terminal, **not** inside a Claude Code session:

```bash
claude plugin update ask-jev@ask-jev
```

(There is no `/plugin update` slash command. Auto-update also picks up new
versions in the background if it's enabled for the marketplace.)

The key file was renamed `jev-ask.key` → `ask-jev.key`; the old name is still
read as a fallback, so there's nothing to migrate. Restart Claude Code after
upgrading — hooks only reload on a fresh session.

### Paseo plugin

`paseo plugin update ask-jev` (fetches latest main, then reload). Then Cmd+R / restart Paseo so the UI loads the new client bundle.

## Contributing

Developing the plugin locally? Point the marketplace at your working copy
instead of GitHub, so edits apply immediately with no push-then-update cycle:

```
/plugin marketplace add ~/workspace/ask-jev
```

Commits follow [Conventional Commits](https://www.conventionalcommits.org)
(`feat:`/`fix:`/`docs:`…) — release-please opens a release PR that bumps
`plugin.json` and tags on merge, so there's no manual tagging.

Editing `lib/*.mjs`? The [Paseo plugin](paseo-plugin/README.md) reuses the
same policy from a vendored, byte-identical copy under `paseo-plugin/shared/`
(Paseo stages only `paseo-plugin/`, so it can't read `../lib/` directly). Run
`./scripts/sync-paseo-shared.sh` after editing `lib/` — CI enforces this with
`scripts/sync-paseo-shared.sh --check` and fails the build if the two drift.

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

**No npm dependencies.** Just Node's `fetch` and `fs`, calling the
Jev API directly. Clone it and it runs — no `npm install`, no
`node_modules`.

**The `AskUserQuestion` hook only adds information.** It never returns
`permissionDecision: "deny"` or `"allow"`, and never puts `answers` in
`updatedInput`. The default `annotate` channel returns
`permissionDecision: "ask"` with the annotated questions (which still asks
you) plus a top-level `systemMessage`; the opt-in `message` channel emits only
the `systemMessage`. Any internal error leaves the question exactly as Claude
wrote it.

**What the `PostToolUse` hook reads back.** Claude Code (2.1.284+) hands it an
object `tool_response` of the form `{questions, answers, annotations}`, with
`answers` keyed by question text; older builds used a text response, which is
still parsed. For each question it writes an `outcome` row with `recommended`,
`chosen` and `agreement` (`agree` / `disagree` / `partial` / `free_text` /
`unparsed`, or `no_advice` when no advice had been shown). Annotated and
original question text are both accepted as keys; the row stores the original.

**Why there's a `SessionStart` hook too.** Claude Code currently doesn't run
a plugin's own `PreToolUse` hooks at all
([anthropics/claude-code#36397](https://github.com/anthropics/claude-code/issues/36397))
— only `SessionStart` reliably fires from a plugin. So `hooks/self-register.mjs`
runs on every `SessionStart` and writes the `PreToolUse` entry directly into
your `~/.claude/settings.json`, where hooks are known to work — and keeps the
path current across plugin updates. It only ever touches its own entry and
leaves the rest of your `settings.json` alone. Once upstream fixes that bug,
this becomes a harmless duplicate — worst case, one extra API call.

**Context** is the structured `state` described under "What Jev is shown" in
[Automatic gates](#3-automatic-gates), not a fixed window of turns: capped at
70,000 characters by default (`ASK_JEV_STATE_CHARS`), built from the last 5
messages you typed (≤3,000 characters each), conversation turns (≤4,000 each,
subagent and machine-generated turns dropped), CLAUDE.md and memory, the git
diff, and your past choices across projects. The transcript is read from its
last 2 MB only.

</details>
