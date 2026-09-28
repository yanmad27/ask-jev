---
description: A deterministic, checkable fact — verify it yourself with a read-only command before asking Jev or the user, and carry the verbatim result into Jev's state.
tags: [behavior]
allowed_tools: [Skill, Bash]
expected_outcome: runs a read-only check first, then uses its exact output as state when calling ask-jev
---

Someone on the team claims the evals workflow file at `.github/workflows/evals.yml`
doesn't exist in this repo, so the eval suite can't possibly be running in CI. Don't take
their word for it and don't ask me — check it yourself with a read-only command first.
Then use the ask-jev skill to judge whether their claim holds up, using what you actually
found as `state`.
