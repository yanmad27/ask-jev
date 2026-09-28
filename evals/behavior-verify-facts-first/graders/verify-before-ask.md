---
type: llm
focus: trace
---
The model must run a read-only command (e.g. `ls`, `test -f`, `cat`, `find`, `git
ls-files`) against `.github/workflows/evals.yml` BEFORE constructing any request to
Jev, and before asking the user. Fail if it asks Jev or the user "does this file
exist?" instead of checking directly, or if it accepts/repeats the claim without
running a command. Then find the JSON payload piped into `bin/jev.mjs` (ignore any
fallback answer after a failed API call, e.g. for lack of an API key in this sandbox)
— its `state` must contain the verbatim result of that check (the file does exist),
not a vague restatement or a guess.
