---
description: The CLI rejects malformed JSON input with a single clear error line, never a stack trace.
tags: [cli]
allowed_tools: [Skill, Bash]
runs: 1
expected_outcome: 'exits non-zero with a single "jev: input is not valid JSON" line on stderr'
---

First invoke the ask-jev skill just to learn the absolute path to this plugin's
`bin/jev.mjs` (you don't need it for anything else here). Then, using that absolute path
in place of `<jev.mjs>`, run this exact command and report its exit code and full
stdout/stderr verbatim, nothing else:

```
printf '{"state": {"ticket": "broken' > fixture.json
node <jev.mjs> fixture.json; echo "EXIT:$?"
```
