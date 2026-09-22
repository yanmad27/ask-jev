---
description: A yes/no check with an observable answer in a pasted diff.
tags: [trigger, positive]
allowed_tools: [Skill, AskUserQuestion, Bash, Write]
expected_outcome: invokes the ask-jev skill
---

Here's the diff for this PR:

```diff
--- a/lib/context.mjs
+++ b/lib/context.mjs
@@ -1,4 +1,6 @@
-export function truncate(text) {
+export function truncate(text, cap = 4000) {
+  if (text.length <= cap) return text;
+  return text.slice(0, cap) + '...';
 }
```

Does this diff touch authentication or session-token code?
