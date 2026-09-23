---
description: The CLI rejects a well-formed JSON with the wrong shape (the chat-style payload Sonnet 5 invented) with one line naming the expected shape, never a TypeError.
tags: [cli]
allowed_tools: [Skill, Bash]
runs: 1
expected_outcome: 'exits non-zero with a single "jev: input must be {"state" ... got keys: task, context, question" line on stderr'
---

First invoke the ask-jev skill just to learn the absolute path to this plugin's
`bin/jev.mjs` (you don't need it for anything else here). Then, using that absolute path
in place of `<jev.mjs>`, run this exact command and report its exit code and full
stdout/stderr verbatim, nothing else:

```
printf '{"task": "classify a ticket", "context": "app crashes", "question": "bug or feature?"}' > fixture.json
node <jev.mjs> fixture.json; echo "EXIT:$?"
```
