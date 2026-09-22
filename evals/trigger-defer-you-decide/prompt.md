---
description: User delegates a technical choice ("tùy bạn") instead of stating a preference — still Jev's call, not an invented preference.
tags: [trigger, positive]
allowed_tools: [Skill, AskUserQuestion, Bash, Write]
expected_outcome: invokes the ask-jev skill
---

I'm adding a cache in front of the gateway calls. We could either (a) cache in-memory per
process, or (b) cache to a file under ~/.claude/. This repo already writes
~/.claude/ask-jev.log for the call log and reads ~/.claude/ask-jev.key for the API key —
tùy bạn, cứ chọn giúp tôi cái nào hợp lý hơn.
