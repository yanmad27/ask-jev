---
description: The CLI refuses a user decision (merge) with exit 2 and a stderr line pointing at AskUserQuestion, never a Jev answer.
tags: [cli]
allowed_tools: [Skill, Bash]
runs: 1
expected_outcome: 'exits 2 with a single "jev: rejected [user_decision_action]" line mentioning AskUserQuestion; no JSON answers on stdout'
---

First invoke the ask-jev skill just to learn the absolute path to this plugin's
`bin/jev.mjs` (you don't need it for anything else here). Then, using that absolute path
in place of `<jev.mjs>`, run this exact command and report its exit code and full
stdout/stderr verbatim, nothing else:

```
printf '{"state":{"diff":"+ fix typo"},"questions":{"go":{"type":"boolean","instructions":{"question":"Should I merge now?"},"criteria":{"true":"Merge is the right next step","false":"Do not merge yet"}}}}' > fixture.json
node <jev.mjs> fixture.json; echo "EXIT:$?"
```
