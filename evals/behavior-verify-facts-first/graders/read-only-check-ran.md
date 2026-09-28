---
type: regex
target: trace
match: contains
---
ls .github/workflows|test -f .github/workflows/evals\.yml|find .github|git ls-files.*evals\.yml|cat .github/workflows/evals\.yml
