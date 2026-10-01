---
name: ask-jev
description: Use whenever you are about to make an internal judgement call of your own — choose a model/tier, classify content, pick between fixed options, answer a yes/no on evidence — and the answer follows from context you already have. Jev advises; the user decides: anything the user would decide (taste, push/PR/merge/deploy, any external effect) goes through AskUserQuestion, never this CLI.
---

# Ask Jev

Jev (typesafe.ai) is a small, fast evaluation model: given evidence and a
definition of what each answer means, it returns a calibrated probability —
not text. **Jev advises; the user decides.** This CLI is for your own
internal judgements only; decisions that belong to the user go through
AskUserQuestion, where Jev attaches its advice and the user chooses.

## Verify first

If a fact can be checked with a read-only command or tool — CI status, an HTTP
status code, whether a package is public, file contents, git state — check it
yourself before asking Jev or the user, and put the verbatim result in `state`.
Never ask anyone "did you do X?" when X is checkable. Real regression: an
agent asked "did you make the GHCR package public?"; Jev picked "changed it
now, recheck", but the package was still private (403 on an anonymous pull) —
a plain anonymous pull would have answered it directly, no question needed.

## When to use the CLI

The CLI is for agent-internal judgements only: model/tier choice and internal classification.
Use it when the right answer follows from evidence already in
hand:
- choosing a model or tier for a subtask ("haiku or sonnet for this
  extraction?") from the task text and its constraints
- classifying content ("is this a bug report or a feature request", "is this
  log line an error or a warning")
- a yes/no check with an observable answer ("does this diff touch auth code")

How to act on the result:
- confidence >= the threshold (`ASK_JEV_ASK_THRESHOLD`, default `0.8`): you may
  act on it, and you must print `Jev chose "X" (0.93)`.
- below the threshold: state your own manual choice as the fallback, say it is
  your choice, and proceed with that.

## Never via the CLI

Anything the user would decide goes through AskUserQuestion, where Jev
attaches advice and the user decides — never through this CLI:
- taste, style, tone, naming, wording, "which option would the user pick"
- push, force-push, open/submit/close a PR, merge, deploy, release, publish
- anything with an external effect: send/post/email/message, upload, invite,
  purchase, delete, spend
- judging your own output ("is my fix correct?") — verify it yourself
- facts a read-only command can check — run it and use the verbatim output

The CLI enforces this: it rejects (exit 2, no Jev call) state that is not
evidence — your own description of the user, a taste question without the
user's own words, an action the user decides, a judgement of your own output —
and warns on checkable facts asked without command output and on evidence that
repeats the question. Never put your own description of the user in `state`;
only raw evidence: their messages, their files, their past decisions.

## How to build a good request

One JSON object: `{ state, questions }`.

- **state** — the evidence, verbatim. Paste the actual text/diff/message
  being judged, never a summary. Use a plain object with descriptive field
  names when there's more than one part (`{ diff, commitMessage }`, not
  `{ x, y }`).
- **questions** — a map of question name → question. One coherent judgement
  per question; several independent judgements go in the same call as
  separate entries, not chained calls and not one combined question.
- **instructions** — `{ question, focus }`. `question` is the complete
  judgement in one sentence; `focus` narrows what to weigh or ignore.
  Reference state fields with backticks, e.g. `` `diff` ``.
- **criteria** — what each answer means, deciding whether the probability is
  worth anything:
  - `choice` — one entry per option: `{ what, not_for, examples }`. `what`
    defines it, `not_for` names siblings it must not be confused with,
    `examples` is 1–3 concrete instances.
  - `boolean` ("noul" in typesafe.ai's docs) — `{ true: "...", false: "..." }`,
    each a full definition, not just the word.

Every definition must be **observable** (checkable directly against `state`,
not inferred) and **mutually exclusive** (no other option's definition could
also be true at once).

## Writing criteria

Never add an `undetermined`/`unsure`/`other` bucket — criteria are only the
real options. Real regression: a bucket whose example matched the evidence
verbatim scored `undetermined=1.00`, useless. When a pick needs a "is this
confident enough" signal, add a separate `confident` boolean.

## Examples

Yes/no:

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

Tier choice (agent-internal):

```json
{
  "state": { "task": "Extract the invoice number and total from 40 short plain-text receipts." },
  "questions": {
    "tier": {
      "type": "choice",
      "instructions": { "question": "Which model tier suffices for `task`?" },
      "criteria": {
        "haiku": { "what": "Mechanical extraction or formatting with a fixed output shape", "not_for": "sonnet", "examples": ["pull fields from receipts"] },
        "sonnet": { "what": "Multi-step reasoning, code changes, or ambiguous inputs", "not_for": "haiku", "examples": ["refactor a module"] }
      }
    }
  }
}
```

Choice — same shape, `criteria` keyed by option name instead of `true`/`false`:
`"category": { "type": "choice", "criteria": { "bug": { "what": "...", "not_for": "feature_request, question", "examples": [...] }, "feature_request": {...}, "question": {...} } }`.

## How to call it

```
echo '<json above>' | node "${CLAUDE_PLUGIN_ROOT}/bin/jev.mjs"
```

Prints the raw `answers` object to stdout. Exit 1: usage or provider failure
(no key, malformed input, API error, timeout). Exit 2: rejected as not
evidence (see "Never via the CLI"); no provider call was made, and stderr
names the class and what to do instead. Warnings go to stderr and into the log
row; the call still proceeds.

## Reading the result

- `choice`: `{ choice: "bug", probabilities: { bug: 0.94, ... }, confidence: 0.9 }`.
- `boolean`: `{ probability: 0.97, confidence: 0.95 }` — probability of "true".
- `confidence` summarizes how concentrated the distribution is, not
  correctness — threshold on it (reuse `ASK_JEV_ASK_THRESHOLD`, default `0.8`);
  below it, make and state your own manual choice instead of acting on Jev's.

## Report the choice

Every time Jev decides something, tell the user in one line so they see what
happened without being asked: `Jev chose "X" (0.93)` (option, then confidence
in parentheses). For CLI calls you write this line yourself after reading
`answers`; hooks already print it for you.

## Anti-patterns

- A criterion that's just the label ("Yes", "bug") — nothing to judge against.
- Two options whose definitions overlap or don't name each other in `not_for`.
- Summarizing evidence into `state` instead of pasting it verbatim.
- Bundling several independent judgements into one `question`.
- An `undetermined`/`unsure`/`other` bucket.
- Sending a user decision (taste, push/PR/merge/deploy, external effect) here
  instead of AskUserQuestion.
- Describing the user in `state` instead of quoting them.

To see how often Jev is actually being consulted: `node "${CLAUDE_PLUGIN_ROOT}/bin/jev.mjs" stats`.
