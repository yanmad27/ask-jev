---
description: "`stats` prints a friendly message instead of crashing when no log file exists yet."
tags: [cli]
allowed_tools: [Skill, Bash]
runs: 1
expected_outcome: 'prints "no log yet at ..." and exits 0'
---

First invoke the ask-jev skill just to learn the absolute path to this plugin's
`bin/jev.mjs` (you don't need it for anything else here). Then, using that absolute path
in place of `<jev.mjs>`, run this exact command and report its full stdout verbatim:

```
JEV_LOG_FILE=./tmp-eval-missing.log node <jev.mjs> stats
```
