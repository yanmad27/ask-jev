---
description: "`stats` reports zero counts instead of crashing on an empty (but existing) log file."
tags: [cli]
allowed_tools: [Skill, Bash]
runs: 1
expected_outcome: 'prints "Calls: 0" with no errors'
---

First invoke the ask-jev skill just to learn the absolute path to this plugin's
`bin/jev.mjs` (you don't need it for anything else here). Then, using that absolute path
in place of `<jev.mjs>`, run this exact command and report its full stdout verbatim:

```
: > tmp-eval-empty.log && ASK_JEV_LOG_FILE=./tmp-eval-empty.log node <jev.mjs> stats
```
