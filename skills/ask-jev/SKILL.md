---
name: ask-jev
description: Use whenever you are about to make a judgement call that isn't yours to invent — classify something, pick between a fixed set of options, answer a yes/no question, or rate something on a scale — and the answer follows from context you already have. Not for personal taste, style choices, or irreversible actions; those go to the user.
---

# Ask Jev

Jev (typesafe.ai) is a small, fast evaluation model: given evidence and a
definition of what each answer means, it returns a calibrated probability —
not text. Consult it instead of silently deciding or interrupting the user.

## When to ask

Ask Jev when:
- classifying content ("is this a bug report or a feature request")
- picking between a fixed set of options where the right one follows from
  evidence already in hand
- a yes/no check with an observable answer ("does this diff touch auth code")

Go straight to the user instead when the choice is personal taste, style, or
irreversible (delete, send, publish, spend money). No evidence yet? Go get
it first — Jev doesn't research, only judges what you hand it.

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

## Delegation: deciding as the user

When the user defers a choice ("hỏi Jev", "tùy anh/chị", "làm đi", "you
decide"), ask Jev **which option the user would choose** — never what their
reply literally says. Real regression: asking "what does the user's reply
say?" with an `undetermined` option whose example matched the reply verbatim
scored `undetermined=1.00` — useless. Re-asked as "acting on the user's
behalf, which option should be taken?", real options only plus a separate
`confident` boolean, it scored `merge_now=0.98, confident=0.66` — usable.

Never add an `undetermined`/`unsure`/`other` bucket — criteria are only the
real options. Add a separate boolean `confident` ("enough evidence to decide
without the user? reversible/cosmetic needs less").

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

Choice — same shape, `criteria` keyed by option name instead of `true`/`false`:
`"category": { "type": "choice", "criteria": { "bug": { "what": "...", "not_for": "feature_request, question", "examples": [...] }, "feature_request": {...}, "question": {...} } }`.

## How to call it

```
echo '<json above>' | node "${CLAUDE_PLUGIN_ROOT}/bin/jev.mjs"
```

Prints the raw `answers` object to stdout, or exits non-zero with a one-line
stderr message (no key, malformed input, gateway error, timeout).

## Reading the result

- `choice`: `{ choice: "bug", probabilities: { bug: 0.94, ... }, confidence: 0.9 }`.
- `boolean`: `{ probability: 0.97, confidence: 0.95 }` — probability of "true".
- `confidence` summarizes how concentrated the distribution is, not
  correctness — threshold on it (reuse `JEV_ASK_THRESHOLD`, default `0.8`);
  below it, ask the user or gather more evidence instead of acting.

## Anti-patterns

- A criterion that's just the label ("Yes", "bug") — nothing to judge against.
- Two options whose definitions overlap or don't name each other in `not_for`.
- Summarizing evidence into `state` instead of pasting it verbatim.
- Bundling several independent judgements into one `question`.
- An `undetermined`/`unsure`/`other` bucket instead of asking what the user
  would pick (see Delegation).

To see how often Jev is actually being consulted: `node "${CLAUDE_PLUGIN_ROOT}/bin/jev.mjs" stats`.
